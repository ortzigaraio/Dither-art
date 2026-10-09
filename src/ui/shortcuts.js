// Keyboard shortcuts (PLAN.md 4.7) and the "?" help overlay.
// Space and ←/→ (play / frame step) live in transport.js because they only exist for videos; the zoom keys
// (+ − 0) belong to the focused viewer (viewer.js). Everything else is here. Shortcuts never fire while the user
// types in a field, with Ctrl/Cmd/Alt held, or while a dialog is open.

import { t, onLangChange } from '../i18n/i18n.js';

/** Rows of the help overlay: [keys, i18n key]. */
export const SHORTCUTS = [
  [['Space'], 'keys.play'],
  [['←', '→'], 'keys.step'],
  [['[', ']'], 'keys.mode'],
  [['R'], 'keys.reset'],
  [['E'], 'keys.export'],
  [['C'], 'keys.copy'],
  [['F'], 'keys.fullscreen'],
  [['S'], 'keys.split'],
  [['X'], 'keys.surprise'],
  [['+', '−', '0'], 'keys.zoom'],
  [['?'], 'keys.help'],
  [['Esc'], 'keys.close'],
];

const TEXT_INPUT = 'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="color"]), textarea, select, [contenteditable="true"]';
const isTyping = (target) => target instanceof Element && !!target.closest(TEXT_INPUT);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let dialog = null;

/** Open (or focus) the shortcuts overlay. */
export function openShortcutsHelp() {
  if (dialog?.open) return dialog;
  const dlg = el('dialog', 'dialog keys-dialog');
  dlg.id = 'keys-dialog';
  dlg.setAttribute('aria-labelledby', 'keys-title');
  const body = el('div', 'dlg-body');
  const head = el('div', 'keys-head');
  const title = el('h2', 'dlg-title display', t('keys.title'));
  title.id = 'keys-title';
  const close = el('button', 'btn btn-ghost btn-sm', t('keys.closeBtn'));
  close.type = 'button';
  close.dataset.keys = 'close';
  head.append(title, close);
  const list = el('dl', 'keys-list');
  for (const [keys, label] of SHORTCUTS) {
    const row = el('div', 'keys-row');
    const dt = el('dt');
    keys.forEach((k, i) => {
      if (i) dt.appendChild(el('span', 'keys-sep', ' '));
      dt.appendChild(el('kbd', 'kbd', k === 'Space' ? t('transport.space') : k));
    });
    row.append(dt, el('dd', null, t(label)));
    list.appendChild(row);
  }
  const note = el('p', 'group-note muted', t('keys.note'));
  body.append(head, list, note);
  dlg.appendChild(body);
  const finish = () => { if (dlg.open) dlg.close(); dlg.remove(); if (dialog === dlg) dialog = null; };
  close.addEventListener('click', finish);
  dlg.addEventListener('close', finish);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(); }); // click on the backdrop
  document.body.appendChild(dlg);
  dlg.showModal();
  close.focus();
  dialog = dlg;
  return dlg;
}

/**
 * @param {object} h handlers
 * @param {() => boolean} h.inStudio
 * @param {(dir: 1|-1) => void} h.cycleMode
 * @param {() => void} h.resetMode
 * @param {() => void} h.exportImage
 * @param {() => void} h.copy
 * @param {() => void} h.fullscreen
 * @param {() => void} h.split
 * @param {() => void} h.surprise
 */
export function initShortcuts(h) {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target)) return;
    if (document.querySelector('dialog[open]')) return;
    const key = e.key;
    if (key === '?') {
      e.preventDefault();
      openShortcutsHelp();
      return;
    }
    if (!h.inStudio()) return;
    // Keys that would retype a slider value (none of ours do) are fine on a focused slider; buttons keep Space/Enter
    const k = key.length === 1 ? key.toLowerCase() : key;
    const run = (fn) => { e.preventDefault(); fn(); };
    switch (k) {
      case '[': run(() => h.cycleMode(-1)); break;
      case ']': run(() => h.cycleMode(1)); break;
      case 'r': run(h.resetMode); break;
      case 'e': run(h.exportImage); break;
      case 'c': run(h.copy); break;
      case 'f': run(h.fullscreen); break;
      case 's': run(h.split); break;
      case 'x': run(h.surprise); break;
      default: break;
    }
  });
  onLangChange(() => {
    if (dialog?.open) { dialog.close(); openShortcutsHelp(); }
  });
}
