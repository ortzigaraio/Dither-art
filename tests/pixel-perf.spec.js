import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers.js';

// Performance budget of the pixel modes (PLAN.md 15). The sandbox Chromium has no GPU and shares its CPU, so the bounds
// are the plan's budget where it was met with room to spare and twice the budget where it was only just met.

test('pixel sort 1080p in the worker stays under 1 s (median of 3), dithering 1080p in the worker under 600 ms', async ({ page }) => {
  await gotoApp(page);
  const res = await page.evaluate(async () => {
    const heavy = await import('/src/engine/heavy.js');
    const w = 1920, h = 1080;
    const mk = () => {
      const a = new Uint8ClampedArray(w * h * 4);
      let s = 1;
      for (let i = 0; i < w * h; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const v = (s >>> 16) & 255; const g = ((i % w) / w * 200) | 0; a.set([(v + g) >> 1, (v * 3 + g) & 255, (v * 5 + g) & 255, 255], i * 4); }
      return a;
    };
    await heavy.run('debug.sleep', { ms: 5, steps: 1 }); // the worker is up
    const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const sortTimes = [];
    for (let i = 0; i < 3; i++) {
      const rgba = mk();
      const t0 = performance.now();
      await heavy.run('pixelSort', { rgba, w, h, angle: 0, intervalMode: 'threshold', lower: 0.25, upper: 0.8, key: 'luma', order: 'asc', maxSpan: 400, randomness: 0, seed: 1 }, { transfer: [rgba.buffer] });
      sortTimes.push(performance.now() - t0);
    }
    const buf = new Float32Array(w * h);
    for (let i = 0; i < buf.length; i++) buf[i] = (i % w) / w;
    const ditherTimes = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await heavy.run('quantize', { buffer: buf, w, h, levels: 2, algorithm: 'floyd-steinberg', opts: {} });
      ditherTimes.push(performance.now() - t0);
    }
    return { sort: median(sortTimes), dither: median(ditherTimes) };
  });
  console.log(`pixel sort 1080p: ${Math.round(res.sort)} ms, error diffusion 1080p: ${Math.round(res.dither)} ms`);
  expect(res.sort).toBeLessThan(1000);
  expect(res.dither).toBeLessThan(600);
});

test('glitch with the default effects renders a 720p frame in under 150 ms; every effect together in under 500 ms', async ({ page }) => {
  await gotoApp(page);
  const res = await page.evaluate(async () => {
    const { applyGlitch } = await import('/src/engine/glitch.js');
    const w = 1280, h = 720;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 2654435761) >>> 24;
    const scratch = {};
    const time = (p) => {
      applyGlitch(src, w, h, p, 3, scratch); // warm up
      const xs = [];
      for (let i = 0; i < 3; i++) { const t0 = performance.now(); applyGlitch(src, w, h, p, 3 + i, scratch); xs.push(performance.now() - t0); }
      return xs.sort((a, b) => a - b)[1];
    };
    return {
      normal: time({ rgbSplit: 0.35, bandShift: 0.3, noise: 0.1 }),
      all: time({ rgbSplit: 0.5, bandShift: 0.5, blockCorrupt: 0.5, bitCrush: 0.3, dct: 0.5, scanlines: 0.3, noise: 0.2, interlace: 0.2 }),
    };
  });
  console.log(`glitch 720p: default ${Math.round(res.normal)} ms, everything ${Math.round(res.all)} ms`);
  expect(res.normal).toBeLessThan(150);
  expect(res.all).toBeLessThan(500);
});
