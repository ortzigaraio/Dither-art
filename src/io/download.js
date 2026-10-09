// Blob download with the "<slug>-<mode>-<YYYYMMDD-HHMMSS>.<ext>" naming scheme (PLAN.md 9.1; slug = config.fileSlug).

import { config } from '../config.js';

export function timestamp(d = new Date()) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function exportName(modeId, ext) {
  return `${config.fileSlug}-${modeId}-${timestamp()}.${ext}`;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}
