// Phase 7 logic pass, webcam edge case: a camera unplugged while recording (fake camera, auto-granted access).
import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, captureDownload, inspectMedia } from './helpers.js';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['camera'],
});

test.describe('webcam', () => {
  test('a camera unplugged while recording keeps what was recorded', async ({ page }) => {
    test.setTimeout(120_000);
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
    await page.click('#dropzone [data-action="camera"]');
    await page.waitForFunction(() => document.getElementById('transport').dataset.kind === 'webcam');
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.frame || 0) > 2);
    await page.click('#tp-record');
    await page.waitForSelector('#export-dialog[open]');
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.click('#vx-go');
    await expect(page.locator('#transport')).toHaveAttribute('data-recording', 'true');
    await page.waitForTimeout(1800);
    // unplug: the track ends by itself (stop() does not fire "ended", so dispatch it as the browser would)
    const file = await captureDownload(page, () => page.evaluate(() => {
      const tr = window.__tracks.find((t) => t.kind === 'video');
      tr.stop();
      tr.dispatchEvent(new Event('ended'));
    }));
    expect(file.name).toMatch(/\.webm$/);
    const info = await inspectMedia(page, file.bytes);
    expect(info.duration).toBeGreaterThan(1);
    await expect(page.locator('#toasts')).toContainText(/camera|cámara/i);
    await expect(page.locator('#transport')).toHaveAttribute('data-recording', 'false');
    await guard.assertClean(expect);
  });
});
