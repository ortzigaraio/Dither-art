// Parameter controls generated from schemas (PLAN.md 4.5, 6): never hand-written per mode.
// Types: range | select | toggle | color | colors | text | button | seed.
// The panel is built from: ENTRADA (input), IMAGEN (global schema), MODO (mode schema), COLOR, EXPORTAR.

import { t, tl } from '../i18n/i18n.js';
import { IMAGE_PARAMS } from '../engine/preprocess.js';
import { colorSchemaFor, resolveColors, normalizeHex, rgbToHex } from '../engine/color.js';
import { LIMITS } from '../config.js';

const decimalsOf = (step) => {
  const s = String(step ?? 1);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

let uidCounter = 0;
const uid = (p) => `${p}-${++uidCounter}`;

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  return node;
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host        the #controls container
 * @param {HTMLElement} opts.panel       the aside (receives data-tab for the mobile sheet)
 * @param {HTMLElement} opts.tabsHost    #sheet-tabs
 * @param {object} opts.store            state store (state.js)
 * @param {() => object} opts.getMode    current mode module
 * @param {() => {ink:string,bg:string}} opts.getTheme
 * @param {(on:boolean)=>void} opts.onDragging  slider drag started/ended (draft quality)
 * @param {{ input?: () => HTMLElement|null, export?: () => HTMLElement|null }} opts.extra  non-schema groups
 * @param {(id:string)=>void} [opts.onAction]  button params
 */
export function createControls({ host, panel, tabsHost, store, getMode, getTheme, onDragging, extra = {}, onAction }) {
  let rows = []; // { update(), param, groupEl }
  const openState = new Map(); // group id -> open?
  let activeTab = 'image';

  const allParams = () => {
    const s = store.state;
    return { global: s.global, color: s.color, depth: s.depth, postfx: s.postfx, mode: s.modes[s.modeId] };
  };

  // ---- one control row ---------------------------------------------------------------------
  function buildRow(param, path, groupValues) {
    const id = uid('ctl');
    const label = tl(param.label);
    const row = el('div', `ctl ctl-${param.type}`);
    row.dataset.param = param.id;
    const head = el('div', 'ctl-head');
    const lab = el('label', 'ctl-label', { for: id });
    lab.textContent = label;
    lab.title = t('studio.reset');
    head.appendChild(lab);

    // help tooltip
    if (param.help) {
      const tipId = `${id}-tip`;
      const help = el('button', 'ctl-help', { type: 'button', 'aria-label': `${t('studio.help')}: ${label}`, 'aria-describedby': tipId });
      help.textContent = '?';
      const tip = el('span', 'ctl-tip', { role: 'tooltip', id: tipId });
      tip.textContent = tl(param.help);
      help.addEventListener('click', () => tip.classList.toggle('is-open'));
      help.addEventListener('blur', () => tip.classList.remove('is-open'));
      head.appendChild(help);
      row.appendChild(head);
      row.appendChild(tip);
    } else {
      row.appendChild(head);
    }

    const commit = (v) => store.set(path, v);
    const reset = () => { store.set(path, param.default); api.update(true); };
    lab.addEventListener('dblclick', reset);

    const api = { param, el: row, update() {} };

    switch (param.type) {
      case 'range': {
        const dec = decimalsOf(param.step);
        const range = el('input', 'range', {
          type: 'range', id, min: param.min, max: param.max, step: param.step ?? 1,
          'aria-label': label,
        });
        const valWrap = el('span', 'ctl-val');
        const num = el('input', 'ctl-num mono', { type: 'text', inputmode: 'decimal', 'aria-label': t('studio.editValue', { label }), autocomplete: 'off' });
        valWrap.appendChild(num);
        if (param.unit) {
          const u = el('span', 'ctl-unit');
          u.textContent = param.unit;
          valWrap.appendChild(u);
        }
        head.appendChild(valWrap);
        row.appendChild(range);

        const paint = (v) => {
          range.style.setProperty('--pct', `${((v - param.min) / (param.max - param.min)) * 100}%`);
        };
        range.addEventListener('pointerdown', () => onDragging(true));
        range.addEventListener('input', () => {
          const v = Number(range.value);
          paint(v);
          num.value = v.toFixed(dec);
          commit(v);
        });
        range.addEventListener('change', () => onDragging(false));
        num.addEventListener('focus', () => num.select());
        num.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') num.blur();
          else if (e.key === 'Escape') { api.update(true); num.blur(); }
        });
        num.addEventListener('change', () => {
          const v = parseFloat(num.value.replace(',', '.'));
          if (Number.isFinite(v)) commit(Math.min(param.max, Math.max(param.min, v)));
          api.update(true);
        });
        api.update = () => {
          const v = store.get(path);
          if (document.activeElement !== range) range.value = String(v);
          if (document.activeElement !== num) num.value = Number(v).toFixed(dec);
          paint(v);
        };
        break;
      }
      case 'toggle': {
        const sw = el('input', 'switch', { type: 'checkbox', role: 'switch', id });
        head.appendChild(sw);
        sw.addEventListener('change', () => commit(sw.checked));
        api.update = () => { sw.checked = !!store.get(path); sw.setAttribute('aria-checked', String(sw.checked)); };
        break;
      }
      case 'select': {
        const wrap = el('div', 'select-wrap');
        const sel = el('select', 'select', { id });
        for (const o of param.options) {
          const opt = el('option');
          opt.value = o.value;
          opt.textContent = tl(o.label);
          sel.appendChild(opt);
        }
        wrap.appendChild(sel);
        row.appendChild(wrap);
        sel.addEventListener('change', () => commit(sel.value));
        api.update = () => { sel.value = String(store.get(path)); };
        break;
      }
      case 'color': {
        const line = el('div', 'color-row');
        const sw = el('input', 'swatch', { type: 'color', id, 'aria-label': label });
        const hex = el('input', 'input mono', { type: 'text', maxlength: 7, spellcheck: 'false', autocomplete: 'off', 'aria-label': `${label} (hex)` });
        const back = el('button', 'mini-btn', { type: 'button', 'aria-label': t('studio.reset'), title: t('studio.reset') });
        back.textContent = '↺';
        line.append(sw, hex, back);
        row.appendChild(line);
        const shown = () => store.get(path) ?? getTheme()[param.themeKey] ?? '#000000';
        sw.addEventListener('input', () => commit(sw.value));
        hex.addEventListener('change', () => {
          const n = normalizeHex(hex.value);
          if (n) commit(n);
          api.update(true);
        });
        back.addEventListener('click', reset);
        api.update = () => {
          const c = normalizeHex(shown()) || '#000000';
          if (document.activeElement !== sw) sw.value = c;
          if (document.activeElement !== hex) hex.value = c.toUpperCase();
          const isDefault = store.get(path) === param.default || (param.default === null && store.get(path) === null);
          back.hidden = isDefault;
          if (param.default === null) hex.title = isDefault ? t('studio.themeColor') : '';
        };
        break;
      }
      case 'colors': {
        const line = el('div', 'color-list');
        row.appendChild(line);
        const current = () => {
          const v = store.get(path);
          if (Array.isArray(v) && v.length) return v;
          const r = resolveColors(store.state.color, getTheme());
          return r.stops.map((c) => rgbToHex(c[0], c[1], c[2]));
        };
        const max = param.max || 3;
        const min = param.min || 2;
        const build = () => {
          line.textContent = '';
          const list = current();
          list.forEach((c, i) => {
            const sw = el('input', 'swatch', { type: 'color', 'aria-label': `${label} ${i + 1}`, value: c });
            if (i === 0) sw.id = id;
            sw.addEventListener('input', () => {
              const next = current().slice();
              next[i] = sw.value;
              commit(next);
            });
            line.appendChild(sw);
          });
          const add = el('button', 'mini-btn', { type: 'button', 'aria-label': '+' });
          add.textContent = '+';
          add.disabled = list.length >= max;
          add.addEventListener('click', () => { const l = current(); commit([...l, l[l.length - 1]]); build(); });
          const del = el('button', 'mini-btn', { type: 'button', 'aria-label': '−' });
          del.textContent = '−';
          del.disabled = list.length <= min;
          del.addEventListener('click', () => { commit(current().slice(0, -1)); build(); });
          const rst = el('button', 'mini-btn', { type: 'button', 'aria-label': t('studio.reset'), title: t('studio.reset') });
          rst.textContent = '↺';
          rst.hidden = store.get(path) === null;
          rst.addEventListener('click', () => { commit(null); build(); });
          line.append(add, del, rst);
        };
        api.update = (force) => {
          if (force || !line.contains(document.activeElement)) build();
        };
        break;
      }
      case 'text': {
        const input = el('input', 'input', {
          type: 'text', id, maxlength: Math.min(param.maxLength || LIMITS.maxStateString, LIMITS.maxStateString),
          autocomplete: 'off', spellcheck: 'false',
        });
        row.appendChild(input);
        input.addEventListener('input', () => commit(input.value));
        api.update = () => { if (document.activeElement !== input) input.value = String(store.get(path) ?? ''); };
        break;
      }
      case 'seed': {
        const line = el('div', 'seed-row');
        const input = el('input', 'input mono', { type: 'text', inputmode: 'numeric', id, autocomplete: 'off' });
        const dice = el('button', 'mini-btn', { type: 'button', 'aria-label': label, title: label });
        dice.textContent = '⚄';
        line.append(input, dice);
        row.appendChild(line);
        input.addEventListener('change', () => { commit(parseInt(input.value, 10)); api.update(true); });
        dice.addEventListener('click', () => { commit(Math.floor(Math.random() * 1e9)); api.update(true); });
        api.update = () => { if (document.activeElement !== input) input.value = String(store.get(path)); };
        break;
      }
      case 'button': {
        row.textContent = '';
        const b = el('button', 'btn btn-ghost btn-sm', { type: 'button', id });
        b.textContent = label;
        b.addEventListener('click', () => onAction?.(param.id));
        row.appendChild(b);
        break;
      }
      default:
        break;
    }
    return api;
  }

  // ---- one group -----------------------------------------------------------------------------
  function buildGroup({ id, tab, title, schema, pathOf, resetKey, hide = [] }) {
    const group = el('details', 'group');
    group.dataset.group = id;
    group.dataset.tab = tab;
    group.open = openState.has(id) ? openState.get(id) : true;
    group.addEventListener('toggle', () => openState.set(id, group.open));

    const head = el('summary', 'group-head');
    const ttl = el('span', 'group-title label');
    ttl.textContent = title;
    const rule = el('span', 'group-rule');
    const rst = el('button', 'group-reset', { type: 'button', 'aria-label': `${t('studio.resetGroup')}: ${title}`, title: t('studio.resetGroup') });
    rst.textContent = '↺';
    rst.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      store.resetGroup(resetKey);
      refresh(true);
    });
    head.append(ttl, rule, rst);
    group.appendChild(head);

    const body = el('div', 'group-body');
    group.appendChild(body);

    for (const param of schema) {
      if (hide.includes(param.id)) continue;
      const r = buildRow(param, pathOf(param.id));
      body.appendChild(r.el);
      rows.push({ ...r, group: id, resetKey });
    }
    return group;
  }

  // ---- tabs (mobile bottom sheet) -----------------------------------------------------------------
  function buildTabs(tabs) {
    tabsHost.textContent = '';
    tabsHost.setAttribute('role', 'tablist');
    for (const tab of tabs) {
      const b = el('button', 'sheet-tab', { type: 'button', role: 'tab', 'data-tab': tab, 'aria-selected': String(tab === activeTab) });
      b.textContent = t(`studio.tab.${tab}`);
      b.addEventListener('click', () => {
        activeTab = tab;
        panel.dataset.tab = tab;
        tabsHost.querySelectorAll('.sheet-tab').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      });
      tabsHost.appendChild(b);
    }
    if (!tabs.includes(activeTab)) activeTab = tabs[0];
    panel.dataset.tab = activeTab;
  }

  // ---- public ----------------------------------------------------------------------------------------
  function rebuild() {
    const mode = getMode();
    rows = [];
    host.textContent = '';

    const tabs = ['image', 'mode'];
    const inputGroup = extra.input?.();
    if (inputGroup) host.appendChild(inputGroup);

    if (mode.uses.includes('image')) {
      host.appendChild(buildGroup({
        id: 'image', tab: 'image', title: t('studio.group.image'), schema: IMAGE_PARAMS,
        pathOf: (pid) => `global.${pid}`, resetKey: 'global', hide: mode.hide || [],
      }));
    }
    host.appendChild(buildGroup({
      id: 'mode', tab: 'mode', title: t('studio.group.mode', { mode: tl(mode.name) }), schema: mode.params,
      pathOf: (pid) => `modes.${mode.id}.${pid}`, resetKey: 'mode',
    }));
    if (mode.uses.includes('color')) {
      tabs.push('color');
      host.appendChild(buildGroup({
        id: 'color', tab: 'color', title: t('studio.group.color'), schema: colorSchemaFor(mode),
        pathOf: (pid) => `color.${pid}`, resetKey: 'color',
      }));
    }
    const exportGroup = extra.export?.();
    if (exportGroup) {
      tabs.push('export');
      host.appendChild(exportGroup);
    }
    buildTabs(tabs);
    refresh(true);
  }

  /** Sync every row with the store and re-evaluate showIf. */
  function refresh(force = false) {
    const all = allParams();
    for (const r of rows) {
      r.update(force);
      if (typeof r.param.showIf === 'function') {
        const values = r.group === 'image' ? all.global : r.group === 'color' ? all.color : all.mode;
        let show = true;
        try { show = !!r.param.showIf(values, all); } catch { show = true; }
        r.el.hidden = !show;
      }
    }
  }

  return { rebuild, refresh };
}
