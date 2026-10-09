// Phase 2: video files, the transport bar and the render policy (PLAN.md 5.7, 8).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  gotoApp, watchPage, loadVideo, loadFixture, transportState, pauseVideo, canvasStats, renderCount, settle,
  FIXTURE_WEBM, FIXTURE_PNG,
} from './helpers.js';

test.describe('video source and transport', () => {
  test('a video opens in the studio, plays by itself and shows what it is', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await expect(page.locator('#transport')).toBeVisible();
    await expect(page.locator('#transport')).toHaveAttribute('data-kind', 'video');
    await expect(page.locator('[data-group="input"] .src-name')).toHaveText('fixture.webm');
    await expect(page.locator('#src-dims')).toContainText('320×240');
    await expect(page.locator('#src-dims')).toContainText('00:03');
    // playing: the clock moves and new frames are rendered
    const a = await transportState(page);
    const frames = await renderCount(page);
    await page.waitForFunction((t) => Number(document.getElementById('transport').dataset.time) > t + 0.3, a.time);
    expect((await transportState(page)).state).toBe('playing');
    expect(await renderCount(page)).toBeGreaterThan(frames);
    const stats = await canvasStats(page);
    expect(stats.variance).toBeGreaterThan(0.001);
    // the frame rate is measured while playing (the fixture is 15 fps) and shown
    await expect(page.locator('#src-dims')).toContainText(/1[45](\.\d)? fps/);
    await guard.assertClean(expect);
  });

  test('play, pause, scrub, frame step with the buttons and the keyboard', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await pauseVideo(page);
    const paused = await transportState(page);
    await page.waitForTimeout(400);
    expect((await transportState(page)).time).toBe(paused.time); // really stopped

    // scrub to the middle: the picture and the clock follow
    const before = await canvasStats(page);
    await page.locator('#tp-scrub').evaluate((el) => {
      el.value = '500';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => Math.abs(Number(document.getElementById('transport').dataset.time) - 1.5) < 0.12);
    await settle(page);
    const mid = await canvasStats(page);
    expect(mid.hash).not.toBe(before.hash);
    await expect(page.locator('#tp-time')).toContainText('00:01 / 00:03');

    // one frame forward / back. The first step lands on a frame boundary; after that each step is one frame (15 fps = 0.067 s)
    const advance = async (button, dir) => {
      const t = (await transportState(page)).time;
      const h = (await canvasStats(page)).hash;
      await page.click(button);
      await page.waitForFunction((a) => {
        const now = Number(document.getElementById('transport').dataset.time);
        return a[1] > 0 ? now > a[0] + 0.01 : now < a[0] - 0.01;
      }, [t, dir]);
      await settle(page);
      expect((await canvasStats(page)).hash, 'a different frame is drawn').not.toBe(h);
      return (await transportState(page)).time;
    };
    const s1 = await advance('#tp-next', 1);
    const s2 = await advance('#tp-next', 1);
    expect(s2 - s1).toBeGreaterThan(0.04);
    expect(s2 - s1).toBeLessThan(0.1);
    const s3 = await advance('#tp-prev', -1);
    expect(Math.abs(s3 - s1)).toBeLessThan(0.03);

    // arrow keys with the viewer focused step frames while paused (and do not pan)
    await page.locator('#viewer-viewport').focus();
    const tx = await page.evaluate(() => document.getElementById('viewer-world').style.transform);
    await settle(page);
    const k0 = (await transportState(page)).time;
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((t) => Number(document.getElementById('transport').dataset.time) > t + 0.03, k0);
    await settle(page);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction((t) => Number(document.getElementById('transport').dataset.time) < t + 0.03, k0);
    expect(await page.evaluate(() => document.getElementById('viewer-world').style.transform)).toBe(tx);

    // Space plays and pauses
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('transport').dataset.state === 'playing');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('transport').dataset.state === 'paused');
    // frame step is only for a paused video
    await page.click('#tp-play');
    await expect(page.locator('#tp-next')).toBeDisabled();
    await guard.assertClean(expect);
  });

  test('loop, speed and mute act on the video', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await expect(page.locator('#tp-loop')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tp-mute')).toHaveAttribute('aria-pressed', 'true'); // starts muted
    await page.click('#tp-mute');
    await expect(page.locator('#tp-mute')).toHaveAttribute('aria-pressed', 'false');
    await page.click('#tp-mute');
    await page.selectOption('#tp-speed', '2');
    // at 2x the 3 s clip finishes its first lap in about a second and a half
    await page.click('#tp-loop');
    await expect(page.locator('#tp-loop')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#tp-scrub').evaluate((el) => {
      el.value = '700';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('transport').dataset.state === 'paused', null, { timeout: 8000 }); // ended, no loop
    await page.click('#tp-loop');
    await page.click('#tp-play');
    await page.waitForFunction(() => document.getElementById('transport').dataset.state === 'playing');
    await guard.assertClean(expect);
  });

  test('the scheduler renders only when a new frame arrives, a parameter changes, or the tab is hidden', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await pauseVideo(page);
    // paused and untouched: no rendering at all
    const idle = await renderCount(page);
    await page.waitForTimeout(700);
    expect(await renderCount(page)).toBe(idle);
    // a parameter change renders once
    await page.locator('#controls [data-param="brightness"] .ctl-num').fill('130');
    await page.locator('#controls [data-param="brightness"] .ctl-num').press('Enter');
    await page.waitForFunction((n) => Number(document.getElementById('viewer-canvas').dataset.frame) > n, idle);
    await settle(page);
    const afterParam = await renderCount(page);
    await page.waitForTimeout(400);
    expect(await renderCount(page)).toBe(afterParam);
    // playing renders about one frame per video frame (15 fps clip: far fewer than 60 rAF ticks)
    await page.click('#tp-play');
    const p0 = await renderCount(page);
    await page.waitForTimeout(1000);
    const played = (await renderCount(page)) - p0;
    expect(played).toBeGreaterThan(5);
    expect(played).toBeLessThan(25);
    // hidden tab: the video pauses and the loop sleeps; when it comes back playback resumes
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.getElementById('transport').dataset.state === 'paused');
    const h0 = await renderCount(page);
    await page.waitForTimeout(500);
    expect(await renderCount(page)).toBe(h0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => document.getElementById('transport').dataset.state === 'playing');
    await page.waitForFunction((n) => Number(document.getElementById('viewer-canvas').dataset.frame) > n, h0);
    await guard.assertClean(expect);
  });

  test('a truncated video file is rejected with an explanation and the app stays usable', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    // a truncated copy of the real file: the header is fine, the stream is not
    const real = readFileSync(FIXTURE_WEBM);
    await page.setInputFiles('#file-input', { name: 'broken.webm', mimeType: 'video/webm', buffer: real.subarray(0, 120) });
    await expect(page.locator('.toast')).toContainText(/could not open the video/i);
    await expect(page.locator('body')).toHaveAttribute('data-view', 'home');
    await guard.assertClean(expect);
  });

  test('a video longer than 2 minutes warns when it is opened (the duration is mocked)', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
        configurable: true,
        get() { return this.src.startsWith('blob:') ? 300 : real.get.call(this); },
      });
    });
    await gotoApp(page);
    await loadVideo(page);
    await expect(page.locator('.toast-warn')).toContainText(/longer than 2 minutes/i);
    await guard.assertClean(expect);
  });

  test('changing the source releases the video: the object URL is revoked and the decoder is dropped', async ({ page }) => {
    const guard = watchPage(page);
    await page.addInitScript(() => {
      window.__revoked = [];
      window.__created = [];
      window.__videos = [];
      const rev = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (u) => { window.__revoked.push(u); rev(u); };
      const cre = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { const u = cre(b); window.__created.push(u); return u; };
      const mk = document.createElement.bind(document);
      document.createElement = (tag, o) => { const e = mk(tag, o); if (String(tag).toLowerCase() === 'video') window.__videos.push(e); return e; };
    });
    await gotoApp(page);
    await loadVideo(page);
    const url = await page.evaluate(() => window.__videos[0].src);
    expect(url.startsWith('blob:')).toBe(true);
    // open an image instead
    await page.setInputFiles('#file-input', FIXTURE_PNG);
    await page.waitForFunction(() => document.getElementById('transport').hidden);
    const res = await page.evaluate((u) => ({
      revoked: window.__revoked.includes(u),
      src: window.__videos[0].getAttribute('src'),
      paused: window.__videos[0].paused,
    }), url);
    expect(res).toEqual({ revoked: true, src: null, paused: true });
    // and the picture still renders
    await loadFixture(page);
    expect((await canvasStats(page)).variance).toBeGreaterThan(0.001);
    await guard.assertClean(expect);
  });
});
