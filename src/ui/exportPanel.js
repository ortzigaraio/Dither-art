// "EXPORTAR" group of the studio panel: buttons depend on what the current mode can export (PLAN.md 6).

import { t } from '../i18n/i18n.js';

/**
 * @param {object} mode current mode module
 * @param {{ png:(scale:number)=>void, text:(format:string, opts?:object)=>void, copyText:()=>void,
 *           copyImage:()=>void, share:()=>void }} actions
 */
export function createExportGroup(mode, actions) {
  const exports = new Set(mode.exports || []);
  const group = document.createElement('details');
  group.className = 'group';
  group.dataset.group = 'export';
  group.dataset.tab = 'export';
  group.open = true;

  const head = document.createElement('summary');
  head.className = 'group-head';
  const title = document.createElement('span');
  title.className = 'group-title label';
  title.textContent = t('studio.group.export');
  const rule = document.createElement('span');
  rule.className = 'group-rule';
  head.append(title, rule);
  group.appendChild(head);

  const body = document.createElement('div');
  body.className = 'group-body';
  group.appendChild(body);

  const button = (key, label, onClick, cls = 'btn btn-ghost btn-sm') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.dataset.export = key;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  const select = (labelKey, options, onChange) => {
    const row = document.createElement('div');
    row.className = 'ctl export-row';
    const id = `exp-${labelKey.replace(/\W/g, '')}`;
    const lab = document.createElement('label');
    lab.className = 'ctl-label';
    lab.htmlFor = id;
    lab.textContent = t(labelKey);
    const wrap = document.createElement('div');
    wrap.className = 'select-wrap';
    const sel = document.createElement('select');
    sel.className = 'select';
    sel.id = id;
    for (const [value, key] of options) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = t(key);
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange?.(sel.value));
    wrap.appendChild(sel);
    row.append(lab, wrap);
    return { row, sel };
  };

  if (exports.has('png')) {
    const scale = select('export.scale', [['1', 'export.scale.1'], ['2', 'export.scale.2'], ['4', 'export.scale.4']]);
    scale.sel.dataset.export = 'png-scale';
    body.appendChild(scale.row);
    body.appendChild(button('png', t('export.png'), () => actions.png(Number(scale.sel.value)), 'btn btn-primary btn-sm'));
  }

  const textFormats = ['txt', 'html', 'ansi'].filter((f) => exports.has(f));
  let ansiDepth = '24';
  if (exports.has('ansi')) {
    const depth = select('export.ansiDepth', [['24', 'export.ansi.24'], ['256', 'export.ansi.256'], ['16', 'export.ansi.16']], (v) => { ansiDepth = v; });
    depth.sel.dataset.export = 'ansi-depth';
    body.appendChild(depth.row);
  }
  if (textFormats.length) {
    const grid = document.createElement('div');
    grid.className = 'export-grid';
    for (const f of textFormats) {
      grid.appendChild(button(f, t(`export.${f}`), () => actions.text(f, f === 'ansi' ? { depth: Number(ansiDepth) } : {})));
    }
    body.appendChild(grid);
  }

  const copy = document.createElement('div');
  copy.className = 'export-grid';
  if (exports.has('txt')) copy.appendChild(button('copy-text', t('export.copyText'), actions.copyText));
  if (exports.has('png')) copy.appendChild(button('copy-image', t('export.copyImage'), actions.copyImage));
  copy.appendChild(button('share', t('export.share'), actions.share));
  body.appendChild(copy);

  return group;
}
