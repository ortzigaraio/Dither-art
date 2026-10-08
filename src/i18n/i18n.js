// Minimal i18n: t(key, vars), tl({es,en}), setLang(), applyI18n(root).
// Fallback chain: current language -> EN -> the key itself.

import es from './es.js';
import en from './en.js';

const DICTS = { es, en };
export const LANGS = ['es', 'en'];

let lang = 'en';
const listeners = new Set();

export function detectLang() {
  try {
    const stored = localStorage.getItem('horain.lang');
    if (stored === 'es' || stored === 'en') return stored;
  } catch { /* storage blocked */ }
  return (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function getLang() { return lang; }

export function t(key, vars) {
  let s = DICTS[lang]?.[key] ?? DICTS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** Localise a `{ es, en }` object (used by mode/param schemas). Plain strings pass through. */
export function tl(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  return obj[lang] ?? obj.en ?? obj.es ?? '';
}

export function hasKey(key) {
  return key in DICTS.en && key in DICTS.es;
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
      const idx = pair.indexOf(':');
      if (idx > 0) el.setAttribute(pair.slice(0, idx).trim(), t(pair.slice(idx + 1).trim()));
    }
  });
}

export function setLang(next, { persist = true } = {}) {
  if (!LANGS.includes(next)) return;
  lang = next;
  document.documentElement.lang = next;
  if (persist) {
    try { localStorage.setItem('horain.lang', next); } catch { /* storage blocked */ }
  }
  applyI18n(document);
  listeners.forEach((fn) => fn(next));
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initI18n() {
  setLang(detectLang(), { persist: false });
}
