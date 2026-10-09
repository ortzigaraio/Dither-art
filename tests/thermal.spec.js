import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode } from './helpers.js';

// Thermography and gradients (PLAN.md 7.11)

const HALVES = [['#000000', 0, 0, 0.5, 1], ['#ffffff', 0.5, 0, 0.5, 1]];
const BASE = { mode: 'thermal', width: 64, height: 64, rects: HALVES };
const P = (mode) => ({ mode: { autoLevel: false, rangeMin: 0, rangeMax: 100, sensorRes: 'full', ...mode } });
const hex = (c) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// first and last anchor of every palette, written by hand from the colour maps they come from
const ENDPOINTS = {
  ironbow: ['#000000', '#ffffff'], inferno: ['#000004', '#fcffa4'], magma: ['#000004', '#fcfdbf'], plasma: ['#0d0887', '#f0f921'],
  viridis: ['#440154', '#fde725'], turbo: ['#30123b', '#7a0403'], jet: ['#00007f', '#7f0000'], arctic: ['#000000', '#ffffff'],
  whitehot: ['#000000', '#ffffff'], blackhot: ['#ffffff', '#000000'], lava: ['#000000', '#ffffff'],
};

test.describe('thermal: look-up tables', () => {
  test('every palette has a 256-entry table whose endpoints are the documented colours', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async (ids) => {
      const { thermalLUT, THERMAL_IDS } = await import('/src/engine/thermal.js');
      const h = (lut, i) => `#${[0, 1, 2].map((c) => lut[i * 3 + c].toString(16).padStart(2, '0')).join('')}`;
      const out = { ids: THERMAL_IDS, ends: {}, len: {} };
      for (const id of THERMAL_IDS) { const l = thermalLUT(id, ['#102030', '#aa5500', '#ffffee']); out.len[id] = l.length; out.ends[id] = [h(l, 0), h(l, 255)]; }
      const w = thermalLUT('whitehot');
      out.mid = [w[128 * 3], w[64 * 3], w[200 * 3]];
      return out;
    }, Object.keys(ENDPOINTS));
    expect(res.ids).toEqual([...Object.keys(ENDPOINTS), 'custom']);
    for (const id of res.ids) expect(res.len[id], id).toBe(768);
    for (const [id, [a, b]] of Object.entries(ENDPOINTS)) expect(res.ends[id], id).toEqual([a, b]);
    expect(res.ends.custom).toEqual(['#102030', '#ffffee']);
    expect(res.mid).toEqual([128, 64, 200]); // white hot is the identity ramp
  });

  test('rendering black and white through each palette lands exactly on the table endpoints', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    for (const [id, [a, b]] of Object.entries(ENDPOINTS)) {
      const r = await renderMode(page, { ...BASE, params: P({ thermalPalette: id }), pixels: [[0.2, 0.5], [0.8, 0.5]] });
      expect(r.error, id).toBeNull();
      expect(hex(r.frames[0].pixels[0]), `${id} black`).toBe(a);
      expect(hex(r.frames[0].pixels[1]), `${id} white`).toBe(b);
    }
    const custom = await renderMode(page, { ...BASE, params: P({ thermalPalette: 'custom', customStops: ['#102030', '#ff8800'] }), pixels: [[0.2, 0.5], [0.8, 0.5]] });
    expect([hex(custom.frames[0].pixels[0]), hex(custom.frames[0].pixels[1])]).toEqual(['#102030', '#ff8800']);
    await guard.assertClean(expect);
  });

  test('a 50 % grey through the identity ramp is the 128th entry', async ({ page }) => {
    await gotoApp(page);
    const r = await renderMode(page, { ...BASE, rects: [['#808080', 0, 0, 1, 1]], params: P({ thermalPalette: 'whitehot' }), pixels: [[0.5, 0.5]] });
    expect(r.frames[0].pixels[0].slice(0, 3)).toEqual([128, 128, 128]);
  });
});

test.describe('thermal: sources and levels', () => {
  test('heat weights red: a pure red is hotter than a pure blue of equal luma-ish brightness', async ({ page }) => {
    await gotoApp(page);
    const rects = [['#ff0000', 0, 0, 0.5, 1], ['#0000ff', 0.5, 0, 0.5, 1]];
    const heat = await renderMode(page, { ...BASE, rects, params: P({ source: 'heat', thermalPalette: 'whitehot' }), pixels: [[0.2, 0.5], [0.8, 0.5]] });
    // heat = 0.5 R + 0.35 G + 0.15 B: red 0.5 -> index 128, blue 0.15 -> index 38 (round(0.15 * 255) = 38)
    expect(heat.frames[0].pixels[0][0]).toBe(128);
    expect(heat.frames[0].pixels[1][0]).toBe(38);
    const luma = await renderMode(page, { ...BASE, rects, params: P({ source: 'luma', thermalPalette: 'whitehot' }), pixels: [[0.2, 0.5], [0.8, 0.5]] });
    // luma: red 0.2126 -> 54, blue 0.0722 -> 18
    expect([luma.frames[0].pixels[0][0], luma.frames[0].pixels[1][0]]).toEqual([54, 18]);
  });

  test('gradient magnitude lights the edge of a step and leaves flat areas cold; depth (brightness) follows luma', async ({ page }) => {
    await gotoApp(page);
    const g = await renderMode(page, { ...BASE, params: P({ source: 'gradient', thermalPalette: 'whitehot' }), pixels: [[10.5 / 64, 0.5], [31.5 / 64, 0.5], [32.5 / 64, 0.5], [55.5 / 64, 0.5]] });
    expect(g.frames[0].pixels.map((c) => c[0])).toEqual([0, 255, 255, 0]);
    const d = await renderMode(page, { ...BASE, params: P({ source: 'depth', thermalPalette: 'whitehot' }), pixels: [[0.2, 0.5], [0.8, 0.5]] });
    expect(d.frames[0].pixels.map((c) => c[0])).toEqual([0, 255]);
  });

  test('auto level stretches a narrow range to the full palette; the manual range does not', async ({ page }) => {
    await gotoApp(page);
    const rects = [['#666666', 0, 0, 0.5, 1], ['#999999', 0.5, 0, 0.5, 1]];
    const means = [[0.05, 0.1, 0.45, 0.9], [0.55, 0.1, 0.95, 0.9]];
    const auto = await renderMode(page, { ...BASE, rects, means, params: P({ autoLevel: true, thermalPalette: 'whitehot' }) });
    expect(auto.frames[0].means[0]).toBeLessThan(0.05);
    expect(auto.frames[0].means[1]).toBeGreaterThan(0.95);
    const manual = await renderMode(page, { ...BASE, rects, means, params: P({ autoLevel: false, thermalPalette: 'whitehot' }) });
    expect(manual.frames[0].means[0]).toBeCloseTo(0.4, 2);
    expect(manual.frames[0].means[1]).toBeCloseTo(0.6, 2);
    const narrowed = await renderMode(page, { ...BASE, rects, means, params: P({ autoLevel: false, rangeMin: 40, rangeMax: 60, thermalPalette: 'whitehot' }) });
    expect(narrowed.frames[0].means[0]).toBeLessThan(0.03);
    expect(narrowed.frames[0].means[1]).toBeGreaterThan(0.97);
  });

  test('isotherm paints the chosen band in its colour', async ({ page }) => {
    await gotoApp(page);
    const rects = [['#b3b3b3', 0, 0, 1, 1]]; // 179 / 255 = 0.702, inside 60..75 %
    const on = await renderMode(page, { ...BASE, rects, params: P({ thermalPalette: 'ironbow', isotherm: true, isoMin: 60, isoMax: 75, isoColor: '#ff00ff' }), pixels: [[0.5, 0.5]] });
    expect(hex(on.frames[0].pixels[0])).toBe('#ff00ff');
    const off = await renderMode(page, { ...BASE, rects, params: P({ thermalPalette: 'ironbow', isotherm: false }), pixels: [[0.5, 0.5]] });
    expect(hex(off.frames[0].pixels[0])).not.toBe('#ff00ff');
    const outside = await renderMode(page, { ...BASE, rects, params: P({ thermalPalette: 'ironbow', isotherm: true, isoMin: 10, isoMax: 30 }), pixels: [[0.5, 0.5]] });
    expect(outside.frames[0].pixels[0]).toEqual(off.frames[0].pixels[0]);
  });

  test('the sensor grid sets the work resolution while the picture keeps its size; smaller sensors smooth', async ({ page }) => {
    await gotoApp(page);
    const dims = {};
    for (const sensorRes of ['80', '160', '320', 'full']) {
      const r = await renderMode(page, { ...BASE, width: 640, height: 480, params: P({ sensorRes, thermalPalette: 'whitehot' }), colors: true });
      dims[sensorRes] = [r.meta.cols, r.meta.rows, r.width, r.height, r.frames[0].colors.length];
    }
    expect(dims['80'].slice(0, 4)).toEqual([80, 60, 640, 480]);
    expect(dims['160'].slice(0, 4)).toEqual([160, 120, 640, 480]);
    expect(dims['320'].slice(0, 4)).toEqual([320, 240, 640, 480]);
    expect(dims.full.slice(0, 4)).toEqual([640, 480, 640, 480]);
    expect(dims.full[4]).toBe(2); // 1:1, black and white only
    expect(dims['80'][4]).toBeGreaterThan(4); // bilinear upscaling blends the two
  });

  test('noise is deterministic for a seed, different for another, and absent at 0', async ({ page }) => {
    await gotoApp(page);
    const run = (noise, seed) => renderMode(page, { ...BASE, rects: [['#808080', 0, 0, 1, 1]], params: P({ noise, seed, thermalPalette: 'whitehot' }), colors: true });
    const a = await run(0.6, 4);
    const b = await run(0.6, 4);
    const c = await run(0.6, 5);
    const none = await run(0, 4);
    expect(a.frames[0].hash).toBe(b.frames[0].hash);
    expect(a.frames[0].hash).not.toBe(c.frames[0].hash);
    expect(none.frames[0].colors.length).toBe(1);
    expect(a.frames[0].colors.length).toBeGreaterThan(10);
  });
});

test.describe('thermal: gradients sub-mode and HUD', () => {
  test('gradient direction is the hue and the magnitude is the value (HSV)', async ({ page }) => {
    await gotoApp(page);
    const up = await renderMode(page, { ...BASE, params: P({ submode: 'gradients' }), pixels: [[10.5 / 64, 0.5], [31.5 / 64, 0.5], [32.5 / 64, 0.5], [55.5 / 64, 0.5]] });
    // rising luma to the right: gradient angle 0 -> hue 0.5 (cyan) at full value on the two columns of the step
    expect(up.frames[0].pixels.map((c) => c.slice(0, 3))).toEqual([[0, 0, 0], [0, 255, 255], [0, 255, 255], [0, 0, 0]]);
    const down = await renderMode(page, { ...BASE, rects: [['#ffffff', 0, 0, 0.5, 1], ['#000000', 0.5, 0, 0.5, 1]], params: P({ submode: 'gradients' }), pixels: [[31.5 / 64, 0.5]] });
    // falling to the right: angle pi -> hue 1.0 = red
    expect(down.frames[0].pixels[0].slice(0, 3)).toEqual([255, 0, 0]);
  });

  test('the HUD reports a fictional temperature from the scalar, a scale and a time stamp, and draws over the picture', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const args = { ...BASE, width: 320, height: 240, rects: [['#808080', 0, 0, 1, 1]], time: 3.7, means: [[0, 0, 0.3, 0.12]] };
    const on = await renderMode(page, { ...args, params: P({ thermalPalette: 'ironbow', hud: true, tempMin: 18, tempMax: 42 }) });
    // centre value 128/255 = 0.50196 -> 18 + 24 * 0.50196 = 30.05 -> "30.0°C"
    expect(on.meta.hud).toEqual({ center: '30.0°C', max: '42.0°C', min: '18.0°C', stamp: 'REC 00:00:03' });
    const off = await renderMode(page, { ...args, params: P({ thermalPalette: 'ironbow', hud: false }) });
    expect(off.meta.hud).toBeUndefined();
    expect(on.frames[0].hash).not.toBe(off.frames[0].hash);
    expect(on.frames[0].means[0]).toBeGreaterThan(off.frames[0].means[0] + 0.01); // white text on the dark top-left corner
    const wide = await renderMode(page, { ...args, params: P({ thermalPalette: 'ironbow', hud: true, tempMin: -10, tempMax: 200 }) });
    expect(wide.meta.hud.center).toBe('95.4°C'); // -10 + 210 * 0.50196 = 95.41
    await guard.assertClean(expect);
  });
});
