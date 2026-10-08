// Dropzone: click, drag & drop (anywhere in the document), paste (Ctrl/Cmd+V) and demo.
// Files go through `onFile`, which validates them (io/validate.js) before anything is decoded.

import { t, onLangChange } from '../i18n/i18n.js';
import { toast } from './toast.js';

const IMAGE_TYPE = /^image\//;

/**
 * @param {{ onFile: (file: File) => void, onDemo: () => void }} hooks
 * @returns {{ openPicker: () => void, addAction: (a: {id:string,labelKey:string,run:()=>void,primary?:boolean}) => void }}
 */
export function initDropzone({ onFile, onDemo }) {
  const zone = document.getElementById('dropzone');
  const pick = document.getElementById('dz-pick');
  const input = document.getElementById('file-input');
  const actionsHost = document.getElementById('dz-actions');
  const actions = [];

  function openPicker() {
    input.value = '';
    input.click();
  }

  function handleFiles(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    if (files.length > 1) toast(t('err.multi'), { type: 'warn' });
    onFile(files[0]);
  }

  // ---- buttons (Phase 2 adds the camera through addAction) ----
  function renderActions() {
    actionsHost.textContent = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'}`;
      b.dataset.action = a.id;
      b.textContent = t(a.labelKey);
      b.addEventListener('click', a.run);
      actionsHost.appendChild(b);
    }
  }
  function addAction(a) {
    actions.push(a);
    renderActions();
  }

  addAction({ id: 'demo', labelKey: 'dz.demo', run: () => onDemo(), primary: true });
  addAction({
    id: 'paste',
    labelKey: 'dz.paste',
    run: async () => {
      try {
        if (!navigator.clipboard?.read) throw new Error('unsupported');
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((x) => IMAGE_TYPE.test(x));
          if (type) {
            const blob = await item.getType(type);
            handleFiles([new File([blob], 'pasted-image', { type })]);
            return;
          }
        }
        toast(t('dz.pasteEmpty'), { type: 'warn' });
      } catch {
        toast(t('dz.pasteHint'));
      }
    },
  });
  onLangChange(renderActions);

  // ---- click / keyboard ----
  pick.addEventListener('click', openPicker);
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    handleFiles(files);
  });

  // ---- drag & drop: the whole document accepts files ----
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let depth = 0;
  const clear = () => {
    depth = 0;
    document.body.classList.remove('is-dragging');
    zone.classList.remove('is-dragover');
  };
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('is-dragging');
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.toggle('is-dragover', zone.contains(e.target));
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) clear();
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const files = e.dataTransfer.files;
    clear();
    handleFiles(files);
  });
  window.addEventListener('blur', clear);

  // ---- paste ----
  document.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => IMAGE_TYPE.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    handleFiles(files);
  });

  return { openPicker, addAction };
}
