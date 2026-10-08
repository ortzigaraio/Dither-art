// Mode registry (PLAN.md 6): adding a mode = create the file in this folder + import it here.
// The order below is the order of the list in the UI (grouped by category).

import ascii from './ascii.js';

export const CATEGORIES = ['text', 'pixel', 'vector', '3d', 'sim'];

export const MODES = [
  ascii,
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
  return mode;
}
MODES.forEach(checkMode);

export const MODE_IDS = MODES.map((m) => m.id);
export const hasMode = (id) => MODES.some((m) => m.id === id);
export const getMode = (id) => MODES.find((m) => m.id === id) || MODES[0];
export const modesByCategory = () => CATEGORIES
  .map((cat) => ({ category: cat, modes: MODES.filter((m) => m.category === cat) }))
  .filter((g) => g.modes.length);
