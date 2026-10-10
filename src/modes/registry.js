// Mode registry used by the app (PLAN.md 6). The plain data of every mode (meta.js) is always here; the code of a
// mode is loaded on demand with loadMode(), so the boot path only carries the default mode (ASCII). A loaded mode is
// then available synchronously through getLoadedMode(). Importing ./index.js (the full, eager list, used by the
// tests and the asset scripts) registers every mode at once.

import ascii from './ascii.js';
import { MODE_META } from './meta.js';
import { hasWebGL2 } from '../engine/gl.js';

export { MODE_META };
export const CATEGORIES = ['text', 'pixel', 'vector', '3d', 'sim'];
export const DEFAULT_MODE_ID = 'ascii';
export const MODE_IDS = MODE_META.map((m) => m.id);

// One static specifier per mode, so the files stay plain relative URLs (works under any sub-path).
const IMPORTERS = {
  braille: () => import('./braille.js'),
  ansi: () => import('./ansi.js'),
  petscii: () => import('./petscii.js'),
  matrix: () => import('./matrix.js'),
  typoportrait: () => import('./typoportrait.js'),
  dither1bit: () => import('./dither1bit.js'),
  halftone: () => import('./halftone.js'),
  pixelart: () => import('./pixelart.js'),
  led: () => import('./led.js'),
  thermal: () => import('./thermal.js'),
  glitch: () => import('./glitch.js'),
  pixelsort: () => import('./pixelsort.js'),
  crosshatch: () => import('./crosshatch.js'),
  linehalftone: () => import('./linehalftone.js'),
  contours: () => import('./contours.js'),
  voronoi: () => import('./voronoi.js'),
  flowfield: () => import('./flowfield.js'),
  blueprint: () => import('./blueprint.js'),
  vectrex: () => import('./vectrex.js'),
  spiral: () => import('./spiral.js'),
  lidar: () => import('./lidar.js'),
  hiddenwire: () => import('./hiddenwire.js'),
  raymarch: () => import('./raymarch.js'),
  volumetext: () => import('./volumetext.js'),
  reactiondiffusion: () => import('./reactiondiffusion.js'),
};

const PARAM_TYPES = new Set(['range', 'select', 'toggle', 'color', 'colors', 'text', 'button', 'seed']);

/** Fail loudly when a mode does not follow the interface of PLAN.md 6. */
export function checkMode(mode) {
  const fail = (msg) => { throw new Error(`mode "${mode?.id}": ${msg}`); };
  if (!mode || typeof mode.id !== 'string') fail('missing id');
  if (!CATEGORIES.includes(mode.category)) fail('bad category');
  if (!mode.name?.es || !mode.name?.en) fail('name needs es and en');
  if (!mode.blurb?.es || !mode.blurb?.en) fail('blurb needs es and en');
  if (typeof mode.resolution !== 'function' || typeof mode.render !== 'function') fail('needs resolution() and render()');
  if (!Array.isArray(mode.params)) fail('params must be an array');
  const ids = new Set();
  for (const p of mode.params) {
    if (!PARAM_TYPES.has(p.type)) fail(`param "${p.id}" has unknown type "${p.type}"`);
    if (ids.has(p.id)) fail(`duplicate param "${p.id}"`);
    ids.add(p.id);
  }
  // exports and badges must agree with what the mode can actually produce (the export panel offers exactly these)
  const ex = mode.exports || [];
  const need = { txt: 'toText', html: 'toText', ansi: 'toText', ans: 'toBinary', svg: 'toSVG', json: 'toJSON', ply: 'toPLY' };
  for (const [fmt, fn] of Object.entries(need)) {
    if (ex.includes(fmt) && typeof mode[fn] !== 'function') fail(`exports "${fmt}" needs ${fn}()`);
  }
  const badges = mode.badges || [];
  if (ex.includes('txt') && !badges.includes('TXT')) fail('exports txt but has no TXT badge');
  if (ex.includes('svg') && !badges.includes('SVG')) fail('exports svg but has no SVG badge');
  if ((mode.animated || mode.animatedWhen) && !badges.includes('ANIM')) fail('animated but has no ANIM badge');
  if (mode.surface === 'gl' && !badges.includes('GPU')) fail('draws with WebGL2 but has no GPU badge');
  if (mode.category === '3d' && !badges.includes('3D')) fail('3D mode without the 3D badge');
  return mode;
}

const loaded = new Map();
const pending = new Map();
const listeners = new Set();

/** Add a loaded mode module (idempotent). Listeners (the stores) adopt its saved settings. */
export function registerMode(mode) {
  if (loaded.has(mode.id)) return loaded.get(mode.id);
  checkMode(mode);
  loaded.set(mode.id, mode);
  listeners.forEach((fn) => fn(mode));
  return mode;
}
registerMode(ascii);

export const hasMode = (id) => typeof id === 'string' && MODE_IDS.includes(id);
export const metaOf = (id) => MODE_META.find((m) => m.id === id) || null;
/** The loaded module of a mode, or null while its code has not arrived. */
export const getLoadedMode = (id) => loaded.get(id) || null;
export const isModeLoaded = (id) => loaded.has(id);
/** Loaded modes, in the order of the UI. */
export const loadedModes = () => MODE_IDS.filter((id) => loaded.has(id)).map((id) => loaded.get(id));
export const onModeLoaded = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Load a mode's code (once; concurrent calls share the request). Rejects for an unknown id or a network error. */
export function loadMode(id) {
  if (loaded.has(id)) return Promise.resolve(loaded.get(id));
  if (!hasMode(id) || !IMPORTERS[id]) return Promise.reject(new Error(`unknown mode "${id}"`));
  if (!pending.has(id)) {
    const p = IMPORTERS[id]()
      .then((m) => registerMode(m.default))
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return pending.get(id);
}

/** A mode can run here: GPU modes need WebGL2 (otherwise they are listed disabled, PLAN.md 18.2). Takes meta or module. */
export const modeAvailable = (m) => !!m && (m.surface !== 'gl' || hasWebGL2());

export const modesByCategory = () => CATEGORIES
  .map((cat) => ({ category: cat, modes: MODE_META.filter((m) => m.category === cat) }))
  .filter((g) => g.modes.length);
