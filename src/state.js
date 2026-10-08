// Global state store (PLAN.md 10): pub/sub, localStorage persistence and a shareable, validated hash.
// All external state (localStorage, `#s=` links, imported presets) goes through sanitizeState(), which only
// keeps known keys, clamps numbers to their schema range, whitelists enums and truncates strings (PLAN.md 18.3).

import { IMAGE_PARAMS } from './engine/preprocess.js';
import { COLOR_PARAMS, normalizeHex } from './engine/color.js';
import { MODES, getMode, hasMode } from './modes/index.js';
import { LIMITS } from './config.js';

const STORAGE_KEY = 'horain.params';
const SHARE_VERSION = 1;

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

export function defaultsOf(schema) {
  const out = {};
  for (const p of schema) if (p.type !== 'button') out[p.id] = clone(p.default);
  return out;
}

const decimalsOf = (step) => {
  const s = String(step ?? 1);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Validate one value against its param schema; invalid input falls back to the default. */
export function sanitizeValue(param, v) {
  const fallback = clone(param.default);
  switch (param.type) {
    case 'range': {
      const n = typeof v === 'number' ? v : NaN;
      if (!Number.isFinite(n)) return fallback;
      const clamped = Math.min(param.max, Math.max(param.min, n));
      return Number(clamped.toFixed(Math.max(decimalsOf(param.step), 0)));
    }
    case 'select': {
      const opts = param.options || [];
      return opts.some((o) => o.value === v) ? v : fallback;
    }
    case 'toggle':
      return typeof v === 'boolean' ? v : fallback;
    case 'color': {
      if (v === null && param.default === null) return null;
      return (typeof v === 'string' && normalizeHex(v)) || fallback;
    }
    case 'colors': {
      if (!Array.isArray(v)) return fallback;
      const list = v.map((c) => (typeof c === 'string' ? normalizeHex(c) : null)).filter(Boolean).slice(0, param.max || 8);
      return list.length >= (param.min || 1) ? list : fallback;
    }
    case 'text': {
      if (typeof v !== 'string') return fallback;
      // eslint-disable-next-line no-control-regex
      return v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, Math.min(param.maxLength || LIMITS.maxStateString, LIMITS.maxStateString));
    }
    case 'seed': {
      const n = typeof v === 'number' ? Math.floor(v) : NaN;
      return Number.isFinite(n) ? Math.min(2147483647, Math.max(0, n)) : fallback;
    }
    default:
      return fallback;
  }
}

/** Keep only known ids of `schema`; every other key (including __proto__) is dropped. */
export function sanitizeParams(schema, values) {
  const src = isPlainObject(values) ? values : {};
  const out = {};
  for (const p of schema) {
    if (p.type === 'button') continue;
    out[p.id] = has(src, p.id) ? sanitizeValue(p, src[p.id]) : clone(p.default);
  }
  return out;
}

export function defaultState() {
  return {
    modeId: MODES[0].id,
    global: defaultsOf(IMAGE_PARAMS),
    color: defaultsOf(COLOR_PARAMS),
    depth: {},
    postfx: {},
    modes: Object.fromEntries(MODES.map((m) => [m.id, defaultsOf(m.params)])),
  };
}

/** Turn untrusted JSON into a complete, valid state (unknown keys dropped, values clamped). */
export function sanitizeState(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const state = defaultState();
  if (typeof src.modeId === 'string' && hasMode(src.modeId)) state.modeId = src.modeId;
  state.global = sanitizeParams(IMAGE_PARAMS, src.global);
  state.color = sanitizeParams(COLOR_PARAMS, src.color);
  const modes = isPlainObject(src.modes) ? src.modes : {};
  for (const m of MODES) state.modes[m.id] = sanitizeParams(m.params, has(modes, m.id) ? modes[m.id] : null);
  return state;
}

// ---------------------------------------------------------------------------
// Share links: #s=<base64url(JSON)>
// ---------------------------------------------------------------------------

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function encodeShare(state) {
  const payload = {
    v: SHARE_VERSION,
    modeId: state.modeId,
    global: state.global,
    color: state.color,
    modes: { [state.modeId]: state.modes[state.modeId] },
  };
  return toBase64Url(JSON.stringify(payload));
}

/** Returns a sanitized state, or null when the hash is not a valid share link. */
export function decodeShareHash(hash) {
  try {
    const m = /^#s=([A-Za-z0-9_-]+)$/.exec(hash || '');
    if (!m || m[1].length > LIMITS.maxHashChars) return null;
    const raw = JSON.parse(fromBase64Url(m[1]));
    if (!isPlainObject(raw) || raw.v !== SHARE_VERSION) return null;
    return sanitizeState(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function schemaFor(path) {
  const [root, a, b] = path;
  if (root === 'global') return IMAGE_PARAMS.find((p) => p.id === a);
  if (root === 'color') return COLOR_PARAMS.find((p) => p.id === a);
  if (root === 'modes' && hasMode(a)) return getMode(a).params.find((p) => p.id === b);
  return null;
}

export function createStore() {
  let state = defaultState();
  const listeners = new Set();
  let saveTimer = 0;

  const notify = (path) => listeners.forEach((fn) => fn(path, state));

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: SHARE_VERSION, modeId: state.modeId, global: state.global, color: state.color, modes: state.modes }));
      } catch { /* storage blocked: the app works the same */ }
    }, 250);
  }

  return {
    get state() { return state; },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Read a dotted path such as 'global.brightness' or 'modes.ascii.cellSize'. */
    get(path) {
      return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state);
    },

    /** Set one validated value. Unknown paths are ignored. */
    set(path, value) {
      const parts = path.split('.');
      const param = schemaFor(parts);
      if (!param) return false;
      const clean = sanitizeValue(param, value);
      const holder = parts.length === 3 ? state.modes[parts[1]] : state[parts[0]];
      const key = parts[parts.length - 1];
      if (JSON.stringify(holder[key]) === JSON.stringify(clean)) return false;
      holder[key] = clean;
      persist();
      notify(path);
      return true;
    },

    setModeId(id) {
      if (!hasMode(id) || id === state.modeId) return false;
      state.modeId = id;
      persist();
      notify('modeId');
      return true;
    },

    /** Reset a group to its defaults: 'global' | 'color' | 'mode'. */
    resetGroup(group) {
      if (group === 'global') state.global = defaultsOf(IMAGE_PARAMS);
      else if (group === 'color') state.color = defaultsOf(COLOR_PARAMS);
      else if (group === 'mode') state.modes[state.modeId] = defaultsOf(getMode(state.modeId).params);
      else return;
      persist();
      notify(`reset.${group}`);
    },

    /** Replace everything with an (already sanitized) state. */
    replace(next) {
      state = next;
      persist();
      notify('replace');
    },

    /** Restore the last session from localStorage (validated). */
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw || raw.length > LIMITS.maxHashChars * 4) return false;
        state = sanitizeState(JSON.parse(raw));
        return true;
      } catch {
        return false;
      }
    },

    shareHash() {
      return `#s=${encodeShare(state)}`;
    },
  };
}
