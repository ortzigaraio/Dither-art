// Vector geometry shared by the VECTOR modes (PLAN.md 7.14-7.20) and the SVG exporter. No DOM, no dependencies.
//
// A polyline is { points: Float32Array [x0, y0, x1, y1, ...], closed: boolean } (plus any extra attributes, such as
// width or color, which the functions below carry along untouched).
//
// - marchingSquares(): iso-lines of a scalar field, with the segments of every cell joined into polylines
// - chaikin(): corner-cutting smoothing (Chaikin 1974); open lines keep their end points
// - simplify(): Ramer-Douglas-Peucker
// - clipPolylineByField(): split a polyline into the runs where a predicate on the field holds (hatching)
// - clipLineToRect(): Liang-Barsky
// - orderStrokes(): plotter path ordering, greedy nearest neighbour with reversal, joining coincident end points

// ---------------------------------------------------------------------------
// Marching squares
// ---------------------------------------------------------------------------

// For each of the 16 cases, the cell edges joined by a segment: 0 top, 1 right, 2 bottom, 3 left.
// Corner bits: top-left 8, top-right 4, bottom-right 2, bottom-left 1 (bit set = value >= level).
// Cases 5 and 10 are saddles: resolved with the mean of the four corners (index 16/17 = "centre above").
const CASES = [
  [], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], null, [[0, 2]], [[3, 0]],
  [[3, 0]], [[0, 2]], null, [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], [],
];
const SADDLE = {
  5: { above: [[3, 0], [2, 1]], below: [[0, 1], [3, 2]] },
  10: { above: [[0, 1], [3, 2]], below: [[3, 0], [2, 1]] },
};

/**
 * Iso-lines of `field` (w x h samples, row-major) at `level`. Sample (x, y) sits at coordinates (x, y).
 * @param {object} [opts]
 * @param {boolean} [opts.closed=false]  pad the field with -Infinity so every line closes along the border
 *   (needed to fill the region `field >= level`; lines that run along the border then sit on the outer samples)
 * @returns {{points: Float32Array, closed: boolean}[]}
 */
export function marchingSquares(field, w, h, level, opts = {}) {
  const closed = !!opts.closed;
  const pad = closed ? 1 : 0;
  const W2 = w + 2; // stride of the padded node grid
  const B = scratchFor(2 * W2 * (h + 2));
  const stamp = ++B.call;
  const { ex, ey, seen, adj0, adj1 } = B;
  let segA = B.segA;
  let segB = B.segB;
  let nseg = 0;
  const NEG = -Infinity;

  // edge key: horizontal edge (x, y)-(x+1, y) -> 2*node(x, y); vertical edge (x, y)-(x, y+1) -> 2*node(x, y)+1
  const addPoint = (key, ax, ay, bx, by, va, vb) => {
    if (seen[key] === stamp) return;
    seen[key] = stamp;
    adj0[key] = -1;
    adj1[key] = -1;
    let t;
    if (va === NEG) t = 1;
    else if (vb === NEG) t = 0;
    else t = va === vb ? 0.5 : (level - va) / (vb - va);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let x = ax + (bx - ax) * t;
    let y = ay + (by - ay) * t;
    if (closed) { x = x < 0 ? 0 : x > w - 1 ? w - 1 : x; y = y < 0 ? 0 : y > h - 1 ? h - 1 : y; }
    ex[key] = x;
    ey[key] = y;
  };
  const link = (key, s) => { if (adj0[key] < 0) adj0[key] = s; else adj1[key] = s; };

  for (let y = -pad; y < h - 1 + pad; y++) {
    for (let x = -pad; x < w - 1 + pad; x++) {
      let tl, tr, br, bl;
      if (x >= 0 && y >= 0 && x + 1 < w && y + 1 < h) {
        const i = y * w + x;
        tl = field[i]; tr = field[i + 1]; bl = field[i + w]; br = field[i + w + 1];
      } else {
        const inX0 = x >= 0, inX1 = x + 1 < w, inY0 = y >= 0, inY1 = y + 1 < h;
        tl = inX0 && inY0 ? field[y * w + x] : NEG;
        tr = inX1 && inY0 ? field[y * w + x + 1] : NEG;
        bl = inX0 && inY1 ? field[(y + 1) * w + x] : NEG;
        br = inX1 && inY1 ? field[(y + 1) * w + x + 1] : NEG;
      }
      const c = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (c === 0 || c === 15) continue;
      let segs = CASES[c];
      if (!segs) {
        let sum = 0;
        for (const v of [tl, tr, br, bl]) if (v !== NEG) sum += v;
        segs = sum / 4 >= level ? SADDLE[c].above : SADDLE[c].below;
      }
      const n0 = (y + 1) * W2 + (x + 1);
      const n1 = n0 + W2; // node (x, y+1)
      for (let q = 0; q < segs.length; q++) {
        const pair = segs[q];
        if (nseg >= segA.length) { const grow = (arr) => { const z = new Int32Array(arr.length * 2); z.set(arr); return z; }; segA = B.segA = grow(segA); segB = B.segB = grow(segB); }
        for (let e = 0; e < 2; e++) {
          const edge = pair[e];
          let key;
          if (edge === 0) { key = 2 * n0; addPoint(key, x, y, x + 1, y, tl, tr); } else if (edge === 2) { key = 2 * n1; addPoint(key, x, y + 1, x + 1, y + 1, bl, br); } else if (edge === 3) { key = 2 * n0 + 1; addPoint(key, x, y, x, y + 1, tl, bl); } else { key = 2 * (n0 + 1) + 1; addPoint(key, x + 1, y, x + 1, y + 1, tr, br); }
          if (e === 0) segA[nseg] = key; else segB[nseg] = key;
          link(key, nseg);
        }
        nseg++;
      }
    }
  }
  return chainSegments(segA, segB, nseg, B);
}

const SCRATCH = { size: 0 };
/** Edge buffers reused between calls (a call stamp tells which entries belong to the current call). */
function scratchFor(size) {
  if (SCRATCH.size < size) {
    SCRATCH.size = size;
    SCRATCH.ex = new Float32Array(size);
    SCRATCH.ey = new Float32Array(size);
    SCRATCH.seen = new Int32Array(size);
    SCRATCH.adj0 = new Int32Array(size);
    SCRATCH.adj1 = new Int32Array(size);
    SCRATCH.used = new Uint8Array(0);
    SCRATCH.call = 0;
  }
  if (!SCRATCH.segA) { SCRATCH.segA = new Int32Array(4096); SCRATCH.segB = new Int32Array(4096); }
  if (SCRATCH.call > 2e9) { SCRATCH.seen.fill(0); SCRATCH.call = 0; }
  return SCRATCH;
}

/** Join segments that share an edge key into polylines (each key is used by at most two segments). */
function chainSegments(segA, segB, n, B) {
  const { ex, ey, adj0, adj1 } = B;
  const used = new Uint8Array(n);
  const out = [];
  const other = (key, s) => (adj0[key] === s ? adj1[key] : adj0[key]);
  // follow segments from `key` (the free end of segment `s`), appending the keys visited to `keys`
  const walk = (s, key, keys) => {
    let prev = s;
    for (;;) {
      const next = other(key, prev);
      if (next < 0 || used[next]) break;
      used[next] = 1;
      key = segA[next] === key ? segB[next] : segA[next];
      keys.push(key);
      prev = next;
    }
  };
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const fwd = [];
    walk(s, segB[s], fwd);
    let keys;
    let closed = false;
    if (fwd.length && fwd[fwd.length - 1] === segA[s]) {
      closed = true;
      fwd.pop();
      keys = [segA[s], segB[s], ...fwd];
    } else {
      const back = [];
      walk(s, segA[s], back);
      back.reverse();
      keys = [...back, segA[s], segB[s], ...fwd];
    }
    const pts = new Float32Array(keys.length * 2);
    for (let i = 0; i < keys.length; i++) { pts[i * 2] = ex[keys[i]]; pts[i * 2 + 1] = ey[keys[i]]; }
    out.push({ points: pts, closed });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Polyline utilities
// ---------------------------------------------------------------------------

export const pointCount = (pl) => pl.points.length >> 1;

/** Length of a polyline (closing segment included when closed). */
export function polylineLength(points, closed = false) {
  let L = 0;
  const n = points.length >> 1;
  for (let i = 1; i < n; i++) L += Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
  if (closed && n > 1) L += Math.hypot(points[0] - points[n * 2 - 2], points[1] - points[n * 2 - 1]);
  return L;
}

/**
 * Chaikin corner cutting. Each iteration replaces every segment by its 1/4 and 3/4 points.
 * Open polylines keep their first and last point exactly; closed ones stay closed.
 */
export function chaikin(points, closed = false, iterations = 1) {
  let p = points;
  for (let it = 0; it < iterations; it++) {
    const n = p.length >> 1;
    if (n < 3) return p;
    const segs = closed ? n : n - 1;
    const out = new Float32Array((closed ? segs * 2 : segs * 2 + 2) * 2 - (closed ? 0 : 4));
    let o = 0;
    if (!closed) { out[o++] = p[0]; out[o++] = p[1]; }
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
      const first = !closed && i === 0;
      const last = !closed && i === segs - 1;
      if (!first) { out[o++] = 0.75 * ax + 0.25 * bx; out[o++] = 0.75 * ay + 0.25 * by; }
      if (!last) { out[o++] = 0.25 * ax + 0.75 * bx; out[o++] = 0.25 * ay + 0.75 * by; }
    }
    if (!closed) { out[o++] = p[(n - 1) * 2]; out[o++] = p[(n - 1) * 2 + 1]; }
    p = o === out.length ? out : out.subarray(0, o);
  }
  return p;
}

/** Ramer-Douglas-Peucker simplification (iterative). Keeps the end points. */
export function simplify(points, tolerance) {
  const n = points.length >> 1;
  if (n < 3 || tolerance <= 0) return points;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    const ax = points[a * 2], ay = points[a * 2 + 1];
    const dx = points[b * 2] - ax, dy = points[b * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const px = points[i * 2] - ax, py = points[i * 2 + 1] - ay;
      let d;
      if (len2 === 0) d = px * px + py * py;
      else {
        const cr = px * dy - py * dx;
        d = (cr * cr) / len2;
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push(a, best, best, b);
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i];
  const out = new Float32Array(m * 2);
  let o = 0;
  for (let i = 0; i < n; i++) if (keep[i]) { out[o++] = points[i * 2]; out[o++] = points[i * 2 + 1]; }
  return out;
}

/**
 * RDP for ribbons (points + widths): a point is dropped only when both its position and its width are within
 * `tolerance` of the straight interpolation between the kept neighbours.
 * @returns {{points: Float32Array, widths: Float32Array}}
 */
export function simplifyRibbon(points, widths, tolerance) {
  const n = points.length >> 1;
  if (n < 3 || tolerance <= 0) return { points, widths };
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    const ax = points[a * 2], ay = points[a * 2 + 1];
    const dx = points[b * 2] - ax, dy = points[b * 2 + 1] - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let best = -1;
    let bestD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const px = points[i * 2] - ax, py = points[i * 2 + 1] - ay;
      const t = (px * dx + py * dy) / (len * len);
      const dPos = Math.abs(px * dy - py * dx) / len;
      const dW = Math.abs(widths[i] - (widths[a] + (widths[b] - widths[a]) * (t < 0 ? 0 : t > 1 ? 1 : t))) / 2;
      const d = dPos > dW ? dPos : dW;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push(a, best, best, b); }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i];
  const op = new Float32Array(m * 2);
  const ow = new Float32Array(m);
  let o = 0;
  for (let i = 0; i < n; i++) if (keep[i]) { op[o * 2] = points[i * 2]; op[o * 2 + 1] = points[i * 2 + 1]; ow[o++] = widths[i]; }
  return { points: op, widths: ow };
}

/**
 * Split a polyline into the runs where `inside(x, y)` is true ("clipping against a scalar field": the predicate is
 * usually `field(x, y) < threshold`). Boundaries are refined by bisection on the crossing segment, so runs start and
 * end where the field crosses, not at the previous sample. Runs shorter than `minLength` are dropped.
 * @returns {Float32Array[]} point arrays of the runs
 */
export function clipPolylineByField(points, inside, { minLength = 0, refine = 5 } = {}) {
  const n = points.length >> 1;
  const runs = [];
  let cur = null;
  const edge = (ax, ay, bx, by, aIn) => {
    // bisection between a sample (state aIn) and the next one (state !aIn): returns the crossing point
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < refine; k++) {
      const m = (lo + hi) / 2;
      if (inside(ax + (bx - ax) * m, ay + (by - ay) * m) === aIn) lo = m; else hi = m;
    }
    const t = aIn ? lo : hi; // the end that satisfies the predicate, so runs never poke outside
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  };
  let prevIn = false;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    const isIn = !!inside(x, y);
    if (i > 0 && isIn !== prevIn) {
      const c = refine > 0 ? edge(points[i * 2 - 2], points[i * 2 - 1], x, y, prevIn) : null;
      if (isIn) cur = c ? [c[0], c[1]] : [];
      else if (cur) {
        if (c) cur.push(c[0], c[1]);
        runs.push(cur);
        cur = null;
      }
    }
    if (isIn) {
      if (!cur) cur = [];
      cur.push(x, y);
    }
    prevIn = isIn;
  }
  if (cur) runs.push(cur);
  const out = [];
  for (const r of runs) {
    if (r.length < 4) continue;
    const pts = Float32Array.from(r);
    if (minLength > 0 && polylineLength(pts) < minLength) continue;
    out.push(pts);
  }
  return out;
}

/** Liang-Barsky: clip the segment to the rectangle. Returns [x0, y0, x1, y1] or null. */
export function clipLineToRect(x0, y0, x1, y1, xmin, ymin, xmax, ymax) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/** Parallel lines at `angle` (radians) spaced `spacing` apart covering the rectangle, clipped to it. */
export function hatchLines(width, height, angle, spacing, offset = 0) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.hypot(width, height) / 2 + spacing;
  const out = [];
  const k0 = Math.ceil((-R - offset) / spacing);
  const k1 = Math.floor((R - offset) / spacing);
  for (let k = k0; k <= k1; k++) {
    const o = k * spacing + offset;
    const px = cx + nx * o;
    const py = cy + ny * o;
    const seg = clipLineToRect(px - dx * R, py - dy * R, px + dx * R, py + dy * R, 0, 0, width, height);
    if (seg) out.push(seg);
  }
  return out;
}

/** Points every `step` along the segment (both ends included). */
export function sampleSegment(x0, y0, x1, y1, step) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(L / step));
  const out = new Float32Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out[i * 2] = x0 + (x1 - x0) * t;
    out[i * 2 + 1] = y0 + (y1 - y0) * t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stroke ordering (pen plotters)
// ---------------------------------------------------------------------------

function reversed(points) {
  const n = points.length >> 1;
  const out = new Float32Array(points.length);
  for (let i = 0; i < n; i++) { out[i * 2] = points[(n - 1 - i) * 2]; out[i * 2 + 1] = points[(n - 1 - i) * 2 + 1]; }
  return out;
}

/** Pen-up travel of a drawing order, starting from `start`. */
export function travelDistance(paths, start = [0, 0]) {
  let x = start[0];
  let y = start[1];
  let d = 0;
  for (const p of paths) {
    const pts = p.points;
    const n = pts.length >> 1;
    if (!n) continue;
    d += Math.hypot(pts[0] - x, pts[1] - y);
    if (p.closed) { x = pts[0]; y = pts[1]; } else { x = pts[(n - 1) * 2]; y = pts[(n - 1) * 2 + 1]; }
  }
  return d;
}

/**
 * Reorder strokes to reduce pen-up travel: greedy nearest neighbour over both ends of every open path (a path may
 * be reversed), using a uniform grid so it stays fast with tens of thousands of strokes. With `join`, a stroke that
 * starts where the previous one ended (within `eps`) and has the same `keyOf()` (colour, width) is appended to it.
 * Nothing is ever dropped: every input point is in the output, in some stroke.
 * @param {{points: Float32Array, closed?: boolean}[]} paths
 * @param {object} [opts]
 * @returns {object[]} new array of paths (inputs are not modified; joined or reversed paths are copies)
 */
export function orderStrokes(paths, { start = [0, 0], join = true, eps = 1e-3, keyOf = (p) => `${p.color ?? ''}|${p.width ?? ''}` } = {}) {
  const items = paths.filter((p) => p.points && p.points.length >= 2);
  const n = items.length;
  if (n === 0) return [];
  // bounding box and grid
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ends = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    const pts = items[i].points;
    const m = pts.length >> 1;
    const ax = pts[0], ay = pts[1];
    const bx = items[i].closed ? ax : pts[(m - 1) * 2];
    const by = items[i].closed ? ay : pts[(m - 1) * 2 + 1];
    ends[i * 4] = ax; ends[i * 4 + 1] = ay; ends[i * 4 + 2] = bx; ends[i * 4 + 3] = by;
    minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx);
    minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by);
  }
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const cell = Math.max(1e-6, Math.sqrt((spanX * spanY) / Math.max(1, n)) * 1.5);
  const gw = Math.max(1, Math.min(2048, Math.ceil(spanX / cell) + 1));
  const gh = Math.max(1, Math.min(2048, Math.ceil(spanY / cell) + 1));
  const cw = spanX / Math.max(1, gw - 1) || 1;
  const chh = spanY / Math.max(1, gh - 1) || 1;
  const gx = (x) => Math.max(0, Math.min(gw - 1, Math.floor((x - minX) / cw)));
  const gy = (y) => Math.max(0, Math.min(gh - 1, Math.floor((y - minY) / chh)));
  const buckets = new Map();
  const add = (cx, cy, v) => { const k = cy * gw + cx; const b = buckets.get(k); if (b) b.push(v); else buckets.set(k, [v]); };
  for (let i = 0; i < n; i++) {
    add(gx(ends[i * 4]), gy(ends[i * 4 + 1]), i * 2);
    if (!items[i].closed) add(gx(ends[i * 4 + 2]), gy(ends[i * 4 + 3]), i * 2 + 1);
  }
  const used = new Uint8Array(n);
  let remaining = n;
  let x = start[0];
  let y = start[1];
  const out = [];
  let last = null;
  let lastKey = null;

  const nearest = () => {
    const cx = gx(x);
    const cy = gy(y);
    let best = -1;
    let bestD = Infinity;
    const maxR = Math.max(gw, gh);
    for (let r = 0; r <= maxR; r++) {
      // ring r around (cx, cy)
      const ringMin = Math.max(0, (r - 1)) * Math.min(cw, chh);
      if (best >= 0 && ringMin * ringMin > bestD) break;
      for (let yy = cy - r; yy <= cy + r; yy++) {
        if (yy < 0 || yy >= gh) continue;
        const edgeRow = yy === cy - r || yy === cy + r;
        for (let xx = cx - r; xx <= cx + r; xx += edgeRow ? 1 : 2 * r || 1) {
          if (xx < 0 || xx >= gw) continue;
          const b = buckets.get(yy * gw + xx);
          if (!b) continue;
          for (let k = b.length - 1; k >= 0; k--) {
            const v = b[k];
            const i = v >> 1;
            if (used[i]) { b[k] = b[b.length - 1]; b.pop(); continue; }
            const e = v & 1;
            const dx = ends[i * 4 + e * 2] - x;
            const dy = ends[i * 4 + e * 2 + 1] - y;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = v; }
          }
        }
      }
    }
    return { v: best, d: Math.sqrt(bestD) };
  };

  while (remaining > 0) {
    const { v, d } = nearest();
    if (v < 0) break; // cannot happen while remaining > 0, but never loop forever
    const i = v >> 1;
    used[i] = 1;
    remaining--;
    const src = items[i];
    const pts = (v & 1) ? reversed(src.points) : src.points;
    const key = keyOf(src);
    if (join && last && !last.closed && !src.closed && d <= eps && key === lastKey) {
      // append, dropping the duplicated junction point
      const merged = new Float32Array(last.points.length + pts.length - 2);
      merged.set(last.points, 0);
      merged.set(pts.subarray(2), last.points.length);
      last.points = merged;
    } else {
      last = { ...src, points: pts === src.points ? src.points : pts };
      lastKey = key;
      out.push(last);
    }
    const m = pts.length >> 1;
    if (src.closed) { x = pts[0]; y = pts[1]; } else { x = pts[(m - 1) * 2]; y = pts[(m - 1) * 2 + 1]; }
  }
  return out;
}
