import { test, expect } from '@playwright/test';
import { watchPage, gotoApp, renderMode, loadFixture, renderCount, settle, setControl } from './helpers.js';

// Pixel sorting (PLAN.md 7.13): tiny synthetic pictures with hand-computed results, run through the real engine,
// the worker and the mode.

/** Run the sorter on a picture given as a list of rows of [r,g,b]; returns the output rows, the mask rows and the lines. */
async function sortRows(page, { rows, params }) {
  return page.evaluate(async (a) => {
    const { pixelSort, lineSet } = await import('/src/engine/pixelsort.js');
    const h = a.rows.length;
    const w = a.rows[0].length;
    const rgba = new Uint8ClampedArray(w * h * 4);
    a.rows.forEach((row, y) => row.forEach((c, x) => rgba.set([c[0], c[1], c[2], 255], (y * w + x) * 4)));
    const res = await pixelSort({ rgba, w, h, angle: 0, intervalMode: 'threshold', lower: 0.25, upper: 0.8, key: 'luma', order: 'asc', maxSpan: 2000, randomness: 0, seed: 1, ...a.params });
    const grid = (buf, f) => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => f(buf, y * w + x)));
    const lines = lineSet(w, h, a.params.angle ?? 0);
    const idx = new Int32Array(Math.max(w, h) + 2);
    const lineList = [];
    for (let li = 0; li < lines.count; li++) { const n = lines.fill(li, idx); lineList.push(Array.from(idx.subarray(0, n))); }
    return {
      src: grid(rgba, (b, i) => [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]]),
      out: grid(res.rgba, (b, i) => [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]]),
      mask: grid(res.mask, (b, i) => b[i]),
      lines: lineList, w, h,
    };
  }, { rows, params });
}
const gray = (v) => [v, v, v];
const grays = (...vs) => vs.map(gray);
const lumaOf = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

test.describe('pixelsort: lines (Bresenham partition)', () => {
  test('every angle partitions the picture exactly once, with unit steps and the right direction', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { lineSet } = await import('/src/engine/pixelsort.js');
      const w = 13, h = 9;
      const out = {};
      for (const angle of [0, 90, 180, 270, 45, 135, 225, 315, 30, 200, 359, 10, 80]) {
        const L = lineSet(w, h, angle);
        const idx = new Int32Array(64);
        const seen = new Uint8Array(w * h);
        let badStep = 0, dupes = 0, total = 0;
        const dirs = new Set();
        for (let li = 0; li < L.count; li++) {
          const n = L.fill(li, idx);
          total += n;
          for (let i = 0; i < n; i++) { if (seen[idx[i]]++) dupes++; }
          for (let i = 1; i < n; i++) {
            const dx = (idx[i] % w) - (idx[i - 1] % w);
            const dy = Math.floor(idx[i] / w) - Math.floor(idx[i - 1] / w);
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) badStep++;
            dirs.add(`${Math.sign(dx)},${Math.sign(dy)}`);
          }
        }
        out[angle] = { lines: L.count, total, dupes, missing: seen.filter((v) => v === 0).length, badStep, dirs: [...dirs].sort() };
      }
      return out;
    });
    for (const [angle, r] of Object.entries(res)) {
      expect(r.total, `angle ${angle} covers every pixel`).toBe(13 * 9);
      expect(r.dupes, `angle ${angle} no pixel twice`).toBe(0);
      expect(r.missing, `angle ${angle} none left out`).toBe(0);
      expect(r.badStep, `angle ${angle} steps of one pixel`).toBe(0);
    }
    expect(res[0].lines).toBe(9); // one line per row
    expect(res[90].lines).toBe(13); // one line per column
    expect(res[0].dirs).toEqual(['1,0']); // left to right
    expect(res[180].dirs).toEqual(['-1,0']);
    expect(res[90].dirs).toEqual(['0,1']); // top to bottom (y points down)
    expect(res[270].dirs).toEqual(['0,-1']);
    expect(res[45].dirs).toEqual(['1,1']); // exact diagonal
    expect(res[225].dirs).toEqual(['-1,-1']);
  });

  test('sort keys: luma weights, hue of the primaries, saturation of a grey', async ({ page }) => {
    await gotoApp(page);
    const k = await page.evaluate(async () => {
      const { sortKeys } = await import('/src/engine/pixelsort.js');
      const px = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128], [255, 255, 0]];
      const rgba = new Uint8ClampedArray(px.flatMap((c) => [...c, 255]));
      const get = (key) => Array.from(sortKeys(rgba, px.length, key));
      return { luma: get('luma'), hue: get('hue'), sat: get('saturation'), red: get('red'), blue: get('blue') };
    });
    expect(k.luma[0]).toBeCloseTo(0.2126, 5);
    expect(k.luma[1]).toBeCloseTo(0.7152, 5);
    expect(k.luma[2]).toBeCloseTo(0.0722, 5);
    expect(k.hue[0]).toBeCloseTo(0, 6); // red 0, green 1/3, blue 2/3, yellow 1/6
    expect(k.hue[1]).toBeCloseTo(1 / 3, 6);
    expect(k.hue[2]).toBeCloseTo(2 / 3, 6);
    expect(k.hue[4]).toBeCloseTo(1 / 6, 6);
    expect(k.sat[3]).toBe(0);
    expect(k.sat[0]).toBe(1);
    expect(k.red).toEqual([1, 0, 0, 128 / 255, 1].map((v) => expect.closeTo(v, 6)));
  });
});

test.describe('pixelsort: ordering on a tiny picture', () => {
  test('threshold mode: runs inside [lower, upper] are sorted ascending, everything else is untouched', async ({ page }) => {
    await gotoApp(page);
    // luma = v / 255: 0.25 -> 63.75, 0.8 -> 204. Row: dark(10) | 150 100 200 80 | bright(250) | 120 70 | dark(5) | 190
    const row = grays(10, 150, 100, 200, 80, 250, 120, 70, 5, 190);
    const r = await sortRows(page, { rows: [row, row], params: { lower: 0.25, upper: 0.8 } });
    expect(r.out[0].map((c) => c[0])).toEqual([10, 80, 100, 150, 200, 250, 70, 120, 5, 190]);
    expect(r.out[1]).toEqual(r.out[0]);
    expect(r.mask[0]).toEqual([0, 1, 1, 1, 1, 0, 1, 1, 0, 0]); // the single pixel run (190) is not sorted: nothing to order
    // pixels outside the intervals are bit-identical
    r.mask[0].forEach((m, i) => { if (!m) expect(r.out[0][i]).toEqual(r.src[0][i]); });
  });

  test('descending order, and the key: red channel on coloured pixels (whole line)', async ({ page }) => {
    await gotoApp(page);
    const row = grays(10, 150, 100, 200, 80, 250, 120, 70);
    const desc = await sortRows(page, { rows: [row], params: { intervalMode: 'full', order: 'desc' } });
    expect(desc.out[0].map((c) => c[0])).toEqual([250, 200, 150, 120, 100, 80, 70, 10]);
    const coloured = [[200, 5, 50], [10, 250, 60], [90, 90, 90], [255, 0, 0], [0, 0, 255]];
    const byRed = await sortRows(page, { rows: [coloured], params: { intervalMode: 'full', key: 'red' } });
    expect(byRed.out[0]).toEqual([[0, 0, 255], [10, 250, 60], [90, 90, 90], [200, 5, 50], [255, 0, 0]]);
    const byBlue = await sortRows(page, { rows: [coloured], params: { intervalMode: 'full', key: 'blue' } });
    expect(byBlue.out[0].map((c) => c[2])).toEqual([0, 50, 60, 90, 255]);
    const byHue = await sortRows(page, { rows: [[[0, 0, 255], [0, 255, 0], [255, 0, 0]]], params: { intervalMode: 'full', key: 'hue' } });
    expect(byHue.out[0]).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255]]); // 0, 1/3, 2/3
  });

  test('edges mode cuts a run wherever the luma jumps by more than the threshold', async ({ page }) => {
    await gotoApp(page);
    // jumps: 10 -> 220 (0.82), 210 -> 90 (0.47) are edges; the others (<= 0.12) are not
    const row = grays(30, 20, 10, 220, 200, 210, 90, 100);
    const r = await sortRows(page, { rows: [row], params: { intervalMode: 'edges', lower: 0.25 } });
    expect(r.out[0].map((c) => c[0])).toEqual([10, 20, 30, 200, 210, 220, 90, 100]);
  });

  test('maxSpan cuts long runs: each chunk is sorted on its own', async ({ page }) => {
    await gotoApp(page);
    const row = grays(8, 7, 6, 5, 4, 3, 2, 1, 16, 15, 14, 13);
    const r = await sortRows(page, { rows: [row], params: { intervalMode: 'full', maxSpan: 4 } });
    expect(r.out[0].map((c) => c[0])).toEqual([5, 6, 7, 8, 1, 2, 3, 4, 13, 14, 15, 16]);
  });

  test('vertical and diagonal directions sort along their own lines', async ({ page }) => {
    await gotoApp(page);
    const col = [40, 90, 60, 30].map(gray);
    // a 1-wide picture: angle 90 sorts the single column top to bottom
    const v = await sortRows(page, { rows: col.map((c) => [c]), params: { angle: 90, intervalMode: 'full' } });
    expect(v.out.map((r) => r[0][0])).toEqual([30, 40, 60, 90]); // 40, 90, 60, 30 in luma order
    // 45 degrees: every diagonal line of a noisy 7x5 picture ends up monotonic in luma
    const rows = Array.from({ length: 5 }, (_, y) => Array.from({ length: 7 }, (_, x) => gray(((x * 53 + y * 97 + x * y * 31) % 251) + 2)));
    const d = await sortRows(page, { rows, params: { angle: 45, intervalMode: 'full' } });
    const lumaAt = (i) => lumaOf(d.out[Math.floor(i / d.w)][i % d.w]);
    for (const line of d.lines) for (let i = 1; i < line.length; i++) expect(lumaAt(line[i]) >= lumaAt(line[i - 1]), `diagonal ${line.join(',')}`).toBe(true);
    // and the multiset of every line is preserved
    for (const line of d.lines) {
      const a = line.map((i) => d.src[Math.floor(i / d.w)][i % d.w][0]).sort((x, y) => x - y);
      const b = line.map((i) => d.out[Math.floor(i / d.w)][i % d.w][0]).sort((x, y) => x - y);
      expect(b).toEqual(a);
    }
  });

  test('randomness 1 leaves everything alone; random mode is deterministic for a seed and changes with another', async ({ page }) => {
    await gotoApp(page);
    const rows = Array.from({ length: 6 }, (_, y) => Array.from({ length: 40 }, (_, x) => gray(((x * 37 + y * 101 + x * y * 17) % 253) + 1)));
    const none = await sortRows(page, { rows, params: { intervalMode: 'full', randomness: 1 } });
    expect(none.out).toEqual(none.src);
    expect(none.mask.flat().every((m) => m === 0)).toBe(true);
    const a = await sortRows(page, { rows, params: { intervalMode: 'random', maxSpan: 12, seed: 3 } });
    const b = await sortRows(page, { rows, params: { intervalMode: 'random', maxSpan: 12, seed: 3 } });
    const c = await sortRows(page, { rows, params: { intervalMode: 'random', maxSpan: 12, seed: 4 } });
    expect(a.out).toEqual(b.out);
    expect(a.out).not.toEqual(c.out);
    expect(a.out).not.toEqual(a.src);
  });

  test('quantise posterises after sorting, a palette snaps to its colours, the mask view shows the runs', async ({ page }) => {
    await gotoApp(page);
    const row = grays(10, 70, 130, 190, 250, 100, 20, 160);
    const q = await sortRows(page, { rows: [row], params: { intervalMode: 'full', quantizeLevels: 4 } });
    for (const c of q.out[0]) expect([0, 85, 170, 255]).toContain(c[0]);
    // sorted 10 20 70 100 130 160 190 250 -> round(v / 255 * 3) / 3 * 255 = 0 0 85 85 170 170 170 255
    expect(q.out[0].map((c) => c[0])).toEqual([0, 0, 85, 85, 170, 170, 170, 255]);
    const pal = await sortRows(page, { rows: [row], params: { intervalMode: 'full', palette: [[0, 0, 0], [255, 255, 255]] } });
    for (const c of pal.out[0]) expect([0, 255]).toContain(c[0]);
    const m = await sortRows(page, { rows: [grays(10, 150, 100, 250, 120, 70)], params: { lower: 0.25, upper: 0.8, showMask: true } });
    expect(m.out[0].map((c) => c[0])).toEqual([24, 255, 255, 24, 255, 255]);
  });
});

test.describe('pixelsort: the worker', () => {
  test('the worker and the main thread give the same bytes', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      const w = 200, h = 150;
      const mk = () => {
        const rgba = new Uint8ClampedArray(w * h * 4);
        let s = 99;
        for (let i = 0; i < w * h; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const v = (s >>> 16) & 255; rgba.set([v, (v * 3) & 255, (v * 5) & 255, 255], i * 4); }
        return rgba;
      };
      const payload = { w, h, angle: 33, intervalMode: 'threshold', lower: 0.2, upper: 0.85, key: 'hue', order: 'desc', maxSpan: 90, randomness: 0.2, seed: 8, quantizeLevels: 0 };
      const hash = (a) => { let x = 2166136261; for (let i = 0; i < a.length; i++) x = Math.imul(x ^ a[i], 16777619); return x >>> 0; };
      const viaWorker = await heavy.run('pixelSort', { ...payload, rgba: mk() });
      heavy.setForceMain(true);
      const viaMain = await heavy.run('pixelSort', { ...payload, rgba: mk() });
      heavy.setForceMain(false);
      return { w: hash(viaWorker.rgba), m: hash(viaMain.rgba), wm: hash(viaWorker.mask), mm: hash(viaMain.mask), hasWorker: heavy.stats().hasWorker };
    });
    expect(res.hasWorker).toBe(true);
    expect(res.w).toBe(res.m);
    expect(res.wm).toBe(res.mm);
  });

  test('a running sort is cancelled by its signal: progress is reported, the promise rejects with AbortError, no result arrives', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const heavy = await import('/src/engine/heavy.js');
      await heavy.run('debug.sleep', { ms: 5, steps: 1 }); // make sure the worker is up
      const terminatedBefore = heavy.stats().terminated;
      const w = 3000, h = 2000;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) { const v = (i * 2654435761) >>> 24; rgba[i * 4] = v; rgba[i * 4 + 1] = v ^ 85; rgba[i * 4 + 2] = v ^ 170; rgba[i * 4 + 3] = 255; }
      const ctl = new AbortController();
      const progress = [];
      let abortedAt = 0;
      const t0 = performance.now();
      const job = heavy.run('pixelSort', { rgba, w, h, angle: 0, intervalMode: 'full', lower: 0, upper: 1, key: 'luma', order: 'asc', maxSpan: 2000, randomness: 0, seed: 1 }, {
        signal: ctl.signal, transfer: [rgba.buffer],
        onProgress: (p) => { progress.push(p); if (progress.length === 3 && !abortedAt) { abortedAt = performance.now(); ctl.abort(); } },
      });
      let outcome;
      try { await job; outcome = 'resolved'; } catch (e) { outcome = e.name; }
      const rejectedAfter = performance.now() - abortedAt;
      // a new job after the cancel runs normally on the same (not restarted) worker
      const next = await heavy.run('debug.sleep', { ms: 10, steps: 2, echo: 'after' });
      return {
        outcome, rejectedAfter, nProgress: progress.length, increasing: progress.every((v, i) => i === 0 || v >= progress[i - 1]),
        inRange: progress.every((v) => v > 0 && v <= 1), total: performance.now() - t0, next: next.echo,
        restarted: heavy.stats().terminated - terminatedBefore, running: heavy.stats().running,
      };
    });
    expect(res.outcome).toBe('AbortError');
    expect(res.rejectedAfter).toBeLessThan(200); // immediate: the client rejects at once
    expect(res.nProgress).toBeGreaterThanOrEqual(3);
    expect(res.increasing).toBe(true);
    expect(res.inRange).toBe(true);
    expect(res.next).toBe('after');
    expect(res.restarted).toBe(0); // the task yields, so the worker acknowledged the cancel without being terminated
    expect(res.running).toBe(0);
    await guard.assertClean(expect);
  });

  test('the pipeline aborts a stale render when parameters change, and the next render is fine', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { createPipeline } = await import('/src/engine/pipeline.js');
      const { getMode } = await import('/src/modes/index.js');
      const { defaultsOf } = await import('/src/state.js');
      const { IMAGE_PARAMS } = await import('/src/engine/preprocess.js');
      const { COLOR_PARAMS } = await import('/src/engine/color.js');
      const c = document.createElement('canvas');
      c.width = 1600; c.height = 1000;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 1600, 1000);
      grad.addColorStop(0, '#102'); grad.addColorStop(0.5, '#e84'); grad.addColorStop(1, '#8fa');
      g.fillStyle = grad; g.fillRect(0, 0, 1600, 1000);
      for (let i = 0; i < 300; i++) { g.fillStyle = `hsl(${i * 37 % 360},70%,${30 + i % 50}%)`; g.fillRect((i * 97) % 1600, (i * 53) % 1000, 40 + (i % 60), 5 + (i % 30)); }
      const source = { id: 'p', kind: 'image', width: 1600, height: 1000, version: 1, animated: false, frame: () => c, dispose() {} };
      const mode = getMode('pixelsort');
      const pipe = createPipeline();
      const params = { global: defaultsOf(IMAGE_PARAMS), color: defaultsOf(COLOR_PARAMS), depth: {}, postfx: {}, mode: { ...defaultsOf(mode.params), intervalMode: 'full', maxSpan: 2000 } };
      const args = { source, mode, params, theme: { ink: '#fff', bg: '#000' }, quality: 'full' };
      const first = pipe.render(args);
      await new Promise((r) => setTimeout(r, 15));
      pipe.abortPending();
      const a = await first;
      const b = await pipe.render(args);
      return { aborted: a.aborted === true, aborted2: !!b.aborted, error: b.error ? String(b.error) : null, w: b.width, hasCanvas: !!b.canvas };
    });
    expect(res.aborted).toBe(true);
    expect(res.aborted2).toBe(false);
    expect(res.error).toBeNull();
    expect(res.hasCanvas).toBe(true);
    expect(res.w).toBe(1280);
    await guard.assertClean(expect); // an abort is not an error: nothing is logged
  });
});

test.describe('pixelsort: the mode', () => {
  const rects = [['#d02020', 0, 0, 0.3, 1], ['#20c040', 0.3, 0, 0.3, 1], ['#2040e0', 0.6, 0, 0.2, 1], ['#f0e060', 0.8, 0, 0.2, 1], ['#202020', 0.1, 0.2, 0.8, 0.2], ['#f0f0f0', 0.2, 0.6, 0.5, 0.15]];
  const base = { mode: 'pixelsort', width: 320, height: 200, rects };

  test('sorting keeps the tones of every line: same mean colour, a different picture; angle and key change the result', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    const run = (mode, extra = {}) => renderMode(page, { ...base, params: { mode: { intervalMode: 'full', maxSpan: 2000, ...mode } }, means: [[0, 0, 1, 1]], ...extra });
    const plain = await renderMode(page, { ...base, params: { mode: { randomness: 1 } }, means: [[0, 0, 1, 1]] }); // nothing sorted = the source
    const horiz = await run({ angle: 0 });
    const vert = await run({ angle: 90 });
    const hue = await run({ angle: 0, key: 'hue' });
    expect(horiz.error).toBeNull();
    expect(horiz.frames[0].hash).not.toBe(plain.frames[0].hash);
    expect(horiz.frames[0].hash).not.toBe(vert.frames[0].hash);
    expect(horiz.frames[0].hash).not.toBe(hue.frames[0].hash);
    expect(horiz.frames[0].means[0]).toBeCloseTo(plain.frames[0].means[0], 2);
    for (let c = 0; c < 3; c++) expect(horiz.frames[0].channels[c]).toBeCloseTo(plain.frames[0].channels[c], 2);
    const again = await run({ angle: 0 });
    expect(again.frames[0].hash).toBe(horiz.frames[0].hash);
    await guard.assertClean(expect);
  });

  test('show mask paints the sorted pixels white and the rest dark; quantise limits the colours; the COLOR palette snaps', async ({ page }) => {
    await gotoApp(page);
    const mask = await renderMode(page, { ...base, colors: true, params: { mode: { showMask: true, intervalMode: 'threshold', lower: 0.25, upper: 0.8 } } });
    expect(mask.frames[0].colors).toEqual(['#181818', '#ffffff']);
    const q = await renderMode(page, { ...base, colors: true, params: { mode: { intervalMode: 'full', quantize: true, quantizeLevels: 2 } } });
    expect(q.frames[0].colors.length).toBeLessThanOrEqual(8); // 2 levels per channel
    const snapped = await renderMode(page, { ...base, colors: true, params: { color: { colorMode: 'palette', palette: 'mac1bit' }, mode: { intervalMode: 'full' } } });
    expect(snapped.frames[0].colors).toEqual(['#000000', '#ffffff']);
  });

  test('a video source previews at most 640 px wide, exports use full resolution', async ({ page }) => {
    await gotoApp(page);
    const res = await page.evaluate(async () => {
      const { getMode } = await import('/src/modes/index.js');
      const m = getMode('pixelsort');
      const params = { global: { cols: 120 }, mode: {} };
      return {
        image: m.resolution(params, 1920, 1080, { isExport: false, isVideo: false }),
        video: m.resolution(params, 1920, 1080, { isExport: false, isVideo: true }),
        exportVideo: m.resolution(params, 1920, 1080, { isExport: true, isVideo: true }),
      };
    });
    expect(res.image).toEqual({ width: 1280, height: 720 });
    expect(res.video).toEqual({ width: 640, height: 360 });
    expect(res.exportVideo).toEqual({ width: 1920, height: 1080 });
  });

  test('in the studio: the mode renders the fixture and a slider change re-renders without errors', async ({ page }) => {
    const guard = watchPage(page);
    await gotoApp(page);
    await loadFixture(page);
    const before = await renderCount(page);
    await page.locator('#mode-list .mode-item[data-mode-id="pixelsort"]').click();
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, before);
    await settle(page, 350);
    const n = await renderCount(page);
    await setControl(page, 'angle', 90);
    await page.waitForFunction((b) => Number(document.getElementById('viewer-canvas').dataset.frame) > b, n);
    await settle(page, 350);
    await expect(page.locator('#chip-error')).toBeHidden();
    await guard.assertClean(expect);
  });
});
