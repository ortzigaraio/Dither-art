// Phase 3 part B: every pixel mode goes through the same pipeline as video, so each one must render a video source,
// and the ones that move (Glitch with "animate") must be a pure function of the frame time during export.
import { test, expect } from '@playwright/test';
import {
  gotoApp, watchPage, loadVideo, loadFixture, setControl, captureDownload, inspectMedia, canvasStats, renderCount, settle, pauseVideo,
} from './helpers.js';

const PIXEL_MODES = ['dither1bit', 'halftone', 'pixelart', 'led', 'thermal', 'glitch', 'pixelsort'];

async function pick(page, id) {
  const item = page.locator(`#mode-list .mode-item[data-mode-id="${id}"]`);
  const before = await renderCount(page);
  await item.click();
  await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
}

const openDialog = async (page) => {
  await page.locator('#controls [data-export="video"]').click();
  await page.waitForSelector('#export-dialog[open]');
  await page.waitForFunction(() => document.getElementById('vx-go') && !document.getElementById('vx-go').disabled);
};

test('every pixel mode renders a video source: a non-blank canvas, no errors, and video export is offered', async ({ page }) => {
  const guard = watchPage(page);
  await gotoApp(page);
  await loadVideo(page);
  await pauseVideo(page); // a playing video never lets the render loop go quiet
  for (const id of PIXEL_MODES) {
    await pick(page, id);
    await settle(page, 350);
    const stats = await canvasStats(page);
    expect(stats.variance, `${id} canvas is not blank`).toBeGreaterThan(0);
    await expect(page.locator('#chip-error'), `${id} did not fail`).toBeHidden();
    await expect(page.locator('#controls [data-export="video"]'), `${id} offers video`).toHaveCount(1);
  }
  await guard.assertClean(expect);
});

for (const [id, prep] of [
  ['pixelsort', async () => {}], // each frame goes through the heavy worker
  ['dither1bit', async (page) => { // 320x240 work pixels with error diffusion: above the threshold, so every frame goes through the worker
    await setControl(page, 'algorithm', 'floyd-steinberg', 'mode');
    await setControl(page, 'pixelSize', 1, 'mode');
  }],
  ['halftone', async () => {}],
]) {
  test(`${id}: exports a WebM from a video file (all frames rendered at full quality)`, async ({ page }) => {
    test.setTimeout(150_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await pauseVideo(page);
    await pick(page, id);
    await prep(page);
    await settle(page, 350);
    await openDialog(page);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.selectOption('#vx-quality', 'low');
    const file = await captureDownload(page, () => page.click('#vx-go'), 120_000);
    expect(file.name).toMatch(new RegExp(`^dither-${id}-\\d{8}-\\d{6}\\.webm$`));
    expect(file.bytes.length).toBeGreaterThan(3000);
    const info = await inspectMedia(page, file.bytes);
    expect(info.format).toBe('WebM');
    expect(info.duration).toBeGreaterThan(2.6);
    expect(info.duration).toBeLessThan(3.5);
    expect(info.video.height).toBe(480);
    expect(info.audio).not.toBeNull();
    await expect(page.locator('#chip-error')).toBeHidden();
    await guard.assertClean(expect);
  });
}

test('glitch with "animate" on a still picture exports frames that depend only on the frame time (twice the same)', async ({ page }) => {
  test.setTimeout(150_000);
  const guard = watchPage(page);
  await gotoApp(page);
  // record, for every export frame, its time and a hash of the pixels the mode drew
  await page.evaluate(async () => {
    const glitch = (await import('/src/modes/glitch.js')).default;
    window.__frames = [];
    const render = glitch.render;
    glitch.render = function (ctx, state) {
      const meta = render.call(this, ctx, state);
      if (ctx.isExport) {
        const g = ctx.out.canvas.getContext('2d', { willReadFrequently: true });
        const d = g.getImageData(0, 0, ctx.out.canvas.width, ctx.out.canvas.height).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i += 7) h = Math.imul(h ^ d[i], 16777619);
        window.__frames.push({ t: ctx.time, h: h >>> 0 });
      }
      return meta;
    };
  });
  await loadFixture(page);
  await pick(page, 'glitch');
  await settle(page, 350);
  await expect(page.locator('#controls [data-export="video"]')).toHaveCount(0); // not animated yet
  await setControl(page, 'animate', true);
  await setControl(page, 'rate', 4, 'mode');
  const exportOnce = async () => {
    await page.evaluate(() => { window.__frames = []; });
    await openDialog(page);
    await page.selectOption('#vx-format', 'webm');
    await page.selectOption('#vx-height', '480');
    await page.selectOption('#vx-fps', '24');
    await page.locator('#vx-duration').fill('1');
    const file = await captureDownload(page, () => page.click('#vx-go'), 120_000);
    const info = await inspectMedia(page, file.bytes);
    expect(info.duration).toBeGreaterThan(0.8);
    expect(info.duration).toBeLessThan(1.4);
    return page.evaluate(() => window.__frames.slice(-24));
  };
  const a = await exportOnce();
  const b = await exportOnce();
  expect(a.length).toBe(24);
  a.forEach((f, i) => expect(f.t).toBeCloseTo(i / 24, 5)); // the frame time, not the wall clock
  expect(b.map((f) => f.h)).toEqual(a.map((f) => f.h)); // the same pixels in both exports
  // 4 changes per second at 24 fps: 6 frames per tick share their pixels, ticks differ
  const tick = (i) => Math.floor(i / 6);
  for (let i = 1; i < 24; i++) {
    if (tick(i) === tick(i - 1)) expect(a[i].h, `frame ${i} is in the same tick as ${i - 1}`).toBe(a[i - 1].h);
    else expect(a[i].h, `frame ${i} starts a new tick`).not.toBe(a[i - 1].h);
  }
  await guard.assertClean(expect);
});
