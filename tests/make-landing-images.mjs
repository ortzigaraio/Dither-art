// Generates the landing-page art in assets/landing/ from the owner's pictures in assets/source/, with Dither's own
// modes (the real engine, in the preinstalled Chromium; no network):
//   remeros-lines      linear halftone, white engraved lines on electric blue (portrait, the big reveal)
//   herrero-rings      linear halftone in concentric rings on electric blue (landscape)
//   labrador-halftone  blue halftone portrait (white dots on electric blue)
//   pescado-dither     1-bit Atkinson dither over radial lines, in a checkerboard frame (square)
//   puerto-hatch       crosshatch collage: white pen lines over a blue block and black (landscape)
// The background-removed "-recorte" cut-outs are used, composed over black or blue, so no detail is spent on
// backgrounds. Each piece is written as WebP at 1600 px on the long side and at 800 px (for srcset).
// Usage: cd tests && node make-landing-images.mjs [name ...]
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRepo } from './make-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../assets/landing');
mkdirSync(outDir, { recursive: true });

export const BLUE = '#1e1eff';
export const BLACK = '#050505';
export const INK = '#f4f2ec';

// Page-side helpers: load a picture, run a mode of the engine on a canvas, compose.
const HELPERS = `
import { createPipeline } from '/src/engine/pipeline.js';
import { getMode } from '/src/modes/index.js';
import { defaultsOf, sanitizeParams } from '/src/state.js';
import { IMAGE_PARAMS } from '/src/engine/preprocess.js';
import { COLOR_PARAMS } from '/src/engine/color.js';

async function load(url) {
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob);
}
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  return c;
}
/** Draw img (or a crop of it: [sx, sy, sw, sh] in 0..1) to fit a w x h canvas over a background colour. */
// floor (0..1): lift the shadows of a cut-out (screen over a grey silhouette) so dark clothes still get a hairline
// and the figure keeps its outline against the background.
function compose(img, w, h, { bg = null, crop = null, fit = 'contain', scale = 1, dx = 0, dy = 0, floor = 0 } = {}) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  const [sx, sy, sw, sh] = crop ? [crop[0] * img.width, crop[1] * img.height, crop[2] * img.width, crop[3] * img.height] : [0, 0, img.width, img.height];
  const k = (fit === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh)) * scale;
  const box = [sx, sy, sw, sh, (w - sw * k) / 2 + dx * w, (h - sh * k) / 2 + dy * h, sw * k, sh * k];
  g.imageSmoothingQuality = 'high';
  if (floor > 0) {
    const m = canvas(w, h);
    const mg = m.getContext('2d');
    mg.drawImage(img, ...box);
    mg.globalCompositeOperation = 'source-in';
    const v = Math.round(floor * 255);
    mg.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
    mg.fillRect(0, 0, w, h);
    g.drawImage(m, 0, 0);
    g.globalCompositeOperation = 'screen';
  }
  g.drawImage(img, ...box);
  g.globalCompositeOperation = 'source-over';
  return c;
}
async function run(modeId, src, look = {}, outScale = 1) {
  const mode = getMode(modeId);
  const preset = look.preset ? (mode.presets || []).find((p) => p.id === look.preset) : null;
  const params = {
    global: sanitizeParams(IMAGE_PARAMS, { ...defaultsOf(IMAGE_PARAMS), ...(look.global || {}) }),
    color: sanitizeParams(COLOR_PARAMS, { ...defaultsOf(COLOR_PARAMS), ...(look.color || {}) }),
    depth: {}, postfx: {},
    mode: sanitizeParams(mode.params, { ...defaultsOf(mode.params), ...(preset?.mode || {}), ...(look.mode || {}) }),
  };
  const source = { id: 'landing-' + Math.random(), kind: 'image', width: src.width, height: src.height, version: 1, animated: false, frame: () => src, dispose() {} };
  const pipe = createPipeline();
  const r = await pipe.render({ source, mode, params, time: 0, quality: 'full', isExport: true, outScale, theme: { ink: '#f4f2ec', bg: '#050505' } });
  if (r.error || !r.canvas) throw new Error(modeId + ': ' + (r.error || 'no canvas'));
  const out = canvas(r.width, r.height);
  out.getContext('2d').drawImage(r.canvas, 0, 0);
  pipe.dispose();
  return out;
}
/** Resize to w x h (smooth, or nearest for pixel art). */
function resize(src, w, h, smooth = true) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return c;
}
/** Map a grey picture to two colours: black -> dark, white -> light (in place). */
function duotone(c, dark, light) {
  const hx = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [d, l] = [hx(dark), hx(light)];
  const g = c.getContext('2d');
  const im = g.getImageData(0, 0, c.width, c.height);
  const a = im.data;
  for (let i = 0; i < a.length; i += 4) {
    const t = (0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2]) / 255;
    a[i] = d[0] + (l[0] - d[0]) * t; a[i + 1] = d[1] + (l[1] - d[1]) * t; a[i + 2] = d[2] + (l[2] - d[2]) * t; a[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}
window.__landing = { load, canvas, compose, run, resize, duotone };
window.__landingReady = true;
`;

/** Each piece returns { canvas, smooth } inside the page (the long side is 1600). */
const PIECES = {
  'remeros-lines': async ({ BLUE, INK }) => {
    const L = window.__landing;
    const img = await L.load('/assets/source/remeros-recorte.webp');
    const src = L.compose(img, 1120, 1600, { bg: '#000000', crop: [0.04, 0.17, 0.92, 0.83], fit: 'cover', scale: 1.0, floor: 0.16 });
    const out = await L.run('linehalftone', src, {
      global: { contrast: 125, grayscale: 100 },
      mode: { pattern: 'lines', angle: 0, spacing: 5.5, wave: 0.08, waveLength: 220, follow: 0.45, minWidth: 0, maxWidth: 1, smooth: 0, gamma: 1.1, ink: INK, paper: BLUE },
    }, 1.6);
    return { canvas: L.resize(out, 1120, 1600), smooth: true };
  },
  'herrero-rings': async ({ BLUE, INK }) => {
    const L = window.__landing;
    const img = await L.load('/assets/source/herrero-recorte.webp');
    const src = L.compose(img, 1600, 1232, { bg: '#000000', crop: [0.06, 0.03, 0.88, 0.95], fit: 'contain', scale: 1.0, dy: 0.01, floor: 0.16 });
    const out = await L.run('linehalftone', src, {
      global: { contrast: 125, grayscale: 100 },
      mode: { pattern: 'circles', centerX: 0.5, centerY: 0.4, spacing: 5.5, wave: 0, follow: 0.35, minWidth: 0, maxWidth: 1, smooth: 0, gamma: 1, ink: INK, paper: BLUE },
    }, 1.6);
    return { canvas: L.resize(out, 1600, 1232), smooth: true };
  },
  'labrador-halftone': async ({ BLUE, INK }) => {
    const L = window.__landing;
    const img = await L.load('/assets/source/labradores-recorte.webp');
    // the man with crossed arms, right of the cut-out
    const src = L.compose(img, 1000, 1400, { bg: '#000000', crop: [0.5, 0.0, 0.44, 1], fit: 'cover', scale: 1.0, dy: 0.04 });
    // black ink on white paper, inverted (dots where the picture is bright), then recoloured: ink dots on blue
    const out = await L.run('halftone', src, {
      global: { contrast: 118 },
      mode: { halftoneMode: 'mono', cellSize: 10, angle: 45, shape: 'circle', dotGain: 1.0, invert: true, jitter: 0, ink: '#000000', paper: '#ffffff' },
    }, 1);
    return { canvas: L.duotone(L.resize(out, 1143, 1600), INK, BLUE), smooth: true };
  },
  'pescado-dither': async ({ INK }) => {
    const L = window.__landing;
    const S = 1600;
    const FRAME = 96;       // checkerboard band
    const SQ = 48;          // its squares
    const inner = S - FRAME * 2;
    const img = await L.load('/assets/source/pescado-recorte.webp');
    // inner picture: radial rays behind the figures, then the dither
    const base = L.canvas(inner, inner);
    const g = base.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, inner, inner);
    const cx = inner * 0.5;
    const cy = inner * 0.36;
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = 2.2;
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * 60, cy + Math.sin(a) * 60);
      g.lineTo(cx + Math.cos(a) * inner * 1.2, cy + Math.sin(a) * inner * 1.2);
      g.stroke();
    }
    g.drawImage(L.compose(img, inner, inner, { fit: 'contain', scale: 1.04, dy: 0.03 }), 0, 0);
    const dith = await L.run('dither1bit', base, {
      global: { contrast: 120, cols: 200 },
      mode: { algorithm: 'atkinson', pixelSize: 4, levels: 2, tone: 'custom', darkColor: '#050505', lightColor: INK },
    }, 1);
    const out = L.canvas(S, S);
    const o = out.getContext('2d');
    o.fillStyle = '#050505';
    o.fillRect(0, 0, S, S);
    o.fillStyle = INK;
    for (let y = 0; y < S; y += SQ) {
      for (let x = 0; x < S; x += SQ) {
        const inBand = x < FRAME || y < FRAME || x >= S - FRAME || y >= S - FRAME;
        if (inBand && ((x / SQ + y / SQ) % 2 === 0)) o.fillRect(x, y, SQ, SQ);
      }
    }
    o.imageSmoothingEnabled = false;
    o.drawImage(dith, FRAME, FRAME, inner, inner);
    return { canvas: out, smooth: false };
  },
  'puerto-hatch': async ({ BLUE, INK }) => {
    const L = window.__landing;
    const W = 1600;
    const H = 1184;
    const img = await L.load('/assets/source/puerto-pescadores-recorte.webp');
    // the two men carrying the oar
    const box = { crop: [0, 0.22, 0.6, 0.78], fit: 'contain', scale: 0.9, dx: 0.02, dy: 0.04 };
    const look = (ink, paper) => ({
      global: { contrast: 108, brightness: 118 },
      mode: { style: 'hatch', layers: 3, spacing: 5.4, baseAngle: 45, angleStep: 60, strokeWidth: 1, wobble: 0.15, minSegment: 1.5, gamma: 1.2, ink, paper },
    });
    // the same drawing twice: a negative in white pen (ink where the picture is light) and a positive in black pen
    const neg = await L.run('crosshatch', L.compose(img, W, H, { bg: '#000000', ...box }), look('#ffffff', '#000000'), 1.6);
    const pos = await L.run('crosshatch', L.compose(img, W, H, { bg: '#ffffff', ...box }), look('#050505', '#ffffff'), 1.6);
    // collage: a blue panel with the negative, a paper panel with the positive, split through the figures
    const out = L.canvas(W, H);
    const o = out.getContext('2d');
    o.fillStyle = '#050505';
    o.fillRect(0, 0, W, H);
    const x0 = W * 0.05, x1 = W * 0.95, y0 = H * 0.07, y1 = H * 0.93, mid = W * 0.47;
    const panel = (x, w, fill, art, op) => {
      o.save();
      o.beginPath();
      o.rect(x, y0, w, y1 - y0);
      o.clip();
      o.fillStyle = fill;
      o.fillRect(x, y0, w, y1 - y0);
      o.globalCompositeOperation = op;
      o.drawImage(art, 0, 0, W, H);
      o.restore();
    };
    panel(x0, mid - x0, BLUE, neg, 'screen');
    panel(mid, x1 - mid, INK, pos, 'multiply');
    return { canvas: out, smooth: true };
  },
};

const only = process.argv.slice(2);
const server = await serveRepo();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
let total = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(`${base}/tests/blank.html`);
  await page.addScriptTag({ type: 'module', content: HELPERS });
  await page.waitForFunction(() => window.__landingReady === true);
  for (const [name, fn] of Object.entries(PIECES)) {
    if (only.length && !only.includes(name)) continue;
    const files = await page.evaluate(async ({ src, consts }) => {
      // eslint-disable-next-line no-new-func -- dev script, our own source
      const piece = (0, eval)(`(${src})`);
      const { canvas, smooth } = await piece(consts);
      const L = window.__landing;
      const long = Math.max(canvas.width, canvas.height);
      const out = [];
      for (const size of [1600, 800]) {
        const k = size / long;
        const c = k === 1 ? canvas : L.resize(canvas, Math.round(canvas.width * k), Math.round(canvas.height * k), smooth);
        out.push({ size, w: c.width, h: c.height, url: c.toDataURL('image/webp', size === 1600 ? 0.8 : 0.82) });
      }
      return out;
    }, { src: fn.toString(), consts: { BLUE, BLACK, INK } });
    for (const f of files) {
      const file = resolve(outDir, `${name}-${f.size}.webp`);
      writeFileSync(file, Buffer.from(f.url.split(',')[1], 'base64'));
      const kb = Math.round(statSync(file).size / 1024);
      total += kb;
      console.log(`${name}-${f.size}.webp  ${f.w}x${f.h}  ${kb} KB`);
    }
  }
  console.log('total', total, 'KB');
} finally {
  await browser.close();
  server.close();
}
