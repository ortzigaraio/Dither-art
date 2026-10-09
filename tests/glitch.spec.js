import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, loadFixture, renderMode, renderCount, settle, setControl } from './helpers.js';

// Glitch art (PLAN.md 7.12): every effect checked on a tiny synthetic image with hand-computed expectations

/** Test pictures, built inside the page (the CSP forbids evaluating strings, so they are named, not passed as code). */
const PICTURES = {
  black: { kind: 'plain', v: 0 },
  whiteLine: { kind: 'line' },
  plain: (v) => ({ kind: 'plain', v }),
  noisy: { kind: 'noisy' },
  twoTone: { kind: 'twoTone' },
};

/** Run applyGlitch inside the page on a named picture, return plain arrays. */
async function glitch(page, { w, h, make, params, seed = 1 }) {
  return page.evaluate(async (a) => {
    const { applyGlitch } = await import('/src/engine/glitch.js');
    const src = new Uint8ClampedArray(a.w * a.h * 4);
    const set = (x, y, r, g, b) => { const o = (y * a.w + x) * 4; src[o] = r; src[o + 1] = g; src[o + 2] = b; src[o + 3] = 255; };
    let s = 12345;
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        if (a.make.kind === 'noisy') { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const v = (s >>> 16) & 255; set(x, y, v, (v * 7) & 255, (v * 13) & 255); }
        else if (a.make.kind === 'twoTone') { const v = x < 4 ? 100 : 200; set(x, y, v, v, v); }
        else if (a.make.kind === 'line') set(x, y, x === 20 ? 255 : 0, x === 20 ? 255 : 0, x === 20 ? 255 : 0);
        else set(x, y, a.make.v, a.make.v, a.make.v);
      }
    }
    const out = applyGlitch(src, a.w, a.h, a.params, a.seed);
    return { src: Array.from(src), out: Array.from(out) };
  }, { w, h, make, params, seed });
}
const px = (arr, w, x, y) => arr.slice((y * w + x) * 4, (y * w + x) * 4 + 4);

test.describe('glitch: each effect', () => {
  test('with every intensity at 0 the picture is untouched', async ({ page }) => {
    await gotoApp(page);
    const r = await glitch(page, { w: 40, h: 24, make: PICTURES.noisy, params: {} });
    expect(r.out).toEqual(r.src);
  });

  test('RGB split moves red left and blue right by 4 % of the width, green stays', async ({ page }) => {
    await gotoApp(page);
    // W = 100, amount 1 -> dx = round(0.04 * 100) = 4; H = 10 -> dy = round(0.012 * 10) = 0
    const r = await glitch(page, { w: 100, h: 10, make: PICTURES.whiteLine, params: { rgbSplit: 1 } });
    expect(px(r.out, 100, 16, 5)).toEqual([255, 0, 0, 255]); // red read from x + 4
    expect(px(r.out, 100, 20, 5)).toEqual([0, 255, 0, 255]); // green where the line is
    expect(px(r.out, 100, 24, 5)).toEqual([0, 0, 255, 255]); // blue read from x - 4
    expect(px(r.out, 100, 50, 5)).toEqual([0, 0, 0, 255]);
  });

  test('bit crush to 4 bits (amount 4/7) snaps 100 to 102 and 200 to 204; 1 bit gives 0 or 255', async ({ page }) => {
    await gotoApp(page);
    const make = PICTURES.twoTone;
    const four = await glitch(page, { w: 8, h: 2, make, params: { bitCrush: 4 / 7 } });
    // 4 bits = 16 levels: round(100 / 255 * 15) = 6 -> 6 / 15 * 255 = 102; round(200 / 255 * 15) = 12 -> 204
    expect(px(four.out, 8, 0, 0).slice(0, 3)).toEqual([102, 102, 102]);
    expect(px(four.out, 8, 7, 1).slice(0, 3)).toEqual([204, 204, 204]);
    const one = await glitch(page, { w: 8, h: 2, make, params: { bitCrush: 1 } });
    expect(px(one.out, 8, 0, 0).slice(0, 3)).toEqual([0, 0, 0]);
    expect(px(one.out, 8, 7, 0).slice(0, 3)).toEqual([255, 255, 255]);
  });

  test('scanlines darken the odd rows to 40 % at full intensity and leave the even rows alone', async ({ page }) => {
    await gotoApp(page);
    const r = await glitch(page, { w: 6, h: 6, make: PICTURES.plain(200), params: { scanlines: 1 } });
    for (let y = 0; y < 6; y++) expect(px(r.out, 6, 2, y).slice(0, 3), `row ${y}`).toEqual(y % 2 ? [80, 80, 80] : [200, 200, 200]);
  });

  test('interlace shifts the odd rows by 3 % of the width (wrapping) and dims them to 75 %', async ({ page }) => {
    await gotoApp(page);
    const r = await glitch(page, { w: 100, h: 4, make: PICTURES.whiteLine, params: { interlace: 1 } });
    expect(px(r.out, 100, 20, 0)).toEqual([255, 255, 255, 255]); // even row: untouched
    expect(px(r.out, 100, 20, 1).slice(0, 3)).toEqual([0, 0, 0]);
    expect(px(r.out, 100, 23, 1).slice(0, 3)).toEqual([191, 191, 191]); // 255 * 0.75 = 191.25, moved right by round(0.03 * 100) = 3
    expect(px(r.out, 100, 23, 2)).toEqual([0, 0, 0, 255]);
  });

  test('stripe shift only rotates whole rows: every row keeps its pixels, some rows move', async ({ page }) => {
    await gotoApp(page);
    const w = 64;
    const r = await glitch(page, { w, h: 48, make: PICTURES.noisy, params: { bandShift: 0.8 }, seed: 9 });
    let moved = 0;
    for (let y = 0; y < 48; y++) {
      const a = [], b = [];
      for (let x = 0; x < w; x++) { a.push(px(r.src, w, x, y).join(',')); b.push(px(r.out, w, x, y).join(',')); }
      expect(b.slice().sort(), `row ${y} is a rotation of the source row`).toEqual(a.slice().sort());
      if (a.join('|') !== b.join('|')) moved++;
    }
    expect(moved).toBeGreaterThan(2);
    expect(moved).toBeLessThan(48);
  });

  test('block corruption only copies existing pixels and changes whole macroblocks', async ({ page }) => {
    await gotoApp(page);
    const w = 192, h = 128; // 12 x 8 macroblocks: 7 of them are corrupted at intensity 1
    const r = await glitch(page, { w, h, make: PICTURES.noisy, params: { blockCorrupt: 1, blockSize: 16 }, seed: 3 });
    const source = new Set();
    for (let i = 0; i < w * h; i++) source.add(r.src.slice(i * 4, i * 4 + 3).join(','));
    let changed = 0;
    let foreign = 0; // output pixels whose colour is not in the source
    const perBlock = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (!source.has(`${r.out[o]},${r.out[o + 1]},${r.out[o + 2]}`)) foreign++;
        if (r.out[o] !== r.src[o] || r.out[o + 1] !== r.src[o + 1] || r.out[o + 2] !== r.src[o + 2]) {
          changed++;
          const key = `${Math.floor(x / 16)},${Math.floor(y / 16)}`;
          perBlock.set(key, (perBlock.get(key) || 0) + 1);
        }
      }
    }
    expect(foreign).toBe(0);
    expect(changed).toBeGreaterThan(300);
    // a touched macroblock changed (almost) completely: copies of noise rarely match the pixel they replace
    for (const [key, c] of perBlock) expect(c, `block ${key}`).toBeGreaterThan(200);
  });

  test('DCT artefacts smooth a noisy block (coarse quantisation drops high frequencies) and keep flat areas flat', async ({ page }) => {
    await gotoApp(page);
    const w = 32, h = 32;
    const tv = (a) => { let s = 0; for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) s += Math.abs(a[(y * w + x) * 4 + 1] - a[(y * w + x - 1) * 4 + 1]); return s; };
    const r = await glitch(page, { w, h, make: PICTURES.noisy, params: { dct: 1 } });
    expect(tv(r.out)).toBeLessThan(tv(r.src) * 0.6);
    expect(r.out).not.toEqual(r.src);
    const flat = await glitch(page, { w, h, make: PICTURES.plain(128), params: { dct: 0.3 } });
    const values = new Set();
    for (let i = 0; i < w * h; i++) values.add(flat.out[i * 4]);
    expect(values.size).toBe(1); // every pixel of a flat picture lands on the same value
    expect(Math.abs([...values][0] - 128)).toBeLessThanOrEqual(6);
  });

  test('noise stays inside 0..255, is zero-mean-ish and depends on the seed only', async ({ page }) => {
    await gotoApp(page);
    const a = await glitch(page, { w: 64, h: 64, make: PICTURES.plain(128), params: { noise: 0.5 }, seed: 7 });
    const b = await glitch(page, { w: 64, h: 64, make: PICTURES.plain(128), params: { noise: 0.5 }, seed: 7 });
    const c = await glitch(page, { w: 64, h: 64, make: PICTURES.plain(128), params: { noise: 0.5 }, seed: 8 });
    expect(a.out).toEqual(b.out);
    expect(a.out).not.toEqual(c.out);
    let sum = 0, max = 0;
    for (let i = 0; i < 64 * 64; i++) { sum += a.out[i * 4 + 1] - 128; max = Math.max(max, Math.abs(a.out[i * 4 + 1] - 128)); }
    expect(Math.abs(sum / (64 * 64))).toBeLessThan(3);
    expect(max).toBeLessThanOrEqual(45); // amplitude 0.5 * 90
    expect(max).toBeGreaterThan(30);
  });
});

test.describe('glitch: determinism', () => {
  const ALL = { rgbSplit: 0.4, bandShift: 0.5, blockCorrupt: 0.5, blockSize: 8, bitCrush: 0.3, dct: 0.3, scanlines: 0.3, noise: 0.2, interlace: 0.3 };

  test('the same seed gives the same pixels twice, in any order of calls; another seed gives different pixels', async ({ page }) => {
    await gotoApp(page);
    const a = await glitch(page, { w: 80, h: 48, make: PICTURES.noisy, params: ALL, seed: 5 });
    await glitch(page, { w: 80, h: 48, make: PICTURES.noisy, params: ALL, seed: 6 });
    const b = await glitch(page, { w: 80, h: 48, make: PICTURES.noisy, params: ALL, seed: 5 });
    const c = await glitch(page, { w: 80, h: 48, make: PICTURES.noisy, params: ALL, seed: 6 });
    expect(a.out).toEqual(b.out);
    expect(a.out).not.toEqual(c.out);
    let diff = 0;
    for (let i = 0; i < a.out.length; i++) if (a.out[i] !== c.out[i]) diff++;
    expect(diff).toBeGreaterThan(a.out.length * 0.2);
  });

  test('the mode: same seed and time -> identical canvas; another seed differs; time matters only with animate', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const rects = [['#d02020', 0, 0, 0.5, 0.5], ['#20c040', 0.5, 0, 0.5, 0.5], ['#2040e0', 0, 0.5, 0.5, 0.5], ['#f0e060', 0.5, 0.5, 0.5, 0.5]];
    const run = (mode, times) => renderMode(page, { mode: 'glitch', width: 256, height: 160, rects, params: { mode: { rgbSplit: 0.5, bandShift: 0.5, noise: 0.2, ...mode } }, times });
    const a = await run({ seed: 4 }, [0]);
    const b = await run({ seed: 4 }, [0]);
    const c = await run({ seed: 5 }, [0]);
    expect(a.error).toBeNull();
    expect(a.frames[0].hash).toBe(b.frames[0].hash);
    expect(a.frames[0].hash).not.toBe(c.frames[0].hash);
    // animate off: the frame time is irrelevant
    const still = await run({ seed: 4, animate: false }, [0, 0.4, 3.1]);
    expect(new Set(still.frames.map((f) => f.hash)).size).toBe(1);
    // animate on, 8 changes per second: frames inside one tick agree, other ticks differ, and revisiting a time repeats it
    const anim = await run({ seed: 4, animate: true, rate: 8 }, [0.0, 0.05, 0.5, 1.0, 0.5, 0.0]);
    const h = anim.frames.map((f) => f.hash);
    expect(h[0]).toBe(h[1]); // 0.0 and 0.05 are both in tick 0 (0.125 s)
    expect(new Set([h[0], h[2], h[3]]).size).toBe(3);
    expect(h[4]).toBe(h[2]);
    expect(h[5]).toBe(h[0]);
    await guard.assertClean(expect);
  });

  test('the frame seed follows floor(time * rate) and is stable across a re-export of the same times', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { frameSeed } = await import('/src/modes/glitch.js');
      const p = { seed: 10, animate: true, rate: 4 };
      return {
        t0: frameSeed(p, 0), t1: frameSeed(p, 0.24), t2: frameSeed(p, 0.25), t3: frameSeed(p, 0.49), t4: frameSeed(p, 0.5),
        off: [frameSeed({ ...p, animate: false }, 0), frameSeed({ ...p, animate: false }, 9)],
        // the exporter feeds i / fps (30 fps)
        ticks: Array.from({ length: 16 }, (_, i) => frameSeed(p, i / 30) === frameSeed(p, 0) ? 0 : (frameSeed(p, i / 30) === frameSeed(p, 0.25) ? 1 : 2)),
      };
    });
    expect(res.t0).toBe(res.t1);
    expect(res.t2).toBe(res.t3);
    expect(res.t0).not.toBe(res.t2);
    expect(res.t4).not.toBe(res.t2);
    expect(res.off[0]).toBe(10);
    expect(res.off[1]).toBe(10);
    // tick = floor(t * 4): frames 0..7 (t <= 0.2333) are tick 0, frames 8..14 (0.2667 <= t <= 0.4667) tick 1, frame 15 (t = 0.5) tick 2
    expect(res.ticks).toEqual([...Array(8).fill(0), ...Array(7).fill(1), 2]);
  });
});

test.describe('glitch: in the studio', () => {
  test('"animate" makes the still picture loop and exportable as video; turning it off stops the loop', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="glitch"]').click();
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
    await settle(page, 350);
    await expect(page.locator('#controls [data-export="video"]')).toHaveCount(0);
    const idleA = await renderCount(page);
    await page.waitForTimeout(500);
    expect(await renderCount(page)).toBe(idleA); // not animated: idle
    await setControl(page, 'animate', true);
    await expect(page.locator('#controls [data-export="video"]')).toHaveCount(1);
    const a = await renderCount(page);
    await page.waitForTimeout(600);
    expect((await renderCount(page)) - a).toBeGreaterThanOrEqual(4);
    await setControl(page, 'animate', false);
    await expect(page.locator('#controls [data-export="video"]')).toHaveCount(0);
    await settle(page, 350);
    const b = await renderCount(page);
    await page.waitForTimeout(500);
    expect(await renderCount(page)).toBe(b);
    await guard.assertClean(expect);
  });
});
