import { test, expect } from '@playwright/test';
import {
  watchPage, gotoApp, renderMode, loadFixture, loadVideo, settle, renderCount, waitForRender, canvasStats, captureDownload,
  inspectMedia, pauseVideo,
} from './helpers.js';

// Matrix rain (PLAN.md 7.5): animated, deterministic for a fixed seed and time

const FONTS = [['geist-mono', 'ｦｧｱ0123456789']];

test.describe('matrix: the rain field', () => {
  test('is a pure function of (seed, time): same input, same field; other seed or time, other field', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { rainField } = await import('/src/modes/matrix.js');
      const base = { cols: 40, rows: 30, glyphCount: 20, seed: 42, time: 3.25, speed: 1, density: 0.6, trail: 20, changeRate: 0.05 };
      const sig = (o) => JSON.stringify([Array.from(o.glyph), Array.from(o.level).map((v) => Math.round(v * 1e4)), Array.from(o.head)]);
      const a = sig(rainField(base));
      rainField({ ...base, time: 9 }); // evaluating another time in between changes nothing
      const b = sig(rainField(base));
      return {
        same: a === b,
        otherSeed: a !== sig(rainField({ ...base, seed: 43 })),
        otherTime: a !== sig(rainField({ ...base, time: 3.5 })),
        lit: rainField(base).glyph.filter((g) => g >= 0).length,
      };
    });
    expect(res.same).toBe(true);
    expect(res.otherSeed).toBe(true);
    expect(res.otherTime).toBe(true);
    expect(res.lit).toBeGreaterThan(40);
  });

  test('drops fall at the column speed, heads are unique per column and trails fade upwards', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { rainField, hash01 } = await import('/src/modes/matrix.js');
      const cols = 60, rows = 200; // tall enough that a drop does not wrap during the test
      const base = { cols, rows, glyphCount: 20, seed: 7, speed: 1, density: 1, trail: 20, changeRate: 0 };
      const headRow = (f, x) => { for (let y = 0; y < rows; y++) if (f.head[y * cols + x]) return y; return -1; };
      const t0 = rainField({ ...base, time: 1 });
      const t1 = rainField({ ...base, time: 1.3 });
      const t2 = rainField({ ...base, time: 1.3 + 0.6, speed: 1 });
      const checks = [];
      let multi = 0;
      let notDecreasing = 0;
      for (let x = 0; x < cols; x++) {
        let heads = 0;
        for (let y = 0; y < rows; y++) heads += t0.head[y * cols + x];
        if (heads > 1) multi++;
        const a = headRow(t0, x);
        const b = headRow(t1, x);
        if (a >= 0 && b >= 0) {
          const v = 9 * (0.55 + 0.9 * hash01(7, x, 1));
          checks.push({ moved: b - a, expected: v * 0.3 });
          // levels above the head decrease monotonically
          for (let y = a - 1; y > a - 15 && y >= 0; y--) if (t0.level[y * cols + x] > t0.level[(y + 1) * cols + x] + 1e-6) notDecreasing++;
        }
      }
      // double speed -> double distance
      const f1 = rainField({ ...base, time: 0.5, speed: 1 });
      const f2 = rainField({ ...base, time: 0.5, speed: 2 });
      return { multi, notDecreasing, checks, n: checks.length, sample: !!t2, f1: Array.from(f1.head).indexOf(1), f2: Array.from(f2.head).indexOf(1) };
    });
    expect(res.multi).toBe(0);
    expect(res.notDecreasing).toBe(0);
    expect(res.n).toBeGreaterThan(10);
    for (const c of res.checks) expect(Math.abs(c.moved - c.expected)).toBeLessThanOrEqual(1.01);
  });

  test('density 0 draws nothing; density 1 fills most columns; the trail length is respected', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { rainField } = await import('/src/modes/matrix.js');
      const base = { cols: 80, rows: 40, glyphCount: 10, seed: 3, time: 2, speed: 1, trail: 12, changeRate: 0 };
      const count = (f) => f.glyph.filter((g) => g >= 0).length;
      const colsWith = (f) => { let c = 0; for (let x = 0; x < 80; x++) { let any = false; for (let y = 0; y < 40; y++) if (f.glyph[y * 80 + x] >= 0) any = true; if (any) c++; } return c; };
      const maxPerCol = (f) => { let m = 0; for (let x = 0; x < 80; x++) { let c = 0; for (let y = 0; y < 40; y++) if (f.glyph[y * 80 + x] >= 0) c++; m = Math.max(m, c); } return m; };
      const none = rainField({ ...base, density: 0 });
      const all = rainField({ ...base, density: 1 });
      const half = rainField({ ...base, density: 0.5 });
      return { none: count(none), colsAll: colsWith(all), colsHalf: colsWith(half), colsAllMax: maxPerCol(all) };
    });
    expect(res.none).toBe(0);
    expect(res.colsAll).toBeGreaterThan(40);
    expect(res.colsHalf).toBeLessThan(res.colsAll);
    expect(res.colsAllMax).toBeLessThanOrEqual(13); // trail 12 + the head cell
  });
});

test.describe('matrix: rendering', () => {
  const spec = {
    mode: 'matrix', width: 300, height: 200, fonts: FONTS, faces: [{ css: '16px "Geist Mono"', text: 'ｦ0' }],
    rects: [['#ffffff', 0, 0, 1, 1]],
    params: { global: { cols: 60 }, mode: { glow: 0 } },
  };

  test('fixed seed and time give identical pixels in separate pipelines; time and seed change the frame', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const a = await renderMode(page, { ...spec, times: [3, 5, 3] });
    expect(a.error).toBeNull();
    expect(a.frames[0].hash).toBe(a.frames[2].hash); // stateless: coming back to t=3 gives the same frame
    expect(a.frames[0].hash).not.toBe(a.frames[1].hash);
    const b = await renderMode(page, { ...spec, times: [3] });
    expect(b.frames[0].hash).toBe(a.frames[0].hash); // another pipeline, same pixels
    const c = await renderMode(page, { ...spec, params: { ...spec.params, mode: { glow: 0, seed: 43 } }, times: [3] });
    expect(c.frames[0].hash).not.toBe(a.frames[0].hash);
    // with glow too
    const g1 = await renderMode(page, { ...spec, params: { ...spec.params, mode: { glow: 0.8 } }, times: [2, 2] });
    expect(g1.frames[0].hash).toBe(g1.frames[1].hash);
    expect(g1.frames[0].hash).not.toBe(a.frames[0].hash);
    await guard.assertClean(expect);
  });

  test('the picture shows through the rain: the bright half is brighter than the dark half', async ({ page }) => {
    await gotoApp(page);
    const half = {
      ...spec, rects: [['#000000', 0, 0, 1, 1], ['#ffffff', 0, 0, 0.5, 1]],
      params: { global: { cols: 80 }, mode: { imageInfluence: 1, glow: 0, density: 1, trail: 30, speed: 1, bgColor: '#000000' } },
      times: [1, 2, 3, 4, 5, 6], means: [[0, 0, 0.5, 1], [0.5, 0, 1, 1]],
    };
    const r = await renderMode(page, half);
    const avg = (i) => r.frames.reduce((s, f) => s + f.means[i], 0) / r.frames.length;
    expect(avg(1)).toBeLessThan(0.001); // nothing is lit over the black half
    expect(avg(0)).toBeGreaterThan(0.01);
    // with no influence both halves look alike
    const flat = await renderMode(page, { ...half, params: { ...half.params, mode: { ...half.params.mode, imageInfluence: 0 } } });
    const favg = (i) => flat.frames.reduce((s, f) => s + f.means[i], 0) / flat.frames.length;
    expect(Math.abs(favg(0) - favg(1)) / Math.max(favg(0), favg(1))).toBeLessThan(0.35);
  });

  test('ink colour, glyph sets and the size cap', async ({ page }) => {
    await gotoApp(page);
    const mk = (mode) => renderMode(page, {
      ...spec, params: { global: { cols: 60 }, mode: { glow: 0, density: 1, bgColor: '#000000', ...mode } }, times: [4],
    });
    const green = (await mk({ inkColor: '#00ff00' })).frames[0].channels;
    const red = (await mk({ inkColor: '#ff0000' })).frames[0].channels;
    expect(green[1]).toBeGreaterThan(0.01);
    expect(green[1]).toBeGreaterThan(green[0] * 2); // green dominates (the white-ish heads add a little red and blue)
    expect(green[1]).toBeGreaterThan(green[2] * 2);
    expect(red[0]).toBeGreaterThan(red[1] * 2);
    expect(red[0]).toBeGreaterThan(red[2] * 2);
    for (const g of ['katakana', 'digits', 'binary', 'latin', 'symbols']) {
      const r = await mk({ glyphSet: g });
      expect(r.error, g).toBeNull();
    }
    const big = await renderMode(page, { ...spec, params: { global: { cols: 600 }, mode: { glow: 0, cellSize: 32 } }, times: [1], outScale: 4 });
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(4096);
  });
});

test.describe('matrix: in the studio (animation on stills and video)', () => {
  test('runs its loop on a still image; other modes go idle again', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before0 = await renderCount(page);
    await page.waitForTimeout(500);
    expect(await renderCount(page)).toBe(before0); // ASCII on a still picture: idle (PLAN.md 5.7)

    await page.locator('#mode-list .mode-item[data-mode-id="matrix"]').click();
    await page.waitForFunction(() => Number(document.getElementById('viewer-canvas').dataset.frame) > 0);
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b + 3, await renderCount(page));
    const f0 = await renderCount(page);
    const h0 = (await canvasStats(page)).hash;
    await page.waitForTimeout(700);
    const f1 = await renderCount(page);
    const h1 = (await canvasStats(page)).hash;
    expect(f1 - f0).toBeGreaterThanOrEqual(5); // many frames per second
    expect(h1).not.toBe(h0); // and the pixels move
    expect((await canvasStats(page)).variance).toBeGreaterThan(0);

    await page.locator('#mode-list .mode-item[data-mode-id="ascii"]').click();
    await settle(page);
    const idle = await renderCount(page);
    await page.waitForTimeout(500);
    expect(await renderCount(page)).toBe(idle);
    await guard.assertClean(expect);
  });

  test('with a video the rain follows the video clock (moves while playing, still when paused)', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadVideo(page);
    await page.locator('#mode-list .mode-item[data-mode-id="matrix"]').click();
    await settle(page, 200);
    const a = (await canvasStats(page)).hash;
    await page.waitForTimeout(500);
    const b = (await canvasStats(page)).hash;
    expect(b).not.toBe(a);
    await pauseVideo(page);
    const c = (await canvasStats(page)).hash;
    const frames = await renderCount(page);
    await page.waitForTimeout(500);
    const d = (await canvasStats(page)).hash;
    expect(await renderCount(page)).toBeGreaterThan(frames); // the loop keeps running...
    expect(d).toBe(c); // ...but time is the paused video clock, so the picture is stable
    await guard.assertClean(expect);
  });

  test('video export of a still image: duration and fps options, frames at i/fps, identical frames per time', async ({ page }) => {
    test.setTimeout(120_000);
    const guard = watchPage(page);
    await gotoApp(page);
    await page.evaluate(async () => {
      const matrix = (await import('/src/modes/matrix.js')).default;
      window.__frames = [];
      const render = matrix.render;
      matrix.render = function (ctx, state) {
        const r = render.call(this, ctx, state);
        if (ctx.isExport) {
          const c = ctx.out.canvas;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let h = 2166136261;
          for (let i = 0; i < d.length; i += 7) h = Math.imul(h ^ d[i], 16777619);
          window.__frames.push([ctx.time, (h >>> 0).toString(16)]);
        }
        return r;
      };
    });
    await loadFixture(page);
    await page.locator('#mode-list .mode-item[data-mode-id="matrix"]').click();
    await settle(page, 200);
    const exportOnce = async () => {
      await page.locator('#controls [data-export="video"]').click();
      await page.waitForSelector('#export-dialog[open]');
      await page.waitForFunction(() => document.getElementById('vx-go') && !document.getElementById('vx-go').disabled);
      await expect(page.locator('#vx-duration')).toBeVisible();
      await page.selectOption('#vx-format', 'webm');
      await page.selectOption('#vx-height', '480');
      await page.selectOption('#vx-fps', '24');
      await page.locator('#vx-duration').fill('1');
      return captureDownload(page, () => page.click('#vx-go'));
    };
    const file = await exportOnce();
    expect(file.name).toMatch(/^dither-matrix-\d{8}-\d{6}\.webm$/);
    const info = await inspectMedia(page, file.bytes);
    expect(info.duration).toBeGreaterThan(0.8);
    expect(info.duration).toBeLessThan(1.4);
    expect(info.video.height).toBe(480);
    const first = await page.evaluate(() => window.__frames.slice(-24));
    expect(first).toHaveLength(24);
    first.forEach(([t], i) => expect(t).toBeCloseTo(i / 24, 5));
    expect(new Set(first.map((f) => f[1])).size).toBeGreaterThan(12); // the rain actually moves between frames
    // a second export renders exactly the same frames (deterministic)
    await page.evaluate(() => { window.__frames.length = 0; });
    await exportOnce();
    const second = await page.evaluate(() => window.__frames.slice(-24));
    expect(second).toEqual(first);
    await guard.assertClean(expect);
  });
});
