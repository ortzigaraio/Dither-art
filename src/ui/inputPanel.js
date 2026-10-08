// "ENTRADA" group of the studio panel: what is loaded and a button to change it.
// Every string goes through t(); the file name is user text, so it is set with textContent only.

import { t } from '../i18n/i18n.js';

export function createInputGroup(source, { onChange }) {
  const group = document.createElement('details');
  group.className = 'group';
  group.dataset.group = 'input';
  group.dataset.tab = 'image';
  group.open = true;

  const head = document.createElement('summary');
  head.className = 'group-head';
  const title = document.createElement('span');
  title.className = 'group-title label';
  title.textContent = t('studio.input');
  const rule = document.createElement('span');
  rule.className = 'group-rule';
  head.append(title, rule);

  const body = document.createElement('div');
  body.className = 'group-body';

  const info = document.createElement('div');
  info.className = 'src-line';
  const name = document.createElement('span');
  name.className = 'src-name';
  const kindKey = source.kind === 'demo' ? 'studio.source.demo' : source.kind === 'video' ? 'studio.source.video' : 'studio.source.image';
  name.textContent = source.kind === 'demo' ? t('studio.source.demo') : source.name;
  const dims = document.createElement('span');
  const size = `${source.width}×${source.height}`;
  const bits = source.kind === 'demo' ? [size] : [t(kindKey), size];
  if (source.downscaled) bits.push(`↓ ${source.originalWidth}×${source.originalHeight}`);
  dims.textContent = bits.join(' · ');
  info.append(name, dims);

  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'btn btn-ghost btn-sm';
  change.id = 'change-file';
  change.textContent = t('studio.change');
  change.addEventListener('click', onChange);

  body.append(info, change);
  group.append(head, body);
  return group;
}
