// Mode registry (PLAN.md 6): adding a mode = create the file in this folder + import it here.
// The order below is the order of the list in the UI (grouped by category).

import ascii from './ascii.js';
import braille from './braille.js';
import ansi from './ansi.js';
import petscii from './petscii.js';
import matrix from './matrix.js';
import typoportrait from './typoportrait.js';
import dither1bit from './dither1bit.js';
import halftone from './halftone.js';
import pixelart from './pixelart.js';
import led from './led.js';
import thermal from './thermal.js';
import glitch from './glitch.js';
import pixelsort from './pixelsort.js';
import crosshatch from './crosshatch.js';
import contours from './contours.js';
import voronoi from './voronoi.js';
import flowfield from './flowfield.js';
import vectrex from './vectrex.js';
import blueprint from './blueprint.js';
import spiral from './spiral.js';

export const CATEGORIES = ['text', 'pixel', 'vector', '3d', 'sim'];

export const MODES = [
  ascii,
  braille,
  ansi,
  petscii,
  matrix,
  typoportrait,
  dither1bit,
  halftone,
  pixelart,
  led,
  thermal,
  glitch,
  pixelsort,
  crosshatch,
  contours,
  voronoi,
  flowfield,
  vectrex,
  blueprint,
  spiral,
];

const PARAM_TYPES = new Set(['range', 'select', 'toggle', 'color', 'colors', 'text', 'button', 'seed']);

/** Fail loudly (at load time) when a mode does not follow the interface of PLAN.md 6. */
function checkMode(mode) {
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
  const need = { txt: 'toText', html: 'toText', ansi: 'toText', ans: 'toBinary', svg: 'toSVG', json: 'toJSON' };
  for (const [fmt, fn] of Object.entries(need)) {
    if (ex.includes(fmt) && typeof mode[fn] !== 'function') fail(`exports "${fmt}" needs ${fn}()`);
  }
  const badges = mode.badges || [];
  if (ex.includes('txt') && !badges.includes('TXT')) fail('exports txt but has no TXT badge');
  if (ex.includes('svg') && !badges.includes('SVG')) fail('exports svg but has no SVG badge');
  if ((mode.animated || mode.animatedWhen) && !badges.includes('ANIM')) fail('animated but has no ANIM badge');
  return mode;
}
MODES.forEach(checkMode);

export const MODE_IDS = MODES.map((m) => m.id);
export const hasMode = (id) => MODES.some((m) => m.id === id);
export const getMode = (id) => MODES.find((m) => m.id === id) || MODES[0];
export const modesByCategory = () => CATEGORIES
  .map((cat) => ({ category: cat, modes: MODES.filter((m) => m.category === cat) }))
  .filter((g) => g.modes.length);
