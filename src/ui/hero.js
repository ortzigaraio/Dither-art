// Home view: the live demo (the real engine running on the procedural DemoSource, rotating looks every 4 s)
// and the gallery of modes with lazily rendered thumbnails.

import { t, tl, onLangChange } from '../i18n/i18n.js';
import { MODES, getMode, hasMode, modeAvailable } from '../modes/index.js';
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

/** Looks the hero rotates through. Each is a partial parameter set, validated against the schemas. */
const LOOKS = [
  { modeId: 'ascii', mode: { gradient: 'standard' }, global: { cols: 92 } },
  { modeId: 'ascii', mode: { gradient: 'blocks' }, color: { colorMode: 'gradient' }, global: { cols: 70, contrast: 120 } },
  { modeId: 'ascii', mode: { gradient: 'detailed' }, color: { colorMode: 'original' }, global: { cols: 110, dither: 'atkinson' } },
  { modeId: 'ascii', mode: { gradient: 'katakana' }, color: { colorMode: 'mono', ink: '#00ff41', bg: '#031205' }, global: { cols: 84, edges: 3 } },
];

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

  const pipeline = createPipeline({ onInvalidate: () => scheduler.markDirty() });
  const dctx = demoCanvas.getContext('2d');

  // ---- hero demo ----------------------------------------------------------------------------
  function labelFor(look) {
    const mode = getMode(look.modeId);
    const gradient = GRADIENT_OPTIONS.find((o) => o.value === look.mode?.gradient);
    const parts = [tl(mode.name), gradient ? tl(gradient.label) : ''].filter(Boolean);
    return t('hero.demoLabel', { mode: parts.join(' · ').toLowerCase() });
  }

  async function frame(now) {
    if (!demo) return;
    const still = reducedMotion();
    const idx = still ? 0 : Math.floor(now / ROTATE_EVERY) % LOOKS.length;
    const look = LOOKS[idx];
    if (!hasMode(look.modeId)) return;
    if (idx !== lookIndex) {
      lookIndex = idx;
      demoLabel.textContent = labelFor(look);
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
  const cards = [];
  let thumbPipe = null;
  let thumbSource = null;
  const thumbQueue = [];
  let thumbBusy = false;

  async function drawThumb(card) {
    if (!thumbPipe) {
      thumbPipe = createPipeline();
      thumbSource = await DemoSource.create({ animated: false, still: 1.4 });
    }
    const mode = card.mode;
    const params = paramsFor(mode.id, mode.thumb || {}, 64);
    const r = await thumbPipe.render({ source: thumbSource, mode, params, time: 1.4, quality: 'full', outScale: 1, theme });
    if (!r.canvas) return; // WebGL context lost: drawn again when the card comes back into view
    const c = card.canvas;
    if (c.width !== r.width || c.height !== r.height) { c.width = r.width; c.height = r.height; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(r.canvas, 0, 0);
    card.themeKey = `${theme.ink}|${theme.bg}`;
  }

  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    while (thumbQueue.length) {
      const card = thumbQueue.shift();
      try { await drawThumb(card); } catch (err) { console.warn('[dither] thumbnail failed', err); }
      await new Promise((r) => setTimeout(r, 0)); // yield to the page between thumbnails
    }
    thumbBusy = false;
  }

  const thumbObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const card = cards.find((c) => c.canvas === e.target);
        if (card && card.themeKey !== `${theme.ink}|${theme.bg}` && !thumbQueue.includes(card)) thumbQueue.push(card);
      }
      pumpThumbs();
    }, { rootMargin: '200px' })
    : null;

  function buildGallery() {
    grid.textContent = '';
    cards.length = 0;
    for (const mode of MODES) {
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
      const card = { mode, canvas, name, blurb, btn, themeKey: '', available };
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
      if (c.available && c.themeKey && !thumbQueue.includes(c)) thumbQueue.push(c);
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
      if (on) scheduler.markDirty();
      scheduler.poke();
    },
  };
}
