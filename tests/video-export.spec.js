// Phase 2: video export (PLAN.md 9.2): WebM through Mediabunny, trim, cancel, warnings, the real-time fallback,
// still images with animated modes. MP4 needs an H.264 encoder: it is skipped (never "passed") where there is none.
import { test, expect } from '@playwright/test';
import {
  gotoApp, watchPage, loadVideo, loadFixture, setControl, captureDownload, inspectMedia, settle, pauseVideo,
} from './helpers.js';

const openDialog = async (page) => {
  await page.locator('#controls [data-export="video"]').click();
  await page.waitForSelector('#export-dialog[open]');
  await page.waitForFunction(() => document.getElementById('vx-go') && !document.getElementById('vx-go').disabled);
};

test.describe('video export dialog', () => {
  test('the button and the dialog offer every option for a video file', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await openDialog(page);
    const dlg = page.locator('#export-dialog');
    await expect(dlg.locator('#vx-format option')).toHaveText(['MP4', 'WebM']);
    await expect(dlg.locator('#vx-fps option')).toHaveCount(4); // original, 24, 30, 60
    await expect(dlg.locator('#vx-quality option')).toHaveCount(4);
    await expect(dlg.locator('#vx-height option')).toHaveCount(4);
    await expect(dlg.locator('#vx-audio')).toBeChecked();
    await expect(dlg.locator('#vx-start')).toHaveValue('0');
    await expect(dlg.locator('#vx-end')).toHaveValue(/^3\.0\d$/); // the clip is 3 s
    await expect(dlg.locator('#vx-duration')).toHaveCount(0); // that one is for pictures
    await expect(dlg.locator('#vx-summary')).toContainText('fps');
    // the container says the clip has sound and is 15 fps
    await expect(dlg.locator('#vx-fps option').first()).toContainText('15 fps');
    // nothing to warn about for a 3 s clip at 720p
    await expect(dlg.locator('#vx-warn li')).toHaveCount(0);
    // Esc closes it
    await page.keyboard.press('Escape');
    await expect(page.locator('#export-dialog')).toHaveCount(0);
    await guard.assertClean(expect);
  });

  test('the 2-minute warning appears for a long video and does not block exporting (the duration is mocked)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await page.evaluate(() => {
      const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
        configurable: true,
        get() { return this.src.startsWith('blob:') ? 300 : real.get.call(this); },
      });
    });
    await openDialog(page);
    const warn = page.locator('#vx-warn [data-warn="long"]');
    await expect(warn).toBeVisible();
    await expect(warn).toContainText('2 minutes');
    await expect(page.locator('#vx-end')).toHaveValue('300');
    await expect(page.locator('#vx-go')).toBeEnabled(); // a warning, never a block
    await expect(page.locator('#vx-summary')).toContainText('05:00');
    // shorten the range below 2 minutes: the warning goes away
    await page.locator('#vx-end').fill('60');
    await expect(warn).toHaveCount(0);
    await page.locator('#vx-end').fill('0');
    await expect(page.locator('#vx-warn [data-warn="trim"]')).toBeVisible();
    await expect(page.locator('#vx-go')).toBeDisabled();
    await page.click('#vx-cancel');
    await expect(page.locator('#export-dialog')).toHaveCount(0);
    await guard.assertClean(expect);
  });

  test('exports WebM with the original audio: right type, size and duration', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await setControl(page, 'cols', 80);
    await openDialog(page);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.selectOption('#vx-quality', 'medium');
    const file = await captureDownload(page, () => page.click('#vx-go'));
    expect(file.name).toMatch(/^dither-ascii-\d{8}-\d{6}\.webm$/);
    expect(file.bytes.length).toBeGreaterThan(5000);
    expect([...file.bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML header
    const info = await inspectMedia(page, file.bytes);
    expect(info.format).toBe('WebM');
    expect(info.duration).toBeGreaterThan(2.7);
    expect(info.duration).toBeLessThan(3.4);
    expect(info.video.height).toBe(480);
    expect(info.video.width % 2).toBe(0);
    expect(info.video.width).toBeGreaterThan(300); // a 4:3-ish ASCII picture
    expect(info.audio).not.toBeNull(); // the 440 Hz tone travelled along
    expect(info.audio.codec).toBe('opus');
    await expect(page.locator('.toast')).toContainText(/Saved dither-ascii-/);
    await expect(page.locator('#export-dialog')).toHaveCount(0);
    await guard.assertClean(expect);
  });

  test('trim start and end cut the exported clip, and audio can be left out', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await setControl(page, 'cols', 60);
    await openDialog(page);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.locator('#vx-start').fill('1');
    await page.locator('#vx-end').fill('2.5');
    await page.locator('#vx-audio').uncheck();
    await expect(page.locator('#vx-summary')).toContainText('00:02'); // 1.5 s, rounded
    const file = await captureDownload(page, () => page.click('#vx-go'));
    const info = await inspectMedia(page, file.bytes);
    expect(info.duration).toBeGreaterThan(1.3);
    expect(info.duration).toBeLessThan(1.8);
    expect(info.audio).toBeNull();
    await guard.assertClean(expect);
  });

  test('the frame rate option resamples the output', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await setControl(page, 'cols', 60);
    await openDialog(page);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.selectOption('#vx-fps', '30');
    const file = await captureDownload(page, () => page.click('#vx-go'));
    const frames = await page.evaluate(async (b64) => {
      const mb = await import('/vendor/mediabunny/1.59.1/mediabunny.min.mjs');
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const input = new mb.Input({ source: new mb.BlobSource(new Blob([arr])), formats: mb.ALL_FORMATS });
      const v = await input.getPrimaryVideoTrack();
      const stats = await v.computePacketStats();
      input.dispose();
      return stats;
    }, file.bytes.toString('base64'));
    expect(frames.averagePacketRate).toBeGreaterThan(27);
    expect(frames.averagePacketRate).toBeLessThan(33);
    await guard.assertClean(expect);
  });

  test('cancelling stops the export at once, saves nothing and leaves the app ready for another', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await setControl(page, 'cols', 600); // slow frames: there is time to cancel
    await openDialog(page);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-fps', '60');
    await page.selectOption('#vx-height', 'original');
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await page.click('#vx-go');
    await expect(page.locator('#vx-progress')).toBeVisible();
    await page.waitForFunction(() => Number(document.getElementById('vx-progress').getAttribute('aria-valuenow')) > 0, null, { timeout: 30_000 });
    const t0 = Date.now();
    await page.click('#vx-cancel-export');
    await expect(page.locator('#export-dialog')).toHaveCount(0, { timeout: 10_000 });
    // the encoder has to drain the frame it is working on (a 2160p VP9 frame takes a while in software)
    expect(Date.now() - t0).toBeLessThan(12_000);
    await expect(page.locator('.toast')).toContainText(/canceled/i);
    await page.waitForTimeout(800);
    expect(downloads).toBe(0);
    // ready again: a new export works (the single-job lock was released)
    await setControl(page, 'cols', 40);
    await openDialog(page);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.locator('#vx-end').fill('0.6');
    const file = await captureDownload(page, () => page.click('#vx-go'));
    expect(file.bytes.length).toBeGreaterThan(1000);
    await guard.assertClean(expect);
  });

  test('MP4 export (H.264)', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    const avc = await page.evaluate(async () => {
      const mb = await import('/vendor/mediabunny/1.59.1/mediabunny.min.mjs');
      return mb.canEncodeVideo('avc', { width: 640, height: 480 });
    });
    test.skip(!avc, 'this Chromium has no H.264 encoder (PLAN.md 13): MP4 export cannot be tested here');
    await loadVideo(page);
    await setControl(page, 'cols', 60);
    await openDialog(page);
    await page.selectOption('#vx-format', 'mp4');
    await page.selectOption('#vx-height', '480');
    const file = await captureDownload(page, () => page.click('#vx-go'));
    expect(file.name).toMatch(/\.mp4$/);
    expect(file.bytes.subarray(4, 8).toString()).toBe('ftyp');
    const info = await inspectMedia(page, file.bytes);
    expect(info.video.codec).toBe('avc');
    expect(info.duration).toBeGreaterThan(2.7);
    expect(info.duration).toBeLessThan(3.4);
    expect(info.audio).not.toBeNull();
    await guard.assertClean(expect);
  });

  test('without an H.264 encoder the MP4 option is disabled and explained', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const avc = await page.evaluate(async () => {
      const mb = await import('/vendor/mediabunny/1.59.1/mediabunny.min.mjs');
      return mb.canEncodeVideo('avc', { width: 640, height: 480 });
    });
    test.skip(avc, 'this browser can encode H.264, so MP4 stays enabled');
    await loadVideo(page);
    await openDialog(page);
    await expect(page.locator('#vx-format option[value="mp4"]')).toBeDisabled();
    await expect(page.locator('#vx-format')).toHaveValue('webm');
    await expect(page.locator('#vx-format-hint')).toContainText('MP4');
    await guard.assertClean(expect);
  });
});

test.describe('still image with an animated mode', () => {
  test('exports frames at i/fps with the frame time, with a duration option', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    // ASCII is a still mode: make it animated for this test and record the time each export frame is rendered at
    await page.evaluate(async () => {
      const ascii = (await import('/src/modes/ascii.js')).default;
      ascii.animated = true;
      window.__times = [];
      const render = ascii.render;
      ascii.render = function (ctx, state) {
        if (ctx.isExport) window.__times.push(ctx.time);
        return render.call(this, ctx, state);
      };
    });
    await loadFixture(page);
    await setControl(page, 'cols', 40);
    await openDialog(page);
    await expect(page.locator('#vx-duration')).toBeVisible();
    await expect(page.locator('#vx-audio')).toHaveCount(0);
    await expect(page.locator('#vx-start')).toHaveCount(0);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.selectOption('#vx-fps', '24');
    await page.locator('#vx-duration').fill('2');
    const file = await captureDownload(page, () => page.click('#vx-go'));
    const info = await inspectMedia(page, file.bytes);
    expect(info.duration).toBeGreaterThan(1.8);
    expect(info.duration).toBeLessThan(2.3);
    expect(info.audio).toBeNull();
    expect(info.video.height).toBe(480);
    const times = await page.evaluate(() => window.__times);
    const exportTimes = times.slice(-48);
    expect(exportTimes.length).toBe(48);
    exportTimes.forEach((tm, i) => expect(tm).toBeCloseTo(i / 24, 5)); // deterministic: the frame time, not the wall clock
    await guard.assertClean(expect);
  });

  test('a still mode on a still picture offers no video export', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    await expect(page.locator('#controls [data-export="png"]')).toBeVisible();
    await expect(page.locator('#controls [data-export="video"]')).toHaveCount(0);
    await guard.assertClean(expect);
  });
});

test.describe('fallback without WebCodecs', () => {
  test('records the video in real time with MediaRecorder, audio included', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await page.addInitScript(() => {
      delete window.VideoEncoder;
      delete window.AudioEncoder;
    });
    await gotoApp(page);
    await loadVideo(page);
    await setControl(page, 'cols', 40);
    await openDialog(page);
    await expect(page.locator('#vx-warn [data-warn="realtime"]')).toBeVisible();
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    const t0 = Date.now();
    const file = await captureDownload(page, () => page.click('#vx-go'), 90_000);
    expect(Date.now() - t0).toBeGreaterThan(2500); // real time: it takes as long as the clip
    expect(file.bytes.length).toBeGreaterThan(3000);
    expect(file.name).toMatch(/\.webm$/);
    const info = await inspectMedia(page, file.bytes);
    expect(info.duration).toBeGreaterThan(2.3);
    expect(info.duration).toBeLessThan(4.5);
    expect(info.video).not.toBeNull();
    expect(info.audio, 'the sound travels through the recorder too').not.toBeNull();
    await expect(page.locator('.toast-warn')).toContainText(/real time/i);
    await guard.assertClean(expect);
  });

  test('can be cancelled too', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => { delete window.VideoEncoder; });
    await gotoApp(page);
    await loadVideo(page);
    await setControl(page, 'cols', 40);
    await openDialog(page);
    await page.selectOption('#vx-format', 'webm');
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await page.click('#vx-go');
    await page.waitForFunction(() => Number(document.getElementById('vx-progress').getAttribute('aria-valuenow')) > 0, null, { timeout: 15_000 });
    await page.click('#vx-cancel-export');
    await expect(page.locator('#export-dialog')).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(600);
    expect(downloads).toBe(0);
    await guard.assertClean(expect);
  });
});
