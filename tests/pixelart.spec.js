import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode } from './helpers.js';

// Pixel art (PLAN.md 7.9)

const QUADS = [['#d02020', 0, 0, 0.5, 0.5], ['#20c040', 0.5, 0, 0.5, 0.5], ['#2040e0', 0, 0.5, 0.5, 0.5], ['#f0e060', 0.5, 0.5, 0.5, 0.5]];
const HEX = { red: '#d02020', green: '#20c040', blue: '#2040e0', yellow: '#f0e060' };
const BASE = { mode: 'pixelart', width: 480, height: 240 };

test.describe('pixelart: engine pieces', () => {
  test('block average and median of a 2x2 block are computed by hand', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { reduceBlocks } = await import('/src/modes/pixelart.js');
      // a 4x2 picture = two 2x2 blocks; red channel 10,20 / 30,40 and 100,100 / 100,200 (g, b fixed)
      const px = [10, 20, 100, 100, 30, 40, 100, 200];
      const rgba = new Uint8ClampedArray(8 * 4);
      px.forEach((v, i) => { rgba[i * 4] = v; rgba[i * 4 + 1] = 5; rgba[i * 4 + 2] = 250; rgba[i * 4 + 3] = 255; });
      const avg = reduceBlocks(rgba, 4, 2, 2, 2, 1, false);
      const med = reduceBlocks(rgba, 4, 2, 2, 2, 1, true);
      return { avg: Array.from(avg), med: Array.from(med) };
    });
    // block 1: (10+20+30+40)/4 = 25, block 2: (100+100+100+200)/4 = 125
    expect(res.avg).toEqual([25, 5, 250, 255, 125, 5, 250, 255]);
    // sorted [10,20,30,40] -> upper median 30; sorted [100,100,100,200] -> 100
    expect(res.med).toEqual([30, 5, 250, 255, 100, 5, 250, 255]);
  });

  test('stray pixels are merged and the outline sits on the lighter side of a boundary', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { cleanupStray, outlineMask } = await import('/src/modes/pixelart.js');
      const idx = new Uint16Array(9).fill(0);
      idx[4] = 1; // the lonely centre
      const cleaned = Array.from(cleanupStray(idx, 3, 3));
      const edge = Array.from(cleanupStray(new Uint16Array([0, 0, 0, 0, 1, 1, 0, 0, 0]), 3, 3)); // two in a row are not stray
      // 4x1: light(1) light(1) dark(0) dark(0) with lum[0]=0.2, lum[1]=0.8: only the light pixel next to the boundary
      const mask = Array.from(outlineMask(new Uint16Array([1, 1, 0, 0]), [0.2, 0.8], 4, 1));
      return { cleaned, edge, mask };
    });
    expect(res.cleaned).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(res.edge).toEqual([0, 0, 0, 0, 1, 1, 0, 0, 0]);
    expect(res.mask).toEqual([0, 1, 0, 0]);
  });

  test('k-means returns exactly N colours for a rich picture, is deterministic and recovers flat colours', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { kmeansPalette } = await import('/src/engine/kmeans.js');
      const n = 64 * 64;
      const rich = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) { // a smooth, colourful picture with thousands of distinct colours
        const x = i % 64, y = Math.floor(i / 64);
        rich[i * 4] = (x * 4 + (y % 7) * 3) & 255; rich[i * 4 + 1] = (y * 4 + (x % 5) * 5) & 255; rich[i * 4 + 2] = ((x + y) * 2 + (x * y) % 11) & 255; rich[i * 4 + 3] = 255;
      }
      const sizes = {};
      for (const k of [2, 5, 8, 16, 32]) sizes[k] = kmeansPalette(rich, k).length;
      const a = JSON.stringify(kmeansPalette(rich, 8));
      const b = JSON.stringify(kmeansPalette(rich, 8));
      // three flat colours: exactly those three, darkest first
      const flat = new Uint8ClampedArray(30 * 4);
      const cols = [[200, 30, 30], [20, 20, 20], [240, 240, 100]];
      for (let i = 0; i < 30; i++) { const c = cols[i % 3]; flat.set([c[0], c[1], c[2], 255], i * 4); }
      return { sizes, same: a === b, flat3: kmeansPalette(flat, 3), flat8: kmeansPalette(flat, 8) };
    });
    expect(res.sizes).toEqual({ 2: 2, 5: 5, 8: 8, 16: 16, 32: 32 });
    expect(res.same).toBe(true);
    expect(res.flat3).toEqual([[20, 20, 20], [200, 30, 30], [240, 240, 100]]);
    expect(res.flat8).toEqual(res.flat3); // never more colours than the picture has
  });
});

test.describe('pixelart: output', () => {
  test('automatic palette of 4 colours on four flat quadrants reproduces exactly those colours', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const r = await renderMode(page, { ...BASE, rects: QUADS, colors: true, params: { mode: { pixelSize: 8, paletteSource: 'auto', colors: 4 } } });
    expect(r.error).toBeNull();
    expect(r.frames[0].colors).toEqual(Object.values(HEX).sort());
    expect(r.meta.paletteSize).toBe(4);
    expect(r.meta.cols).toBe(60); // 480 / 8
    expect(r.meta.rows).toBe(30);
    await guard.assertClean(expect);
  });

  test('N automatic colours bound the number of distinct colours of a ramp', async ({ page }) => {
    await gotoApp(page);
    const ramp = Array.from({ length: 32 }, (_, i) => [`rgb(${i * 8},${255 - i * 8},${(i * 37) % 255})`, i / 32, 0, 1 / 32, 1]);
    for (const colors of [2, 5, 12]) {
      const r = await renderMode(page, { ...BASE, rects: ramp, colors: true, params: { mode: { pixelSize: 4, paletteSource: 'auto', colors } } });
      expect(r.meta.paletteSize, `palette ${colors}`).toBe(colors);
      expect(r.frames[0].colors.length, `distinct ${colors}`).toBeLessThanOrEqual(colors);
      expect(r.frames[0].colors.length).toBeGreaterThanOrEqual(Math.min(colors, 2));
    }
  });

  test('a preset palette only uses its own colours, with or without dithering', async ({ page }) => {
    await gotoApp(page);
    const ramp = Array.from({ length: 32 }, (_, i) => [`rgb(${i * 8},${i * 8},${i * 8})`, i / 32, 0, 1 / 32, 1]);
    const gb = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'];
    for (const dither of ['none', 'bayer4', 'floyd-steinberg', 'blue-noise']) {
      const r = await renderMode(page, { ...BASE, rects: ramp, colors: true, params: { mode: { pixelSize: 4, paletteSource: 'gameboy', dither } } });
      expect(r.error, dither).toBeNull();
      for (const c of r.frames[0].colors) expect(gb, `${dither} ${c}`).toContain(c);
      expect(r.frames[0].colors.length, dither).toBeGreaterThan(1);
    }
    const custom = await renderMode(page, { ...BASE, rects: ramp, colors: true, params: { mode: { pixelSize: 4, paletteSource: 'custom', customColors: '#102030 #fff0e0' } } });
    expect(custom.frames[0].colors).toEqual(['#102030', '#fff0e0']);
  });

  test('native output scales are exact multiples of the art grid, nearest neighbour', async ({ page }) => {
    await gotoApp(page);
    const dims = {};
    for (const scaleMode of ['x1', 'x4', 'x8', 'fit']) {
      const r = await renderMode(page, { ...BASE, rects: QUADS, colors: true, params: { mode: { pixelSize: 8, paletteSource: 'auto', colors: 4, scaleMode } } });
      dims[scaleMode] = [r.width, r.height];
      expect(r.frames[0].colors, scaleMode).toEqual(Object.values(HEX).sort()); // never blended
    }
    expect(dims).toEqual({ x1: [60, 30], x4: [240, 120], x8: [480, 240], fit: [480, 240] });
    // exporting at 2x doubles the native size
    const x2 = await renderMode(page, { ...BASE, rects: QUADS, outScale: 2, params: { mode: { pixelSize: 8, scaleMode: 'x4' } } });
    expect([x2.width, x2.height]).toEqual([480, 240]);
  });

  test('the outline darkens the lighter side of a boundary by the chosen strength', async ({ page }) => {
    await gotoApp(page);
    const halves = [['#ffffff', 0, 0, 0.5, 1], ['#000000', 0.5, 0, 0.5, 1]];
    const p = { pixelSize: 8, paletteSource: 'mac1bit', scaleMode: 'x1' };
    const plain = await renderMode(page, { ...BASE, rects: halves, colors: true, params: { mode: p } });
    expect(plain.frames[0].colors).toEqual(['#000000', '#ffffff']);
    const out = await renderMode(page, { ...BASE, rects: halves, colors: true, params: { mode: { ...p, outline: true, outlineStrength: 0.5 } } });
    // white * (1 - 0.7 * 0.5) = 165.75 -> 166 = #a6a6a6; black stays black
    expect(out.frames[0].colors).toEqual(['#000000', '#a6a6a6', '#ffffff']);
    // exactly the column of white pixels next to the boundary (art column 29 of 60) is outlined
    const px = await renderMode(page, { ...BASE, rects: halves, params: { mode: { ...p, outline: true, outlineStrength: 0.5 } }, pixels: [[28.5 / 60, 0.5], [29.5 / 60, 0.5], [30.5 / 60, 0.5]] });
    expect(px.frames[0].pixels.map((c) => c[0])).toEqual([255, 166, 0]);
  });

  test('error diffusion above the size threshold runs in the worker with the same pixels', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const heavy = await import('/src/engine/heavy.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 1000; c.height = 600;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 1000, 600);
      grad.addColorStop(0, '#102'); grad.addColorStop(0.5, '#e84'); grad.addColorStop(1, '#8fa');
      g.fillStyle = grad; g.fillRect(0, 0, 1000, 600);
      const source = { id: 'p', kind: 'image', width: 1000, height: 600, version: 1, animated: false, frame: () => c, dispose() {} };
      const mode = getMode('pixelart');
      let started = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, ...rest) { if (m?.type === 'start' && m.task === 'quantizePalette') started++; return post.call(this, m, ...rest); };
      const run = async (forceMain) => {
        heavy.setForceMain(forceMain);
        const before = started;
        const pipe = createPipeline();
        const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(mode.params), pixelSize: 2, paletteSource: 'pico8', dither: 'floyd-steinberg' } };
        const r = await pipe.render({ source, mode, params, theme: { ink: '#fff', bg: '#000' }, quality: 'full' });
        heavy.setForceMain(false);
        const d = r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height).data;
        let h = 2166136261;
        for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
        return { hash: h >>> 0, jobs: started - before, cols: r.meta.cols, rows: r.meta.rows, error: r.error ? String(r.error) : null };
      };
      return { worker: await run(false), main: await run(true) };
    });
    expect(res.worker.error).toBeNull();
    expect(res.worker.cols * res.worker.rows).toBeGreaterThan(100000);
    expect(res.worker.jobs).toBe(1);
    expect(res.main.jobs).toBe(0);
    expect(res.worker.hash).toBe(res.main.hash);
  });
});
