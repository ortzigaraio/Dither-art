// Confirmation before the optional AI depth model is downloaded (PLAN.md 5.5, 18.3): what is downloaded, how big,
// from where, that it is cached by the browser, and that the picture itself never leaves the device.
// Built with DOM calls and textContent only.

import { t } from '../i18n/i18n.js';
import { AI_SIZE_LABEL } from '../engine/depth.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Resolves true when the user accepts the download, false when they cancel or close the dialog. */
export function confirmDepthDownload() {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'dialog');
    dlg.id = 'depth-dialog';
    dlg.setAttribute('aria-labelledby', 'depth-dlg-title');
    dlg.setAttribute('aria-describedby', 'depth-dlg-text');
    const body = el('div', 'dlg-body');
    const title = el('h2', 'dlg-title display', t('depth.dlg.title'));
    title.id = 'depth-dlg-title';
    const text = el('p', 'dlg-summary', t('depth.dlg.text', { size: AI_SIZE_LABEL }));
    text.id = 'depth-dlg-text';
    const warns = el('ul', 'dlg-warns');
    for (const key of ['depth.dlg.once', 'depth.dlg.private', 'depth.dlg.slow']) warns.appendChild(el('li', 'dlg-warn', t(key)));
    const size = el('p', 'dlg-summary mono', t('depth.dlg.size', { size: AI_SIZE_LABEL }));
    size.dataset.depthSize = AI_SIZE_LABEL;
    const actions = el('div', 'dlg-actions');
    const cancel = el('button', 'btn btn-ghost btn-sm', t('depth.dlg.cancel'));
    cancel.type = 'button';
    cancel.dataset.depthDialog = 'cancel';
    const ok = el('button', 'btn btn-primary btn-sm', t('depth.dlg.download'));
    ok.type = 'button';
    ok.dataset.depthDialog = 'download';
    actions.append(cancel, ok);
    body.append(title, text, size, warns, actions);
    dlg.appendChild(body);

    let answered = false;
    const finish = (v) => {
      if (answered) return;
      answered = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(v);
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    dlg.addEventListener('close', () => finish(false));
    document.body.appendChild(dlg);
    dlg.showModal();
    ok.focus();
  });
}
