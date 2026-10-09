// Phase 2: webcam (PLAN.md 8, 9.2, 18.2). Chromium runs with a fake camera and auto-granted access.
import { test, expect } from '@playwright/test';
import {
  gotoApp, watchPage, loadFixture, canvasStats, renderCount, captureDownload, inspectMedia, settle,
} from './helpers.js';

test.use({
  // two fake cameras, so the picker can be tested
  launchOptions: { args: ['--use-fake-device-for-media-stream=device-count=2', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera', 'clipboard-read', 'clipboard-write'],
});

const openCamera = async (page) => {
  await page.click('#dropzone [data-action="camera"]');
  await page.waitForSelector('body[data-view="studio"]');
  await page.waitForFunction(() => document.getElementById('transport').dataset.kind === 'webcam');
  await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.frame || 0) > 2);
};

test.describe('webcam', () => {
  test('the camera button opens the live picture, which renders as frames arrive', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await expect(page.locator('#dropzone [data-action="camera"]')).toBeVisible();
    await openCamera(page);
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText('Camera');
    await expect(page.locator('#src-dims')).toContainText('Camera');
    await expect(page.locator('#tp-record')).toBeVisible();
    await expect(page.locator('#tp-scrub')).toBeHidden(); // a live picture has no timeline
    const n = await renderCount(page);
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b + 8, n);
    expect((await canvasStats(page)).variance).toBeGreaterThan(0.0005);
    // mirror toggles
    await expect(page.locator('#tp-mirror')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#tp-mirror');
    await expect(page.locator('#tp-mirror')).toHaveAttribute('aria-pressed', 'false');
    await guard.assertClean(expect);
  });

  test('leaving the camera stops its tracks (the camera light goes off)', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      window.__tracks = [];
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await gum(c);
        s.getTracks().forEach((t) => window.__tracks.push(t));
        return s;
      };
    });
    await gotoApp(page);
    await openCamera(page);
    expect(await page.evaluate(() => window.__tracks.map((t) => t.readyState))).toEqual(['live']);
    await page.setInputFiles('#file-input', (await import('./helpers.js')).FIXTURE_PNG);
    await page.waitForFunction(() => document.getElementById('transport').hidden);
    expect(await page.evaluate(() => window.__tracks.map((t) => t.readyState))).toEqual(['ended']);
    await loadFixture(page);
    await guard.assertClean(expect);
  });

  test('records the camera to WebM with the record button', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await openCamera(page);
    await page.click('#tp-record');
    await page.waitForSelector('#export-dialog[open]');
    await expect(page.locator('#export-dialog')).toHaveAttribute('data-kind', 'live');
    await expect(page.locator('#vx-start')).toHaveCount(0);
    await expect(page.locator('#vx-audio')).toHaveCount(0);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.selectOption('#vx-fps', '24');
    await page.click('#vx-go');
    await expect(page.locator('#export-dialog')).toHaveCount(0);
    await expect(page.locator('#transport')).toHaveAttribute('data-recording', 'true');
    await expect(page.locator('#tp-record')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(2500);
    await expect(page.locator('#tp-rec-time')).toHaveText(/00:0[1-9]/);
    const file = await captureDownload(page, () => page.click('#tp-record'));
    expect(file.name).toMatch(/\.webm$/);
    expect(file.bytes.length).toBeGreaterThan(3000);
    const info = await inspectMedia(page, file.bytes);
    expect(info.video.height).toBe(480);
    expect(info.duration).toBeGreaterThan(1.5);
    expect(info.duration).toBeLessThan(4.5);
    await expect(page.locator('#transport')).toHaveAttribute('data-recording', 'false');
    await guard.assertClean(expect);
  });

  test('records with the MediaRecorder fallback when WebCodecs is missing', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await page.addInitScript(() => { delete window.VideoEncoder; });
    await gotoApp(page);
    await openCamera(page);
    await page.click('#tp-record');
    await page.waitForSelector('#export-dialog[open]');
    await expect(page.locator('#vx-warn [data-warn="realtime"]')).toBeVisible();
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.click('#vx-go');
    await expect(page.locator('#transport')).toHaveAttribute('data-recording', 'true');
    await page.waitForTimeout(2000);
    const file = await captureDownload(page, () => page.click('#tp-record'));
    expect(file.bytes.length).toBeGreaterThan(2000);
    const info = await inspectMedia(page, file.bytes);
    expect(info.video).not.toBeNull();
    expect(info.duration).toBeGreaterThan(1);
    await guard.assertClean(expect);
  });

  test('changing the source while recording discards the recording and stops the camera', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await openCamera(page);
    await page.click('#tp-record');
    await page.waitForSelector('#export-dialog[open]');
    await page.selectOption('#vx-format', 'webm');
    await page.click('#vx-go');
    await expect(page.locator('#transport')).toHaveAttribute('data-recording', 'true');
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await page.setInputFiles('#file-input', (await import('./helpers.js')).FIXTURE_PNG);
    await page.waitForFunction(() => document.getElementById('transport').hidden);
    await settle(page);
    await page.waitForTimeout(500);
    expect(downloads).toBe(0);
    await guard.assertClean(expect);
  });
});

test.describe('camera errors', () => {
  test('a blocked camera shows an explanation and the app stays usable', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await gotoApp(page);
    await page.click('#dropzone [data-action="camera"]');
    await expect(page.locator('.toast-error')).toContainText(/camera is blocked/i);
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    await loadFixture(page);
    await guard.assertClean(expect);
  });

  test('no camera at all: the message says so', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('none', 'NotFoundError'));
    });
    await gotoApp(page);
    await page.click('#dropzone [data-action="camera"]');
    await expect(page.locator('.toast-error')).toContainText(/no camera/i);
    await guard.assertClean(expect);
  });

  test('without getUserMedia the camera button is not shown', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
    await gotoApp(page);
    await expect(page.locator('#dropzone [data-action="demo"]')).toBeVisible();
    await expect(page.locator('#dropzone [data-action="camera"]')).toHaveCount(0);
    await guard.assertClean(expect);
  });

  test('the Spanish dialog and transport use the Spanish strings', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => localStorage.setItem('horain.lang', 'es'));
    await gotoApp(page);
    await expect(page.locator('#dropzone [data-action="camera"]')).toHaveText('Usar cámara');
    await openCamera(page);
    await expect(page.locator('#tp-record')).toContainText('GRABAR');
    await page.click('#tp-record');
    await page.waitForSelector('#export-dialog[open]');
    await expect(page.locator('#vx-title')).toHaveText('grabar la cámara');
    await expect(page.locator('#vx-go')).toHaveText('Empezar a grabar');
    await page.keyboard.press('Escape');
    await guard.assertClean(expect);
  });
});

test.describe('several cameras', () => {
  test('a picker appears and switching cameras keeps the picture alive and stops the old track', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      window.__tracks = [];
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await gum(c);
        s.getTracks().forEach((t) => window.__tracks.push(t));
        return s;
      };
    });
    await gotoApp(page);
    await openCamera(page);
    const picker = page.locator('#tp-camera');
    await expect(picker).toBeVisible();
    await expect(picker.locator('option')).toHaveCount(2);
    const first = await picker.inputValue();
    const other = await picker.locator('option').evaluateAll((os, f) => os.map((o) => o.value).find((v) => v !== f), first);
    await picker.selectOption(other);
    await page.waitForFunction(() => window.__tracks.length === 2);
    await page.waitForFunction(() => window.__tracks[0].readyState === 'ended');
    expect(await page.evaluate(() => window.__tracks[1].readyState)).toBe('live');
    const n = await renderCount(page);
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b + 5, n);
    await expect(picker).toHaveValue(other);
    await guard.assertClean(expect);
  });
});
