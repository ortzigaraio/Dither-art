// Home view: the live demo (the real engine running on the procedural DemoSource, rotating through a curated
// tour of modes every 4 s)
// and the gallery of modes with lazily rendered, looping thumbnails.

import { t, tl, onLangChange } from '../i18n/i18n.js';
import { MODE_META, getLoadedMode, loadMode, modeAvailable, metaOf } from '../modes/registry.js';

const getMode = getLoadedMode; // every caller below runs once the mode is loaded
import { toastWarn } from './toast.js';
import { createPipeline } from '../engine/pipeline.js';
import { createScheduler } from '../scheduler.js';
import { IMAGE_PARAMS } from '../engine/preprocess.js';
import { COLOR_PARAMS } from '../engine/color.js';
import { GRADIENT_OPTIONS } from '../engine/glyphs.js';
import { DemoSource } from '../io/sources.js';
import { defaultsOf, sanitizeParams } from '../state.js';
import { themeOutputColors, onThemeChange } from './header.js';

const ROTATE_EVERY = 4; // seconds

/**
 * Looks the hero rotates through: a curated tour of the categories (PLAN.md 4.3), not only ASCII.
 * Each is a partial parameter set (or a curated preset of the mode), validated against the schemas.
 * Only modes that are cheap enough for a live 20 fps preview are used; GPU looks are skipped without WebGL2.
 */
const LOOKS = [
  { modeId: 'ascii', mode: { gradient: 'standard' }, global: { cols: 92 } },
  { modeId: 'dither1bit', preset: 'gameboy', mode: { pixelSize: 3 } },
  { modeId: 'braille', global: { cols: 120 } },
  { modeId: 'halftone', preset: 'cmyk', mode: { cellSize: 9 } },
  { modeId: 'matrix', preset: 'classic', global: { cols: 80 } },
  { modeId: 'thermal', preset: 'ironbow' },
  { modeId: 'raymarch', preset: 'donut', global: { cols: 96 } },
  { modeId: 'led', preset: 'amber', global: { cols: 72 } },
  { modeId: 'ascii', mode: { gradient: 'katakana' }, color: { colorMode: 'mono', ink: '#00ff41', bg: '#031205' }, global: { cols: 84, edges: 3 } },
];

/** Merge a look over the mode's curated preset (if it names one). */
function resolveLook(look) {
  const mode = getMode(look.modeId);
  const preset = look.preset ? (mode.presets || []).find((p) => p.id === look.preset) : null;
  return {
    ...look,
    presetName: preset?.name || null,
    mode: { ...(preset?.mode || {}), ...(look.mode || {}) },
    color: { ...(preset?.color || {}), ...(look.color || {}) },
    global: { ...(preset?.global || {}), ...(look.global || {}) },
  };
}

function paramsFor(modeId, partial = {}, colsOverride) {
  const mode = getMode(modeId);
  const params = {
    global: sanitizeParams(IMAGE_PARAMS, { ...defaultsOf(IMAGE_PARAMS), ...partial.global }),
    color: sanitizeParams(COLOR_PARAMS, { ...defaultsOf(COLOR_PARAMS), ...partial.color }),
    depth: {},
    postfx: {},
    mode: sanitizeParams(mode.params, { ...defaultsOf(mode.params), ...partial.mode }),
  };
  if (colsOverride) params.global.cols = colsOverride;
  return params;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const previewScale = () => Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));

/**
 * @param {{ onOpenMode: (modeId: string) => void }} hooks
 */
export function createHome({ onOpenMode }) {
  const demoFigure = document.getElementById('hero-demo');
  const demoCanvas = document.getElementById('hero-canvas');
  const demoLabel = document.getElementById('hero-demo-label');
  const modesSection = document.getElementById('modes');
  const grid = document.getElementById('mode-grid');

  let homeActive = true;
  let inView = true;
  let theme = themeOutputColors();
  let demo = null;
  let lookIndex = -1;

  const pipeline = createPipeline({ onInvalidate: () => scheduler.markDirty(), label: 'hero' });
  const dctx = demoCanvas.getContext('2d');

  // ---- hero demo ----------------------------------------------------------------------------
  // The tour: every look whose mode can run here. A look's mode is fetched about a second before its turn (modes
  // load on demand); until it has arrived the tour stays on the first look.
  const tour = LOOKS.filter((l) => modeAvailable(metaOf(l.modeId)));
  const resolved = new Map();
  const fetching = new Set();
  const prefetch = (id) => {
    if (getLoadedMode(id) || fetching.has(id)) return;
    fetching.add(id);
    loadMode(id).catch(() => fetching.delete(id)); // offline: tried again on its next turn
  };

  function labelFor(look) {
    const mode = getMode(look.modeId);
    const gradient = look.modeId === 'ascii' ? GRADIENT_OPTIONS.find((o) => o.value === look.mode?.gradient) : null;
    const extra = gradient ? tl(gradient.label) : look.presetName ? tl(look.presetName) : '';
    const parts = [tl(mode.name), extra].filter(Boolean);
    return t('hero.demoLabel', { mode: parts.join(' · ').toLowerCase() });
  }

  async function frame(now) {
    if (!demo) return;
    const still = reducedMotion();
    let idx = still ? 0 : Math.floor(now / ROTATE_EVERY) % tour.length;
    if (!still && now % ROTATE_EVERY > ROTATE_EVERY - 1.2) prefetch(tour[(idx + 1) % tour.length].modeId);
    if (!getLoadedMode(tour[idx].modeId)) {
      prefetch(tour[idx].modeId);
      idx = 0;
    }
    if (!resolved.has(idx)) resolved.set(idx, resolveLook(tour[idx]));
    const look = resolved.get(idx);
    if (idx !== lookIndex) {
      lookIndex = idx;
      demoLabel.textContent = labelFor(look);
      demoFigure.dataset.mode = look.modeId;
    }
    const mode = getMode(look.modeId);
    const result = await pipeline.render({
      source: demo,
      mode,
      params: paramsFor(look.modeId, look),
      time: still ? demo.still : now,
      quality: 'full',
      outScale: previewScale(),
      theme,
    });
    if (!result.canvas) return; // WebGL context lost: keep the last frame
    if (demoCanvas.width !== result.width || demoCanvas.height !== result.height) {
      demoCanvas.width = result.width;
      demoCanvas.height = result.height;
    }
    dctx.clearRect(0, 0, demoCanvas.width, demoCanvas.height);
    dctx.drawImage(result.canvas, 0, 0);
  }

  const scheduler = createScheduler({
    render: frame,
    isAnimated: () => homeActive && inView && !reducedMotion(),
    isActive: () => homeActive && inView,
    maxFps: 20,
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      scheduler.poke();
    }).observe(demoFigure);
  }

  // ---- gallery ------------------------------------------------------------------------------------
  // Each card shows a short loop of the mode running on the animated demo (THUMB_FRAMES frames, rendered lazily
  // when the card comes near the viewport, one at a time with yields) that a single timer flips through while the
  // card is on screen. Frame 0 is drawn first for every queued card, so the grid fills in quickly. A mode whose
  // first frame is slow stays a still picture (cheap), and with prefers-reduced-motion every card is still.
  const THUMB_FRAMES = 6;
  const THUMB_STEP = 0.45;  // seconds of demo time between frames
  const THUMB_T0 = 1.4;
  const THUMB_MAX_W = 360;
  const THUMB_SLOW_MS = 350;
  const cards = [];
  let thumbPipe = null;
  let thumbSource = null;
  const thumbQueue = [];   // cards waiting for their first frame
  const loopQueue = [];    // cards waiting for the rest of their loop
  let thumbBusy = false;

  const themeKey = () => `${theme.ink}|${theme.bg}`;

  function keepFrame(card, src, i) {
    const k = Math.min(1, THUMB_MAX_W / src.width);
    const w = Math.max(1, Math.round(src.width * k));
    const h = Math.max(1, Math.round(src.height * k));
    let f = card.frames[i];
    if (!f) { f = document.createElement('canvas'); card.frames[i] = f; }
    if (f.width !== w || f.height !== h) { f.width = w; f.height = h; }
    const g = f.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    return f;
  }

  function show(card, i) {
    const f = card.frames[i];
    if (!f) return;
    const c = card.canvas;
    if (c.width !== f.width || c.height !== f.height) { c.width = f.width; c.height = f.height; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(f, 0, 0);
    card.shown = i;
  }

  async function renderThumbFrame(card, i) {
    if (!thumbPipe) {
      thumbPipe = createPipeline({ label: 'thumbnails' });
      thumbSource = await DemoSource.create({ animated: true, still: THUMB_T0 });
    }
    const mode = await loadMode(card.mode.id); // card.mode is the plain meta: the code loads with the first thumbnail
    const params = paramsFor(mode.id, mode.thumb || {}, 64);
    const time = THUMB_T0 + i * THUMB_STEP;
    const t0 = performance.now();
    let r = await thumbPipe.render({ source: thumbSource, mode, params, time, quality: 'full', outScale: 1, theme });
    // the shared worker was restarted under this job (another caller cancelled a stuck task): try again
    for (let i = 0; i < 2 && r.retry; i++) r = await thumbPipe.render({ source: thumbSource, mode, params, time, quality: 'full', outScale: 1, theme });
    if (!r.canvas) return -1; // WebGL context lost: drawn again when the card comes back into view
    keepFrame(card, r.canvas, i);
    return performance.now() - t0;
  }

  async function drawThumb(card) {
    const key = themeKey();
    card.frames.length = 0;
    const ms = await renderThumbFrame(card, 0);
    if (ms < 0) return;
    show(card, 0);
    card.themeKey = key;
    card.btn.dataset.thumb = 'ready';
    card.loop = !reducedMotion() && ms < THUMB_SLOW_MS;
    if (card.loop && !loopQueue.includes(card)) loopQueue.push(card);
  }

  async function drawLoop(card) {
    const key = card.themeKey;
    for (let i = 1; i < THUMB_FRAMES; i++) {
      if (card.themeKey !== key) return; // the theme changed: the card was queued again from frame 0
      if (!homeActive) { if (!loopQueue.includes(card)) loopQueue.unshift(card); return; } // resume later
      if (await renderThumbFrame(card, i) < 0) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    card.btn.dataset.thumb = 'loop';
  }

  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      while (homeActive && (thumbQueue.length || loopQueue.length)) {
        if (thumbQueue.length) {
          const card = thumbQueue.shift();
          try { await drawThumb(card); } catch (err) { console.warn('[dither] thumbnail failed', err); }
        } else {
          const card = loopQueue.shift();
          try { await drawLoop(card); } catch (err) { console.warn('[dither] thumbnail loop failed', err); }
        }
        await yieldNow(); // yield to the page between thumbnails
      }
    } finally {
      thumbBusy = false;
      // every card has its frames: the thumbnail pipeline (a WebGL context, work canvases) is not needed until the
      // theme changes or more cards come into view
      if (!thumbQueue.length && !loopQueue.length && thumbPipe) {
        thumbPipe.dispose();
        thumbPipe = null;
        thumbSource?.dispose();
        thumbSource = null;
      }
    }
  }

  // One timer flips the loops of the cards on screen (about 3 fps: a lively preview that costs only a drawImage)
  setInterval(() => {
    if (!homeActive || document.hidden || reducedMotion()) return;
    for (const c of cards) {
      if (!c.visible || c.btn.dataset.thumb !== 'loop') continue;
      show(c, (c.shown + 1) % c.frames.length);
    }
  }, 320);

  const thumbObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const card = cards.find((c) => c.canvas === e.target);
        if (!card) continue;
        card.visible = e.isIntersecting;
        if (e.isIntersecting && card.themeKey !== themeKey() && !thumbQueue.includes(card)) thumbQueue.push(card);
      }
      pumpThumbs();
    }, { rootMargin: '200px' })
    : null;

  function buildGallery() {
    grid.textContent = '';
    cards.length = 0;
    for (const mode of MODE_META) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mode-card';
      btn.dataset.modeId = mode.id;
      const canvas = document.createElement('canvas');
      canvas.width = 360;
      canvas.height = 240;
      canvas.setAttribute('aria-hidden', 'true');
      const body = document.createElement('div');
      body.className = 'mode-card-body';
      const name = document.createElement('span');
      name.className = 'mode-card-name';
      const blurb = document.createElement('span');
      blurb.className = 'mode-card-blurb';
      const badges = document.createElement('span');
      badges.className = 'mode-card-badges';
      for (const b of mode.badges || []) {
        const s = document.createElement('span');
        s.className = 'badge';
        s.textContent = b;
        badges.appendChild(s);
      }
      body.append(name, blurb, badges);
      btn.append(canvas, body);
      const available = modeAvailable(mode);
      if (!available) btn.setAttribute('aria-disabled', 'true'); // GPU mode without WebGL2: listed, explained, not opened
      btn.addEventListener('click', () => {
        if (available) onOpenMode(mode.id);
        else toastWarn(t('err.noWebGL2'));
      });
      li.appendChild(btn);
      grid.appendChild(li);
      const card = { mode, canvas, name, blurb, btn, themeKey: '', available, frames: [], shown: 0, visible: false, loop: false };
      cards.push(card);
      if (available) thumbObserver?.observe(canvas);
    }
    relabel();
  }

  function relabel() {
    for (const c of cards) {
      c.name.textContent = tl(c.mode.name);
      c.blurb.textContent = c.available ? tl(c.mode.blurb) : `${tl(c.mode.blurb)} · ${t('err.noWebGL2')}`;
      c.btn.setAttribute('aria-label', t('modes.open', { mode: tl(c.mode.name) }));
    }
  }

  onThemeChange(() => {
    theme = themeOutputColors();
    scheduler.markDirty();
    for (const c of cards) {
      if (c.available && c.themeKey && !thumbQueue.includes(c)) {
        c.themeKey = 'stale';
        thumbQueue.push(c);
      }
    }
    pumpThumbs();
  });
  onLangChange(() => {
    relabel();
    lookIndex = -1; // refresh the demo label
    scheduler.markDirty();
  });

  return {
    async init() {
      buildGallery();
      modesSection.hidden = false;
      demo = await DemoSource.create({ animated: !reducedMotion() });
      demoFigure.hidden = false;
      scheduler.start();
    },
    setActive(on) {
      homeActive = on;
      if (on) { scheduler.markDirty(); pumpThumbs(); }
      scheduler.poke();
    },
  };
}
