// "PRESETS" group of the studio panel (PLAN.md 10): curated presets of the mode, "Surprise me", the user's own
// presets (save / load / delete, export / import as JSON) and the share link. User text (preset names, imported
// files) is only ever written with textContent / value (PLAN.md 18.3).

import { t, tl } from '../i18n/i18n.js';
import {
  curatedPresets, loadUserPresets, saveUserPresets, mergePresets, snapshot, presetToJSON, parsePresetText,
  PresetError, MAX_IMPORT_BYTES, MAX_NAME,
} from '../presets.js';
import { exportName, downloadBlob } from '../io/download.js';
import { toast, toastWarn, toastError } from './toast.js';

let uid = 0;

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  return node;
}

/**
 * @param {object} o
 * @param {object} o.mode       current mode module
 * @param {object} o.store      state store
 * @param {(preset: object, modeId?: string) => void} o.apply   apply a curated or user preset
 * @param {() => void} o.surprise
 * @param {() => string} o.shareUrl   current share link
 * @param {() => void} o.share        copy the share link
 * @param {boolean} [o.open]
 */
export function createPresetsGroup({ mode, store, apply, surprise, shareUrl, share, open = true }) {
  const n = ++uid;
  const group = el('details', 'group group-presets');
  group.dataset.group = 'presets';
  group.dataset.tab = 'mode';
  group.open = open;

  const head = el('summary', 'group-head');
  const title = el('span', 'group-title label');
  title.textContent = t('presets.title');
  head.append(title, el('span', 'group-rule'));
  group.appendChild(head);
  const body = el('div', 'group-body');
  group.appendChild(body);

  // ---- curated + surprise -------------------------------------------------------------------
  const chips = el('div', 'preset-chips', { role: 'group', 'aria-label': t('presets.curated') });
  for (const p of curatedPresets(mode.id)) {
    const b = el('button', 'btn btn-ghost btn-sm preset-chip', { type: 'button', 'data-preset': p.id });
    b.textContent = tl(p.name);
    b.addEventListener('click', () => apply(p, mode.id));
    chips.appendChild(b);
  }
  const dice = el('button', 'btn btn-primary btn-sm preset-surprise', { type: 'button', 'data-preset': 'surprise', 'aria-keyshortcuts': 'X' });
  const diceGlyph = el('span', null, { 'aria-hidden': 'true' });
  diceGlyph.textContent = '⚄ ';
  dice.append(diceGlyph, document.createTextNode(t('presets.surprise')));
  dice.addEventListener('click', surprise);
  chips.appendChild(dice);
  body.appendChild(chips);

  // ---- user presets -------------------------------------------------------------------------------
  let list = loadUserPresets();
  const mine = () => list.filter((p) => p.modeId === mode.id);

  const selId = `preset-user-${n}`;
  const userRow = el('div', 'ctl preset-user');
  const userLab = el('label', 'ctl-label', { for: selId });
  userLab.textContent = t('presets.mine');
  const selWrap = el('div', 'select-wrap');
  const sel = el('select', 'select', { id: selId, 'data-preset': 'user-select' });
  selWrap.appendChild(sel);
  const userBtns = el('div', 'preset-row');
  const loadBtn = el('button', 'btn btn-ghost btn-sm', { type: 'button', 'data-preset': 'load' });
  loadBtn.textContent = t('presets.load');
  const delBtn = el('button', 'btn btn-ghost btn-sm', { type: 'button', 'data-preset': 'delete' });
  delBtn.textContent = t('presets.delete');
  userBtns.append(loadBtn, delBtn);
  userRow.append(userLab, selWrap, userBtns);

  function fillSelect() {
    sel.textContent = '';
    const items = mine();
    if (!items.length) {
      const o = el('option');
      o.value = '';
      o.textContent = t('presets.none');
      sel.appendChild(o);
    }
    items.forEach((p, i) => {
      const o = el('option');
      o.value = String(i);
      o.textContent = p.name; // user text: textContent only
      sel.appendChild(o);
    });
    sel.disabled = !items.length;
    loadBtn.disabled = delBtn.disabled = !items.length;
  }
  fillSelect();
  const selected = () => mine()[Number(sel.value)];
  loadBtn.addEventListener('click', () => { const p = selected(); if (p) apply(p, p.modeId); });
  delBtn.addEventListener('click', () => {
    const p = selected();
    if (!p) return;
    list = list.filter((q) => q !== p);
    saveUserPresets(list);
    fillSelect();
    toast(t('presets.deleted', { name: p.name }));
  });

  const nameId = `preset-name-${n}`;
  const saveRow = el('div', 'ctl preset-save');
  const nameLab = el('label', 'ctl-label', { for: nameId });
  nameLab.textContent = t('presets.name');
  const line = el('div', 'preset-row');
  const name = el('input', 'input', { id: nameId, type: 'text', maxlength: MAX_NAME, autocomplete: 'off', spellcheck: 'false', placeholder: tl(mode.name), 'data-preset': 'name' });
  const saveBtn = el('button', 'btn btn-ghost btn-sm', { type: 'button', 'data-preset': 'save' });
  saveBtn.textContent = t('presets.save');
  line.append(name, saveBtn);
  saveRow.append(nameLab, line);
  const save = () => {
    const p = snapshot(store.state, name.value || tl(mode.name));
    list = mergePresets(list, [p]);
    const stored = saveUserPresets(list);
    fillSelect();
    sel.value = String(mine().indexOf(list[0]));
    name.value = '';
    if (stored) toast(t('presets.saved', { name: p.name }));
    else toastWarn(t('presets.notStored'));
  };
  saveBtn.addEventListener('click', save);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

  // ---- JSON files ----------------------------------------------------------------------------------
  const files = el('div', 'export-grid preset-files');
  const exportBtn = el('button', 'btn btn-ghost btn-sm', { type: 'button', 'data-preset': 'export' });
  exportBtn.textContent = t('presets.export');
  const importBtn = el('button', 'btn btn-ghost btn-sm', { type: 'button', 'data-preset': 'import' });
  importBtn.textContent = t('presets.import');
  const fileInput = el('input', null, { type: 'file', accept: '.json,application/json', hidden: '', 'data-preset': 'file', 'aria-label': t('presets.import') });
  files.append(exportBtn, importBtn, fileInput);

  exportBtn.addEventListener('click', () => {
    const p = snapshot(store.state, name.value || tl(mode.name));
    const fileName = downloadBlob(new Blob([presetToJSON(p)], { type: 'application/json;charset=utf-8' }), exportName(mode.id, 'preset.json'));
    toast(t('export.saved', { name: fileName }));
  });
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new PresetError('tooLarge');
      const { presets, skipped } = parsePresetText(await file.text());
      list = mergePresets(list, presets);
      saveUserPresets(list);
      fillSelect();
      if (skipped) toastWarn(t('presets.skipped', { n: skipped }));
      toast(t('presets.imported', { n: presets.length }));
      if (presets.length === 1) apply(presets[0], presets[0].modeId);
    } catch (err) {
      const code = err instanceof PresetError ? err.code : 'invalid';
      toastError(t(`presets.err.${code}`, { kb: Math.round(MAX_IMPORT_BYTES / 1024) }));
    }
  });

  // ---- share link -----------------------------------------------------------------------------------
  const linkId = `share-url-${n}`;
  const shareRow = el('div', 'ctl preset-share');
  const linkLab = el('label', 'ctl-label', { for: linkId });
  linkLab.textContent = t('presets.link');
  const linkLine = el('div', 'preset-row');
  const link = el('input', 'input mono', { id: linkId, type: 'text', readonly: '', 'data-preset': 'share-url', spellcheck: 'false' });
  const copy = el('button', 'btn btn-ghost btn-sm', { type: 'button', 'data-preset': 'share' });
  copy.textContent = t('export.share');
  linkLine.append(link, copy);
  const linkHint = el('p', 'group-note muted');
  linkHint.textContent = t('presets.linkHint');
  shareRow.append(linkLab, linkLine, linkHint);
  const refreshLink = () => { link.value = shareUrl(); };
  refreshLink();
  link.addEventListener('focus', () => { refreshLink(); link.select(); });
  copy.addEventListener('click', () => { refreshLink(); share(); });

  body.append(userRow, saveRow, files, shareRow);
  return { el: group, refreshLink };
}
