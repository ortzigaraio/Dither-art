import { test, expect } from '@playwright/test';
import {
  watchPage, gotoApp, loadFixture, renderCount, settle, renderMode, waitForCanvasData, captureDownload,
} from './helpers.js';

// Voronoi / stipple (PLAN.md 7.16): weighted Lloyd relaxation in the heavy worker (engine/stipple.js), partial results
// for the animation, cancellation by jobId, determinism for a seed, and the four sub-styles.

test.describe('voronoi stippling task', () => {
  test('keeps the point count, follows the weights and is deterministic (worker = main thread)', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const W = 160, H = 100, count = 600;
      // weights: dark left half (1), light right half (0.1)
      const weights = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) weights[y * W + x] = x < W / 2 ? 1 : 0.1;
      const job = (seed, local = false) => heavy.run('stipple', { weights, W, H, count, iterations: 6, seed }, { local });
      const a = await job(5);
      const b = await job(5);
      const c = await job(6);
      const m = await job(5, true);
      const same = (p, q) => p.length === q.length && p.every((v, i) => v === q[i]);
      let left = 0, inside = true;
      for (let i = 0; i < count; i++) {
        const x = a.points[i * 2], y = a.points[i * 2 + 1];
        if (x < W / 2) left++;
        if (!(x >= 0 && x <= W && y >= 0 && y <= H)) inside = false;
      }
      return {
        len: a.points.length, iterations: a.iterations, sameSeed: same(a.points, b.points), otherSeed: !same(a.points, c.points),
        workerEqualsMain: same(a.points, m.points), left, inside, stats: heavy.stats(),
      };
    });
    expect(res.len).toBe(1200);
    expect(res.iterations).toBe(6);
    expect(res.sameSeed).toBe(true);
    expect(res.otherSeed).toBe(true);
    expect(res.workerEqualsMain).toBe(true);
    expect(res.inside).toBe(true);
    // density 1 vs 0.1: about 10/11 of the points on the left
    expect(res.left / 600).toBeGreaterThan(0.85);
    expect(res.stats.hasWorker).toBe(true);
  });

  test('sends one partial per Lloyd iteration and can be cancelled mid-way', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const W = 700, H = 500, count = 20000;
      const weights = new Float32Array(W * H);
      for (let i = 0; i < weights.length; i++) weights[i] = ((i % W) / W) * 0.9 + 0.1;
      // 1. partials
      const parts = [];
      await heavy.run('stipple', { weights: weights.subarray(0, 200 * 120), W: 200, H: 120, count: 300, iterations: 5, seed: 3 }, {
        onPartial: (p) => parts.push({ it: p.iteration, len: p.points.length }),
      });
      // 2. cancel after the first partial
      const ac = new AbortController();
      const after = [];
      let cancelledAt = 0;
      const t0 = performance.now();
      const job = heavy.run('stipple', { weights, W, H, count, iterations: 40, seed: 1 }, {
        signal: ac.signal,
        onPartial: (p) => { if (cancelledAt) after.push(p.iteration); else { cancelledAt = performance.now(); ac.abort(); } },
      });
      let error = null;
      try { await job; } catch (e) { error = e.name; }
      const rejectMs = performance.now() - cancelledAt;
      await new Promise((r) => setTimeout(r, 600));
      const stats = heavy.stats();
      // 3. the runner still works
      const next = await heavy.run('stipple', { weights: weights.subarray(0, 100 * 80), W: 100, H: 80, count: 50, iterations: 2, seed: 9 });
      return { parts, error, rejectMs, after, stats, nextLen: next.points.length, total: performance.now() - t0 };
    });
    expect(res.parts.map((p) => p.it)).toEqual([1, 2, 3, 4, 5]);
    expect(res.parts.every((p) => p.len === 600)).toBe(true);
    expect(res.error).toBe('AbortError');
    expect(res.rejectMs).toBeLessThan(50);
    expect(res.after).toEqual([]);
    expect(res.stats.pending).toBe(0);
    expect(res.nextLen).toBe(100);
  });
});

test.describe('voronoi performance (PLAN.md 15)', () => {
  test('10 000 points and 15 Lloyd iterations finish in the worker in under 3 s', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const { stippleWorkSize } = await import('/src/modes/voronoi.js');
      const { width: W, height: H } = stippleWorkSize(10000, 1600, 1200);
      const weights = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) weights[y * W + x] = 0.5 + 0.5 * Math.sin(x * 0.02) * Math.cos(y * 0.03);
      await heavy.run('stipple', { weights: weights.subarray(0, 64 * 64), W: 64, H: 64, count: 50, iterations: 1, seed: 1 }); // worker warm-up
      const t0 = performance.now();
      const r = await heavy.run('stipple', { weights, W, H, count: 10000, iterations: 15, seed: 1 });
      return { ms: performance.now() - t0, n: r.points.length / 2, px: W * H };
    });
    expect(res.n).toBe(10000);
    expect(res.px).toBeGreaterThan(350000);
    expect(res.ms).toBeLessThan(3000);
  });
});

test.describe('voronoi mode', () => {
  test('exports are deterministic for a seed, with the expected layers per sub-style', async ({ page }) => {
    const guard = watchPage(page);
    await page.goto('/tests/blank.html');
    const rects = [['#ffffff', 0, 0, 1, 1], ['#000000', 0.1, 0.2, 0.35, 0.6], ['#777777', 0.55, 0.1, 0.4, 0.4]];
    const base = { mode: 'voronoi', width: 320, height: 240, rects, isExport: true, outputs: ['svg'] };
    const a = await renderMode(page, { ...base, params: { mode: { points: 1500, iterations: 8, seed: 4 } } });
    const b = await renderMode(page, { ...base, params: { mode: { points: 1500, iterations: 8, seed: 4 } } });
    const c = await renderMode(page, { ...base, params: { mode: { points: 1500, iterations: 8, seed: 5 } } });
    expect(a.error).toBeNull();
    expect(a.frames[0].hash).toBe(b.frames[0].hash);
    expect(a.outputs.svg).toBe(b.outputs.svg);
    expect(c.frames[0].hash).not.toBe(a.frames[0].hash);
    expect(a.meta.cols).toBe(1500);
    expect(a.meta.rows).toBe(8); // iterations done
    const svgInfo = async (svg) => page.evaluate((src) => {
      const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
      const INK = 'http://www.inkscape.org/namespaces/inkscape';
      return {
        error: !!doc.querySelector('parsererror'),
        layers: Array.from(doc.querySelectorAll('g')).map((g) => g.getAttributeNS(INK, 'label')),
        circles: doc.querySelectorAll('circle').length,
        paths: doc.querySelectorAll('path').length,
      };
    }, svg);
    const sa = await svgInfo(a.outputs.svg);
    expect(sa.error).toBe(false);
    expect(sa.layers).toEqual(['Background', 'Stipple']);
    expect(sa.circles).toBe(1500);
    const expectLayers = { cells: ['Background', 'Cells', 'Borders'], lowpoly: ['Background', 'Triangles', 'Edges'], constellation: ['Background', 'Edges', 'Stars'] };
    for (const [style, layers] of Object.entries(expectLayers)) {
      const r = await renderMode(page, { ...base, params: { mode: { style, points: 600, iterations: 4, border: true } } });
      expect(r.error, style).toBeNull();
      const info = await svgInfo(r.outputs.svg);
      expect(info.error, style).toBe(false);
      expect(info.layers, style).toEqual(layers);
      expect(info.paths, style).toBeGreaterThan(0);
    }
    await guard.assertClean(expect);
  });

  test('a progressive render shows the points at once, animates the relaxation and cancels a stale job', async ({ page }) => {
    await page.goto('/tests/blank.html');
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const heavy = await import('/src/engine/heavy.js');
      const c = document.createElement('canvas');
      c.width = 400; c.height = 300;
      const g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 400, 0);
      grd.addColorStop(0, '#000'); grd.addColorStop(1, '#fff');
      g.fillStyle = grd; g.fillRect(0, 0, 400, 300);
      const source = { id: 's', kind: 'image', width: 400, height: 300, version: 1, animated: false, frame: () => c, dispose() {} };
      const mode = getMode('voronoi');
      let invalidations = 0;
      const pipe = createPipeline({ onInvalidate: () => { invalidations++; } });
      const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(mode.params), points: 12000, iterations: 30, seed: 1 } };
      const theme = { ink: '#c4f169', bg: '#15181e' };
      const t0 = performance.now();
      const first = await pipe.render({ source, mode, params, theme, time: 0 });
      const firstMs = performance.now() - t0;
      const state = pipe.getState('voronoi');
      const it0 = state.iteration;
      // wait for a couple of partial results
      for (let i = 0; i < 200 && invalidations < 2; i++) await new Promise((r) => setTimeout(r, 25));
      const midIteration = state.iteration;
      const running = heavy.stats().running;
      // change the seed while relaxing: the old job is cancelled and a new one starts
      params.mode = { ...params.mode, seed: 2, iterations: 3, points: 2000 };
      await pipe.render({ source, mode, params, theme, time: 0 });
      const cancelled = state.cancelled;
      for (let i = 0; i < 400 && !state.done; i++) await new Promise((r) => setTimeout(r, 25));
      await pipe.render({ source, mode, params, theme, time: 0 });
      return {
        firstMs, it0, midIteration, running, cancelled, done: state.done, finalIteration: state.iteration,
        points: state.points.length / 2, rows: first.meta.rows, invalidations, pending: heavy.stats().pending,
      };
    });
    expect(res.firstMs).toBeLessThan(1500); // the job runs in the background
    expect(res.it0).toBe(0);
    expect(res.rows).toBe(0);
    expect(res.midIteration).toBeGreaterThan(0);
    expect(res.running).toBe(1);
    expect(res.cancelled).toBe(1);
    expect(res.done).toBe(true);
    expect(res.finalIteration).toBe(3);
    expect(res.points).toBe(2000);
    expect(res.pending).toBe(0);
  });

  test('in the studio the relaxation animates, then the loop goes idle; SVG export works', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="voronoi"]').click();
    await waitForCanvasData(page, 'rows', 15); // all Lloyd iterations shown
    const frames = (await renderCount(page)) - before;
    expect(frames).toBeGreaterThanOrEqual(5);
    const idle = await settle(page, 300);
    await page.waitForTimeout(500);
    expect(await renderCount(page)).toBe(idle);
    await expect(page.locator('#viewer-busy')).toBeHidden();
    const { name, bytes } = await captureDownload(page, () => page.click('[data-export="svg"]'));
    expect(name).toMatch(/^dither-voronoi-.*\.svg$/);
    const svg = bytes.toString('utf8');
    expect((svg.match(/<circle /g) || []).length).toBe(5000);
    await guard.assertClean(expect);
  });
});
