// Header: theme selector, ES|EN toggle and primary navigation.

import { t, getLang, setLang, onLangChange } from '../i18n/i18n.js';

export const THEMES = [
  { id: 'horain', tone: 'dark' },
  { id: 'claro', tone: 'light' },
  { id: 'amber', tone: 'dark' },
  { id: 'crt', tone: 'dark' },
  { id: 'paper', tone: 'light' },
  { id: 'cad', tone: 'dark' },
];

const listeners = new Set();

export function getTheme() {
  const id = document.documentElement.getAttribute('data-theme');
  return THEMES.some((x) => x.id === id) ? id : 'horain';
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Apply a theme (data-theme + data-tone) and remember it. */
export function setTheme(id, { persist = true } = {}) {
  const theme = THEMES.find((x) => x.id === id) || THEMES[0];
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.id);
  root.setAttribute('data-tone', theme.tone);
  if (persist) {
    try { localStorage.setItem('horain.theme', theme.id); } catch { /* storage blocked */ }
  }
  const select = document.getElementById('theme-select');
  if (select && select.value !== theme.id) select.value = theme.id;
  listeners.forEach((fn) => fn(theme));
}

/** Resolved CSS colours of the current theme, used for the default ink/background of the output. */
export function themeOutputColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    ink: cs.getPropertyValue('--out-ink').trim() || '#C4F169',
    bg: cs.getPropertyValue('--out-bg').trim() || '#15181E',
  };
}

function fillThemeOptions(select) {
  const current = getTheme();
  select.textContent = '';
  for (const th of THEMES) {
    const opt = document.createElement('option');
    opt.value = th.id;
    opt.textContent = t(`theme.${th.id}`).toUpperCase();
    select.appendChild(opt);
  }
  select.value = current;
}

function syncLangButtons() {
  document.querySelectorAll('.lang-toggle [data-lang]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.getAttribute('data-lang') === getLang()));
  });
}

/**
 * @param {{ onNavigate: (target: 'studio'|'modes'|'about') => void }} hooks
 */
export function initHeader({ onNavigate } = {}) {
  const select = document.getElementById('theme-select');
  fillThemeOptions(select);
  select.addEventListener('change', () => setTheme(select.value));

  document.querySelectorAll('.lang-toggle [data-lang]').forEach((btn) => {
    btn.addEventListener('click', () => setLang(btn.getAttribute('data-lang')));
  });
  syncLangButtons();
  onLangChange(() => {
    fillThemeOptions(select);
    syncLangButtons();
  });

  document.querySelectorAll('#site-nav [data-nav]').forEach((a) => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      onNavigate?.(a.getAttribute('data-nav'));
    });
  });
}

/** Mark the active primary-nav entry. */
export function setActiveNav(name) {
  document.querySelectorAll('#site-nav [data-nav]').forEach((a) => {
    if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
