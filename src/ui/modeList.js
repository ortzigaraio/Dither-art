// Studio mode picker (PLAN.md 4.3): grouped list on desktop, <select> on tablet, chips on mobile
// (the same buttons, restyled by CSS). Rebuilt when the language changes.

import { t, tl } from '../i18n/i18n.js';
import { modesByCategory } from '../modes/index.js';

export function createModeList({ listEl, selectEl, onSelect }) {
  let active = null;

  function build() {
    listEl.textContent = '';
    selectEl.textContent = '';
    for (const { category, modes } of modesByCategory()) {
      const group = document.createElement('div');
      group.className = 'mode-group';
      group.setAttribute('role', 'group');
      const headId = `mode-cat-${category}`;
      group.setAttribute('aria-labelledby', headId);

      const head = document.createElement('h3');
      head.className = 'mode-cat label';
      head.id = headId;
      head.textContent = t(`cat.${category}`);
      group.appendChild(head);

      const og = document.createElement('optgroup');
      og.label = t(`cat.${category}`);

      for (const mode of modes) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mode-item';
        btn.dataset.modeId = mode.id;
        btn.title = tl(mode.blurb);
        const eye = document.createElement('span');
        eye.className = 'eye';
        eye.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'mode-item-name';
        name.textContent = tl(mode.name);
        btn.append(eye, name);
        for (const b of mode.badges || []) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = b;
          btn.appendChild(badge);
        }
        btn.addEventListener('click', () => onSelect(mode.id));
        group.appendChild(btn);

        const opt = document.createElement('option');
        opt.value = mode.id;
        opt.textContent = tl(mode.name);
        og.appendChild(opt);
      }
      listEl.appendChild(group);
      selectEl.appendChild(og);
    }
    setActive(active);
  }

  function setActive(id) {
    active = id;
    listEl.querySelectorAll('.mode-item').forEach((b) => {
      if (b.dataset.modeId === id) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    if (id) selectEl.value = id;
  }

  selectEl.addEventListener('change', () => onSelect(selectEl.value));
  build();
  return { rebuild: build, setActive };
}
