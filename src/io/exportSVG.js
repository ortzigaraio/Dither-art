// SVG export of vector scenes (PLAN.md 7 VECTOR, 9.1, 18.3).
//
// A scene is what every vector mode keeps in memory and also draws on the Canvas2D preview (engine/vector.js):
//   { width, height, background, title, desc, layers: [layer] }      sizes in logical px
//   layer = { id, label, color, width, opacity?, blend?, dash?, plotter?: 'keep'|'skip'|'outline',
//             paths?:   [{ points: Float32Array, closed?, width?, color?, opacity? }],
//             shapes?:  [{ rings: Float32Array[], fill }]            filled regions, even-odd (layer.seal: a thin
//                                                                  stroke of the fill colour hides seams)
//             ribbons?: [{ points: Float32Array, widths: Float32Array }]  strokes of varying width (engraving)
//             dots?:    { x, y, r: Float32Array, count, colors?: string[] }
//             texts?:   [{ x, y, text, size, anchor?, angle?, weight?, color?, font? }]
//             image?:   { canvas, x, y, width, height } }               raster (e.g. hillshade)
//
// Options: page size in px (the logical size) or mm (A4, A3, Letter, custom) with a margin, plotter mode (strokes only:
// no background, no fills, no rasters; outlines where a layer asks for them, offset strokes instead of thick ribbons),
// Inkscape layers (<g inkscape:groupmode="layer">) and stroke ordering for pen plotters (engine/geometry.js).
// Every piece of text goes through escapeXml(); colours are validated.

import { escapeXml } from './exportText.js';
import { orderStrokes } from '../engine/geometry.js';
import { config } from '../config.js';

export const PAGES = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
  letter: { w: 215.9, h: 279.4 },
};
export const PAGE_IDS = ['px', 'a4', 'a3', 'letter', 'custom'];

const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : '#000000');
const clampN = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
const BLENDS = new Set(['multiply', 'screen', 'lighten', 'darken', 'overlay']);

/** Page geometry: size, unit, and the transform from logical px to page units (uniform scale, centred). */
export function pageGeometry(W, H, opts = {}) {
  const page = PAGE_IDS.includes(opts.page) ? opts.page : 'px';
  if (page === 'px') return { page, unit: 'px', pageW: W, pageH: H, s: 1, ox: 0, oy: 0, digits: 2 };
  let pw;
  let ph;
  if (page === 'custom') {
    pw = clampN(opts.customW, 10, 2000, 210);
    ph = clampN(opts.customH, 10, 2000, 297);
  } else {
    ({ w: pw, h: ph } = PAGES[page]);
    const landscape = opts.orientation === 'landscape' || (opts.orientation !== 'portrait' && W > H);
    if (landscape) [pw, ph] = [ph, pw];
  }
  const m = clampN(opts.margin, 0, Math.min(pw, ph) / 2 - 1, 10);
  const s = Math.min((pw - 2 * m) / W, (ph - 2 * m) / H);
  return { page, unit: 'mm', pageW: pw, pageH: ph, s, ox: (pw - W * s) / 2, oy: (ph - H * s) / 2, margin: m, digits: 3 };
}

function numFmt(digits) {
  const k = 10 ** digits;
  return (v) => {
    const r = Math.round(v * k) / k;
    return r === 0 ? '0' : String(r);
  };
}

const layerId = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';

/** Ribbon outline (left side forwards, right side backwards) as a closed point list. */
export function ribbonOutline(points, widths) {
  const n = points.length >> 1;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = points[b * 2] - points[a * 2];
    let ty = points[b * 2 + 1] - points[a * 2 + 1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    const h = widths[i] / 2;
    out[i * 2] = points[i * 2] - ty * h;
    out[i * 2 + 1] = points[i * 2 + 1] + tx * h;
    const j = 2 * n - 1 - i;
    out[j * 2] = points[i * 2] + ty * h;
    out[j * 2 + 1] = points[i * 2 + 1] - tx * h;
  }
  return out;
}

/**
 * Plotter version of a ribbon: up to 4 strokes of the pen width, side by side, each present only where the ribbon is
 * wide enough to need it (slot offsets 0, +d, -d, +2d with d = 0.9 pen widths).
 */
export function ribbonStrokes(points, widths, pen) {
  const n = points.length >> 1;
  const slots = [0, 0.9, -0.9, 1.8];
  const out = [];
  for (let j = 0; j < slots.length; j++) {
    const need = j === 0 ? 0 : (j + 0.6) * pen;
    const off = slots[j] * pen;
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (widths[i] > need && widths[i] > 0) {
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        let tx = points[b * 2] - points[a * 2];
        let ty = points[b * 2 + 1] - points[a * 2 + 1];
        const l = Math.hypot(tx, ty) || 1;
        tx /= l; ty /= l;
        if (!cur) cur = [];
        cur.push(points[i * 2] - ty * off, points[i * 2 + 1] + tx * off);
      } else if (cur) {
        if (cur.length >= 4) out.push(Float32Array.from(cur));
        cur = null;
      }
    }
    if (cur && cur.length >= 4) out.push(Float32Array.from(cur));
  }
  return out;
}

/**
 * Serialise a scene.
 * @param {object} scene
 * @param {object} [opts]
 * @param {'px'|'a4'|'a3'|'letter'|'custom'} [opts.page='px']
 * @param {'auto'|'portrait'|'landscape'} [opts.orientation='auto']
 * @param {number} [opts.margin=10]   mm
 * @param {number} [opts.customW] [opts.customH]  mm
 * @param {boolean} [opts.plotter=false]  strokes only, no fills
 * @param {boolean} [opts.optimize=true]  reorder strokes to reduce pen-up travel
 * @param {string} [opts.title]
 */
export function sceneToSVG(scene, opts = {}) {
  const W = Math.max(1, scene.width);
  const H = Math.max(1, scene.height);
  const geo = pageGeometry(W, H, opts);
  const plotter = !!opts.plotter;
  const optimize = opts.optimize !== false;
  const f = numFmt(geo.digits);
  const X = (x) => f(geo.ox + x * geo.s);
  const Y = (y) => f(geo.oy + y * geo.s);
  const S = (v) => f(v * geo.s);
  const dim = (v) => (geo.unit === 'mm' ? `${f(v)}mm` : f(v));

  const pathD = (pts, closed) => {
    const n = pts.length >> 1;
    if (!n) return '';
    let d = `M${X(pts[0])} ${Y(pts[1])}`;
    if (n > 1) {
      d += 'L';
      for (let i = 1; i < n; i++) d += `${i > 1 ? ' ' : ''}${X(pts[i * 2])} ${Y(pts[i * 2 + 1])}`;
    }
    return closed ? `${d}Z` : d;
  };

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" `
    + `width="${dim(geo.pageW)}" height="${dim(geo.pageH)}" viewBox="0 0 ${f(geo.pageW)} ${f(geo.pageH)}"${plotter ? ' fill="none"' : ''}>`);
  out.push(`<title>${escapeXml(opts.title ?? scene.title ?? config.productName)}</title>`);
  const desc = [scene.desc, plotter ? 'plotter: strokes only' : '', geo.unit === 'mm' ? `page ${f(geo.pageW)}x${f(geo.pageH)} mm` : '']
    .filter(Boolean).join(' · ');
  if (desc) out.push(`<desc>${escapeXml(desc)}</desc>`);

  if (!plotter && scene.background) {
    out.push(`<g id="background" inkscape:groupmode="layer" inkscape:label="Background">`
      + `<rect x="0" y="0" width="${f(geo.pageW)}" height="${f(geo.pageH)}" fill="${safeColor(scene.background)}"/></g>`);
  }

  const used = new Set(['background']);
  for (const L of scene.layers || []) {
    const mode = L.plotter || 'keep';
    if (plotter && mode === 'skip') continue;
    let id = layerId(L.id || L.label);
    while (used.has(id)) id += '-2';
    used.add(id);
    const color = safeColor(L.color);
    const width = L.width ?? 1;
    const attrs = [
      `id="${escapeXml(id)}"`, 'inkscape:groupmode="layer"', `inkscape:label="${escapeXml(L.label || id)}"`,
      'fill="none"', `stroke="${color}"`, `stroke-width="${S(width)}"`, 'stroke-linecap="round"', 'stroke-linejoin="round"',
    ];
    if (L.opacity != null && L.opacity < 1) attrs.push(`opacity="${numFmt(3)(Math.max(0, L.opacity))}"`);
    if (L.dash && L.dash.length) attrs.push(`stroke-dasharray="${L.dash.map((v) => S(v)).join(' ')}"`);
    if (!plotter && L.blend && BLENDS.has(L.blend)) attrs.push(`style="mix-blend-mode:${L.blend}"`);
    const body = [];

    // raster
    if (!plotter && L.image?.canvas) {
      let href = '';
      try { href = L.image.canvas.toDataURL('image/png'); } catch { href = ''; }
      if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(href)) {
        const im = L.image;
        body.push(`<image x="${X(im.x)}" y="${Y(im.y)}" width="${S(im.width)}" height="${S(im.height)}" preserveAspectRatio="none" href="${href}" xlink:href="${href}"/>`);
      }
    }

    // filled regions
    for (const sh of L.shapes || []) {
      const d = sh.rings.map((r) => pathD(r, true)).join('');
      if (!d) continue;
      const fc = safeColor(sh.fill ?? L.color);
      if (!plotter) body.push(`<path d="${d}" fill="${fc}" fill-rule="evenodd" ${L.seal ? `stroke="${fc}" stroke-width="${S(L.seal)}"` : 'stroke="none"'}/>`);
      else if (mode === 'outline') body.push(`<path d="${d}"/>`);
    }

    // ribbons (variable width)
    if (L.ribbons?.length) {
      if (!plotter) {
        const d = L.ribbons.map((r) => pathD(ribbonOutline(r.points, r.widths), true)).join('');
        if (d) body.push(`<path d="${d}" fill="${color}" stroke="none"/>`);
      } else {
        let strokes = [];
        for (const r of L.ribbons) for (const p of ribbonStrokes(r.points, r.widths, width)) strokes.push({ points: p, closed: false });
        if (optimize) strokes = orderStrokes(strokes);
        chunked(strokes.map((p) => pathD(p.points, false)), body);
      }
    }

    // strokes
    if (L.paths?.length) {
      let paths = L.paths.filter((p) => p.points && p.points.length >= 4);
      if (optimize) paths = orderStrokes(paths);
      // runs of paths with the layer's own style share one <path>; others get their attributes
      let run = [];
      const flush = () => { if (run.length) { chunked(run, body); run = []; } };
      for (const p of paths) {
        const d = pathD(p.points, !!p.closed);
        const own = (p.color && safeColor(p.color) !== color) || (p.width != null && p.width !== width) || (p.opacity != null && p.opacity < 1);
        if (!own) { run.push(d); continue; }
        flush();
        const a = [];
        if (p.color) a.push(`stroke="${safeColor(p.color)}"`);
        if (p.width != null) a.push(`stroke-width="${S(p.width)}"`);
        if (p.opacity != null && p.opacity < 1) a.push(`stroke-opacity="${numFmt(3)(Math.max(0, p.opacity))}"`);
        body.push(`<path d="${d}" ${a.join(' ')}/>`);
      }
      flush();
    }

    // dots
    if (L.dots?.count) {
      const D = L.dots;
      let order = null;
      if (optimize && plotter) {
        const pts = [];
        for (let i = 0; i < D.count; i++) pts.push({ points: new Float32Array([D.x[i], D.y[i]]), closed: true, i });
        order = orderStrokes(pts, { join: false }).map((p) => p.i);
      }
      const items = [];
      for (let k = 0; k < D.count; k++) {
        const i = order ? order[k] : k;
        const fill = plotter ? '' : ` fill="${safeColor(D.colors ? D.colors[i] : L.color)}"`;
        items.push(`<circle cx="${X(D.x[i])}" cy="${Y(D.y[i])}" r="${S(D.r[i])}"${fill}${plotter ? '' : ' stroke="none"'}/>`);
      }
      body.push(items.join('\n'));
    }

    // text (labels, title block)
    for (const tx of L.texts || []) {
      const anchor = ['start', 'middle', 'end'].includes(tx.anchor) ? tx.anchor : 'start';
      const size = S(tx.size || 10);
      const rot = tx.angle ? ` transform="rotate(${f(tx.angle)} ${X(tx.x)} ${Y(tx.y)})"` : '';
      const weight = Number.isFinite(tx.weight) ? ` font-weight="${Math.round(tx.weight)}"` : '';
      const fam = escapeXml(tx.font || '"Geist Mono", "DejaVu Sans Mono", monospace');
      const paint = plotter
        ? ` fill="none" stroke="${safeColor(tx.color || L.color)}" stroke-width="${S(Math.max(0.2, (tx.size || 10) * 0.06))}"`
        : ` fill="${safeColor(tx.color || L.color)}" stroke="none"`;
      body.push(`<text x="${X(tx.x)}" y="${Y(tx.y)}" font-size="${size}" font-family="${fam}" text-anchor="${anchor}"${weight}${rot}${paint}>${escapeXml(tx.text)}</text>`);
    }

    if (body.length) out.push(`<g ${attrs.join(' ')}>\n${body.join('\n')}\n</g>`);
  }
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

/** Many sub-paths per <path> element (smaller files), at most ~400 per element so editors stay responsive. */
function chunked(ds, body) {
  for (let i = 0; i < ds.length; i += 400) body.push(`<path d="${ds.slice(i, i + 400).join('')}"/>`);
}
