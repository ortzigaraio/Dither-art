import { test, expect } from '@playwright/test';
import { watchPage } from './helpers.js';

// engine/geometry.js (PLAN.md 7 VECTOR): marching squares, Chaikin, clipping against a field, stroke ordering.
// Everything runs inside the page, on the same modules the app uses.

test.describe('geometry', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/tests/blank.html');
  });

  test('marching squares: a circle gives one closed loop of the right length', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const G = await import('/src/engine/geometry.js');
      const w = 120, h = 100, cx = 58.3, cy = 47.6, R = 31;
      const field = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) field[y * w + x] = R - Math.hypot(x - cx, y - cy); // >= 0 inside
      const lines = G.marchingSquares(field, w, h, 0);
      const padded = G.marchingSquares(field, w, h, 0, { closed: true });
      const l = lines[0];
      const n = l.points.length / 2;
      let maxErr = 0;
      for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(Math.hypot(l.points[i * 2] - cx, l.points[i * 2 + 1] - cy) - R));
      // a disc cut by the border: open without padding, closed with it
      const f2 = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f2[y * w + x] = 40 - Math.hypot(x - 5, y - 50);
      const cutOpen = G.marchingSquares(f2, w, h, 0);
      const cutClosed = G.marchingSquares(f2, w, h, 0, { closed: true });
      // two separate blobs give two loops
      const f3 = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f3[y * w + x] = Math.max(12 - Math.hypot(x - 30, y - 50), 12 - Math.hypot(x - 90, y - 50));
      const two = G.marchingSquares(f3, w, h, 0);
      return {
        count: lines.length, closed: l.closed, length: G.polylineLength(l.points, true), expected: 2 * Math.PI * R, maxErr,
        paddedCount: padded.length, paddedClosed: padded[0].closed,
        cutOpen: cutOpen.map((c) => c.closed), cutClosed: cutClosed.map((c) => c.closed),
        two: two.map((c) => c.closed),
      };
    });
    expect(res.count).toBe(1);
    expect(res.closed).toBe(true);
    expect(Math.abs(res.length - res.expected) / res.expected).toBeLessThan(0.01);
    expect(res.maxErr).toBeLessThan(0.1);
    expect(res.paddedCount).toBe(1);
    expect(res.paddedClosed).toBe(true);
    expect(res.cutOpen).toEqual([false]);
    expect(res.cutClosed).toEqual([true]);
    expect(res.two).toEqual([true, true]);
  });

  test('marching squares resolves saddles without crossing lines', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const G = await import('/src/engine/geometry.js');
      // checkerboard 2x2 of values: a saddle in the middle cell; both resolutions must give two separate lines
      const run = (centreHigh) => {
        const w = 3, h = 3;
        const f = Float32Array.from(centreHigh ? [1, 0, 1, 0, 1, 0, 1, 0, 1] : [1, 0, 1, 0, 0, 0, 1, 0, 1]);
        return G.marchingSquares(f, w, h, 0.5).map((l) => l.points.length / 2);
      };
      return { high: run(true), low: run(false) };
    });
    expect(res.high.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(res.low.length).toBe(4); // four corner caps around a low centre
    expect(res.low.every((n) => n === 2)).toBe(true);
  });

  test('Chaikin keeps the end points of open lines and keeps closed lines closed', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const G = await import('/src/engine/geometry.js');
      const open = new Float32Array([0, 0, 10, 0, 10, 10, 20, 10, 25, 3]);
      const out = [];
      for (let it = 0; it <= 4; it++) {
        const s = G.chaikin(open, false, it);
        const n = s.length / 2;
        out.push({ it, first: [s[0], s[1]], last: [s[(n - 1) * 2], s[(n - 1) * 2 + 1]], n });
      }
      const square = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);
      const sq = G.chaikin(square, true, 2);
      let minR = Infinity, maxR = 0;
      for (let i = 0; i < sq.length / 2; i++) { const r = Math.hypot(sq[i * 2] - 5, sq[i * 2 + 1] - 5); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
      return { out, sqPoints: sq.length / 2, minR, maxR, two: Array.from(G.chaikin(new Float32Array([1, 2, 3, 4]), false, 3)) };
    });
    for (const r of res.out) {
      expect(r.first, `iteration ${r.it}`).toEqual([0, 0]);
      expect(r.last, `iteration ${r.it}`).toEqual([25, 3]);
    }
    expect(res.out.map((r) => r.n)).toEqual([5, 8, 14, 26, 50]);
    expect(res.sqPoints).toBe(16); // 4 -> 8 -> 16
    expect(res.maxR).toBeLessThan(Math.hypot(5, 5)); // corners are cut
    expect(res.minR).toBeGreaterThan(3.5);
    expect(res.two).toEqual([1, 2, 3, 4]); // a single segment cannot be smoothed
  });

  test('clipping against a scalar field finds the crossings', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const G = await import('/src/engine/geometry.js');
      const line = G.sampleSegment(0, 5, 100, 5, 1);
      const inside = (x) => (x > 30.25 && x < 70.6) || (x > 90 && x < 91.5);
      const runs = G.clipPolylineByField(line, inside, { refine: 8 });
      const long = G.clipPolylineByField(line, inside, { refine: 8, minLength: 3 });
      const rect = G.clipLineToRect(-10, -10, 110, 110, 0, 0, 100, 50);
      const miss = G.clipLineToRect(-10, 60, 110, 60, 0, 0, 100, 50);
      return { runs: runs.map((r) => [r[0], r[r.length - 2]]), long: long.length, rect, miss };
    });
    expect(res.runs).toHaveLength(2);
    expect(res.runs[0][0]).toBeCloseTo(30.25, 1);
    expect(res.runs[0][1]).toBeCloseTo(70.6, 1);
    expect(res.long).toBe(1); // the 1.5 px run is shorter than minLength
    expect(res.rect.map((v) => Math.round(v))).toEqual([0, 0, 50, 50]);
    expect(res.miss).toBeNull();
  });

  test('stroke ordering reduces pen-up travel, never loses a segment and joins coincident ends', async ({ page }) => {
    const res = await page.evaluate(async () => {
      const G = await import('/src/engine/geometry.js');
      const { rng } = await import('/src/engine/rand.js');
      const r = rng(1234);
      const paths = [];
      for (let i = 0; i < 2000; i++) {
        const x = r() * 1000, y = r() * 700, a = r() * Math.PI * 2, l = 2 + r() * 20;
        paths.push({ points: new Float32Array([x, y, x + Math.cos(a) * l, y + Math.sin(a) * l]), closed: false });
      }
      // a few closed loops too
      for (let i = 0; i < 20; i++) {
        const cx = r() * 1000, cy = r() * 700;
        paths.push({ points: new Float32Array([cx, cy, cx + 5, cy, cx + 5, cy + 5, cx, cy + 5]), closed: true });
      }
      const before = G.travelDistance(paths);
      const t0 = performance.now();
      const ordered = G.orderStrokes(paths, { join: false });
      const ms = performance.now() - t0;
      const after = G.travelDistance(ordered);
      // every segment of the input is in the output (either direction)
      const segKey = (ax, ay, bx, by) => {
        const k1 = `${ax.toFixed(3)},${ay.toFixed(3)}`, k2 = `${bx.toFixed(3)},${by.toFixed(3)}`;
        return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      };
      const segs = (list) => {
        const m = new Map();
        for (const p of list) {
          const n = p.points.length / 2;
          const count = p.closed ? n : n - 1;
          for (let i = 0; i < count; i++) {
            const j = (i + 1) % n;
            const k = segKey(p.points[i * 2], p.points[i * 2 + 1], p.points[j * 2], p.points[j * 2 + 1]);
            m.set(k, (m.get(k) || 0) + 1);
          }
        }
        return m;
      };
      const a = segs(paths), b = segs(ordered);
      let same = a.size === b.size;
      for (const [k, v] of a) if (b.get(k) !== v) same = false;
      const lenIn = paths.reduce((s, p) => s + G.polylineLength(p.points, p.closed), 0);
      const lenOut = ordered.reduce((s, p) => s + G.polylineLength(p.points, p.closed), 0);

      // a polyline cut in 12 pieces, shuffled and some reversed, comes back as one stroke
      const full = [];
      for (let i = 0; i <= 24; i++) full.push(i * 10, Math.sin(i) * 20 + 50);
      const pieces = [];
      for (let k = 0; k < 12; k++) {
        let pts = full.slice(k * 4, k * 4 + 6);
        if (k % 3 === 1) { const rev = []; for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]); pts = rev; }
        pieces.push({ points: new Float32Array(pts), closed: false, color: '#000000' });
      }
      pieces.sort((p, q) => (p.points[1] * 7919) % 13 - (q.points[1] * 7919) % 13);
      const joined = G.orderStrokes(pieces, { start: [0, Math.sin(0) * 20 + 50] });
      // different colours are never joined
      const mixed = G.orderStrokes([
        { points: new Float32Array([0, 0, 10, 0]), color: '#ff0000' },
        { points: new Float32Array([10, 0, 20, 0]), color: '#0000ff' },
      ]);
      return {
        before, after, ms, same, inCount: paths.length, outCount: ordered.length, lenIn, lenOut,
        joinedCount: joined.length, joinedPoints: joined[0].points.length / 2,
        joinedEnds: [joined[0].points[0], joined[0].points[joined[0].points.length - 2]], mixed: mixed.length,
      };
    });
    expect(res.after).toBeLessThan(res.before / 4);
    expect(res.same).toBe(true);
    expect(res.outCount).toBe(res.inCount);
    expect(Math.abs(res.lenOut - res.lenIn)).toBeLessThan(1e-3 * res.lenIn);
    expect(res.ms).toBeLessThan(1500);
    expect(res.joinedCount).toBe(1);
    expect(res.joinedPoints).toBe(25);
    expect(res.joinedEnds).toEqual([0, 240]);
    expect(res.mixed).toBe(2);
  });

  test('simplify keeps the ends and removes collinear points; seeded noise is deterministic', async ({ page }) => {
    const guard = watchPage(page);
    const res = await page.evaluate(async () => {
      const G = await import('/src/engine/geometry.js');
      const { createNoise } = await import('/src/engine/noise.js');
      const line = G.sampleSegment(0, 0, 100, 50, 1);
      const s = G.simplify(line, 0.01);
      const a = createNoise(5), b = createNoise(5), c = createNoise(6);
      const vals = [];
      let range = [Infinity, -Infinity];
      for (let i = 0; i < 2000; i++) {
        const v = a.noise2(i * 0.137, i * 0.071);
        range = [Math.min(range[0], v), Math.max(range[1], v)];
        vals.push(v === b.noise2(i * 0.137, i * 0.071), a.noise3(i * 0.1, 2, i * 0.03) === b.noise3(i * 0.1, 2, i * 0.03));
      }
      return { s: Array.from(s), same: vals.every(Boolean), differs: a.noise2(3.3, 1.7) !== c.noise2(3.3, 1.7), range };
    });
    expect(res.s).toEqual([0, 0, 100, 50]);
    expect(res.same).toBe(true);
    expect(res.differs).toBe(true);
    expect(res.range[0]).toBeGreaterThan(-1.01);
    expect(res.range[1]).toBeLessThan(1.01);
    expect(res.range[1] - res.range[0]).toBeGreaterThan(1);
    await guard.assertClean(expect);
  });
});
