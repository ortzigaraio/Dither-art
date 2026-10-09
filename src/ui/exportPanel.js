// "EXPORTAR" group of the studio panel: buttons depend on what the current mode can export (PLAN.md 6).

import { t } from '../i18n/i18n.js';

// Buttons offered for the file formats a mode declares in `exports` (PNG and video have their own controls)
export const TEXT_FORMATS = ['txt', 'html', 'ansi', 'ans', 'svg', 'json'];

// SVG page options of the vector modes (`mode.svgOptions`), kept while the panel is rebuilt (io/exportSVG.js)
const svgPrefs = { page: 'px', orientation: 'auto', margin: 10, customW: 210, customH: 297, plotter: false, optimize: true };
export const getSvgPrefs = () => ({ ...svgPrefs });

/**
 * @param {object} mode current mode module
 * @param {{ png:(scale:number)=>void, text:(format:string, opts?:object)=>void, copyText:()=>void,
 *           copyImage:()=>void, share:()=>void, video:()=>void }} actions
 * @param {{ video?: boolean }} [opts] video: this source and mode can be exported as a video
 */
export function createExportGroup(mode, actions, opts = {}) {
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

  if (exports.has('svg') && mode.svgOptions) body.appendChild(svgOptionsBlock(select));

  const textFormats = TEXT_FORMATS.filter((f) => exports.has(f));
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
      const opts = () => (f === 'ansi' ? { depth: Number(ansiDepth) } : f === 'svg' && mode.svgOptions ? getSvgPrefs() : {});
      grid.appendChild(button(f, t(`export.${f}`), () => actions.text(f, opts())));
    }
    body.appendChild(grid);
  }

  if (opts.video) {
    body.appendChild(button('video', t('export.video'), actions.video, 'btn btn-primary btn-sm'));
  }

  const copy = document.createElement('div');
  copy.className = 'export-grid';
  if (exports.has('txt')) copy.appendChild(button('copy-text', t('export.copyText'), actions.copyText));
  if (exports.has('png')) copy.appendChild(button('copy-image', t('export.copyImage'), actions.copyImage));
  copy.appendChild(button('share', t('export.share'), actions.share));
  body.appendChild(copy);

  return group;
}

/** Page size, orientation, margin, custom size, plotter mode and stroke ordering for the SVG of a vector mode. */
function svgOptionsBlock(select) {
  const box = document.createElement('div');
  box.className = 'export-svg';
  box.dataset.export = 'svg-options';

  const page = select('export.svgPage', [['px', 'export.svgPage.px'], ['a4', 'export.svgPage.a4'], ['a3', 'export.svgPage.a3'],
    ['letter', 'export.svgPage.letter'], ['custom', 'export.svgPage.custom']], (v) => { svgPrefs.page = v; sync(); });
  page.sel.dataset.export = 'svg-page';
  const orient = select('export.svgOrient', [['auto', 'export.svgOrient.auto'], ['portrait', 'export.svgOrient.portrait'],
    ['landscape', 'export.svgOrient.landscape']], (v) => { svgPrefs.orientation = v; });
  orient.sel.dataset.export = 'svg-orientation';
  const margin = select('export.svgMargin', [0, 5, 10, 15, 20, 25].map((n) => [String(n), `export.mm${n}`]), (v) => { svgPrefs.margin = Number(v); });
  margin.sel.dataset.export = 'svg-margin';

  const number = (key, prop) => {
    const row = document.createElement('div');
    row.className = 'ctl export-row';
    const id = `exp-svg-${prop}`;
    const lab = document.createElement('label');
    lab.className = 'ctl-label';
    lab.htmlFor = id;
    lab.textContent = t(key);
    const input = document.createElement('input');
    input.className = 'input mono';
    input.type = 'number';
    input.id = id;
    input.min = '10';
    input.max = '2000';
    input.step = '1';
    input.value = String(svgPrefs[prop]);
    input.dataset.export = `svg-${prop}`;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      svgPrefs[prop] = Number.isFinite(v) ? Math.min(2000, Math.max(10, v)) : svgPrefs[prop];
      input.value = String(svgPrefs[prop]);
    });
    row.append(lab, input);
    return row;
  };
  const customW = number('export.svgWidth', 'customW');
  const customH = number('export.svgHeight', 'customH');

  const check = (key, prop) => {
    const row = document.createElement('div');
    row.className = 'ctl ctl-toggle';
    const head = document.createElement('div');
    head.className = 'ctl-head';
    const id = `exp-svg-${prop}`;
    const lab = document.createElement('label');
    lab.className = 'ctl-label';
    lab.htmlFor = id;
    lab.textContent = t(key);
    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'switch';
    sw.setAttribute('role', 'switch');
    sw.id = id;
    sw.checked = !!svgPrefs[prop];
    sw.setAttribute('aria-checked', String(sw.checked));
    sw.dataset.export = `svg-${prop}`;
    sw.addEventListener('change', () => { svgPrefs[prop] = sw.checked; sw.setAttribute('aria-checked', String(sw.checked)); });
    head.append(lab, sw);
    row.appendChild(head);
    return row;
  };

  page.sel.value = svgPrefs.page;
  orient.sel.value = svgPrefs.orientation;
  margin.sel.value = String(svgPrefs.margin);
  const sync = () => {
    const paged = svgPrefs.page !== 'px';
    orient.row.hidden = !paged || svgPrefs.page === 'custom';
    margin.row.hidden = !paged;
    customW.hidden = customH.hidden = svgPrefs.page !== 'custom';
  };
  sync();
  box.append(page.row, orient.row, customW, customH, margin.row, check('export.svgPlotter', 'plotter'), check('export.svgOptimize', 'optimize'));
  return box;
}
