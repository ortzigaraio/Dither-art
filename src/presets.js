// Presets (PLAN.md 10): curated presets declared by each mode, the user's own presets (saved in localStorage,
// exported / imported as JSON) and "Surprise me". Everything that comes from outside (localStorage, imported
// files) goes through the same schema validation as share links (PLAN.md 18.3): unknown keys dropped, numbers
// clamped, enums whitelisted, strings truncated. Nothing here touches the DOM.

import { IMAGE_PARAMS } from './engine/preprocess.js';
import { COLOR_PARAMS } from './engine/color.js';
import { DEPTH_PARAMS } from './engine/depth.js';
import { POSTFX_PARAMS } from './engine/postfx.js';
import { getLoadedMode, hasMode } from './modes/registry.js';
import { defaultsOf, sanitizeParams, sanitizeValue, sanitizeState, holdRaw } from './state.js';

export const PRESET_FORMAT = 'dither-preset';
export const PRESET_BUNDLE = 'dither-presets';
export const PRESET_VERSION = 1;
const STORAGE_KEY = 'horain.presets';
export const MAX_USER_PRESETS = 50;
export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_NAME = 60;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** A clean display name: no control characters, trimmed, at most MAX_NAME characters. */
export function cleanName(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

// ---------------------------------------------------------------------------
// Applying presets
// ---------------------------------------------------------------------------

/**
 * Build the next state for a preset: the mode params are the mode defaults with the preset on top; global, color,
 * depth and post-fx values are merged over the current ones only when the preset declares them.
 * The result always goes through sanitizeState(), so a curated or imported preset can never inject bad values.
 * The mode must be loaded (registry.loadMode()); null otherwise.
 */
export function stateWithPreset(current, modeId, preset) {
  if (!hasMode(modeId) || !isPlainObject(preset)) return null;
  const mode = getLoadedMode(modeId);
  if (!mode) return null;
  const next = clone(current);
  next.modeId = modeId;
  next.modes[modeId] = { ...defaultsOf(mode.params), ...(isPlainObject(preset.mode) ? preset.mode : {}) };
  for (const key of ['global', 'color', 'depth', 'postfx']) {
    if (isPlainObject(preset[key])) next[key] = { ...next[key], ...preset[key] };
  }
  return sanitizeState(next);
}

/** Curated presets of a mode (data declared in the mode module). */
export function curatedPresets(modeId) {
  return getLoadedMode(modeId)?.presets || [];
}

// ---------------------------------------------------------------------------
// "Surprise me": random values inside pretty ranges
// ---------------------------------------------------------------------------

/**
 * Random parameters for the mode. Per parameter:
 * - `random: false` keeps the current value (cameras, debug views…);
 * - `randomRange: [a, b]` (ranges) or `randomRange: [values…]` (selects) limits the draw;
 * - a range without randomRange moves at most 30 % of its span around the default;
 * - a select picks any option except its `linkFallback` ("custom"); options with `links` also write their values;
 * - seeds get a new seed; toggles, colors and texts keep their values (they are choices, not looks).
 * @param {object} mode
 * @param {object} current current mode params
 * @param {() => number} [rand]
 */
export function surprise(mode, current, rand = Math.random) {
  const out = { ...current };
  const linked = new Set();
  for (const p of mode.params) {
    if (p.type === 'select' && p.links && p.random !== false) for (const v of Object.values(p.links)) for (const k of Object.keys(v)) linked.add(k);
  }
  for (const p of mode.params) {
    if (p.random === false || p.type === 'button') continue;
    if (p.type === 'range' && !linked.has(p.id)) {
      let lo;
      let hi;
      if (Array.isArray(p.randomRange) && p.randomRange.length === 2) [lo, hi] = p.randomRange;
      else {
        const span = (p.max - p.min) * 0.3;
        lo = Math.max(p.min, p.default - span);
        hi = Math.min(p.max, p.default + span);
      }
      const step = p.step || 1;
      const v = lo + rand() * (hi - lo);
      out[p.id] = sanitizeValue(p, Math.round(v / step) * step);
    } else if (p.type === 'select') {
      let opts = (p.options || []).map((o) => o.value).filter((v) => v !== p.linkFallback);
      if (Array.isArray(p.randomRange)) opts = opts.filter((v) => p.randomRange.includes(v));
      if (!opts.length) continue;
      const pick = opts[Math.floor(rand() * opts.length) % opts.length];
      out[p.id] = pick;
      if (p.links?.[pick]) Object.assign(out, p.links[pick]);
    } else if (p.type === 'seed') {
      out[p.id] = Math.floor(rand() * 1e9);
    }
  }
  return sanitizeParams(mode.params, out);
}

// ---------------------------------------------------------------------------
// User presets: snapshot, storage, JSON files
// ---------------------------------------------------------------------------

/** Snapshot of the current settings of the active mode as a user preset. */
export function snapshot(state, name) {
  return {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    name: cleanName(name) || state.modeId,
    modeId: state.modeId,
    mode: clone(state.modes[state.modeId]),
    global: clone(state.global),
    color: clone(state.color),
    depth: clone(state.depth),
    postfx: clone(state.postfx),
  };
}

/**
 * Validate one untrusted preset object. Returns a clean preset, or null when it cannot be used.
 * For a mode whose code is not loaded yet, the mode values are only reduced to a safe shape (holdRaw); applying the
 * preset loads the mode and validates them in full (stateWithPreset -> sanitizeState).
 */
export function sanitizePreset(raw) {
  if (!isPlainObject(raw)) return null;
  if (has(raw, 'format') && raw.format !== PRESET_FORMAT) return null;
  if (typeof raw.modeId !== 'string' || !hasMode(raw.modeId)) return null;
  const mode = getLoadedMode(raw.modeId);
  const out = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    name: cleanName(raw.name) || raw.modeId,
    modeId: raw.modeId,
    mode: mode ? sanitizeParams(mode.params, raw.mode) : (holdRaw(raw.mode) || {}),
  };
  if (isPlainObject(raw.global)) out.global = sanitizeParams(IMAGE_PARAMS, raw.global);
  if (isPlainObject(raw.color)) out.color = sanitizeParams(COLOR_PARAMS, raw.color);
  if (isPlainObject(raw.depth)) out.depth = sanitizeParams(DEPTH_PARAMS, raw.depth);
  if (isPlainObject(raw.postfx)) out.postfx = sanitizeParams(POSTFX_PARAMS, raw.postfx);
  return out;
}

/** JSON text of one preset, or of a bundle when given an array. */
export function presetToJSON(presetOrList) {
  if (Array.isArray(presetOrList)) {
    return JSON.stringify({ format: PRESET_BUNDLE, version: PRESET_VERSION, presets: presetOrList }, null, 2);
  }
  return JSON.stringify(presetOrList, null, 2);
}

export class PresetError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // 'tooLarge' | 'json' | 'invalid' | 'empty'
  }
}

/**
 * Parse an imported file. Accepts one preset or a bundle `{ format: 'dither-presets', presets: [...] }`.
 * Invalid entries in a bundle are skipped; returns { presets, skipped }. Throws PresetError otherwise.
 */
export function parsePresetText(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) throw new PresetError('tooLarge');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new PresetError('json'); }
  let list;
  if (isPlainObject(raw) && raw.format === PRESET_BUNDLE) {
    if (!Array.isArray(raw.presets)) throw new PresetError('invalid');
    list = raw.presets.slice(0, MAX_USER_PRESETS);
  } else {
    list = [raw];
  }
  const presets = [];
  let skipped = 0;
  for (const item of list) {
    const p = sanitizePreset(item);
    if (p) presets.push(p); else skipped++;
  }
  if (!presets.length) throw new PresetError(list.length ? 'invalid' : 'empty');
  return { presets, skipped };
}

/** The user's presets from localStorage (validated; a broken or blocked storage gives an empty list). */
export function loadUserPresets() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_IMPORT_BYTES * 4) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.slice(0, MAX_USER_PRESETS).map(sanitizePreset).filter(Boolean);
  } catch {
    return [];
  }
}

/** Save the list; returns false when storage is blocked or full (the presets still live for this session). */
export function saveUserPresets(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_USER_PRESETS)));
    return true;
  } catch {
    return false;
  }
}

/** Add presets (a preset with the same mode and name replaces the older one); the newest go first. */
export function mergePresets(list, added) {
  const out = list.slice();
  for (const p of added) {
    const i = out.findIndex((q) => q.modeId === p.modeId && q.name === p.name);
    if (i >= 0) out.splice(i, 1);
    out.unshift(p);
  }
  return out.slice(0, MAX_USER_PRESETS);
}
