// PNG export and clipboard helpers (PLAN.md 9.1).

import { LIMITS } from '../config.js';

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), type, quality);
  });
}

/**
 * Largest scale <= `scale` whose longest side should stay within the export limit.
 * `w1`/`h1` are the output size at scale 1. Modes round cell sizes to whole pixels at every scale, so this is
 * an estimate with a safety margin: callers must check the real size and call it again (see shrinkToLimit).
 */
export function fitExportScale(w1, h1, scale, maxSide = LIMITS.maxExportImageSide) {
  const longest = Math.max(w1, h1) * scale;
  if (longest <= maxSide) return { scale, clamped: false };
  return { scale: Math.max(0.01, (maxSide / Math.max(w1, h1)) * 0.96), clamped: true };
}

/** Scale to retry with when a render of `longest` px came out above the limit at `scale`. */
export function shrinkToLimit(scale, longest, maxSide = LIMITS.maxExportImageSide) {
  return scale * (maxSide / longest) * 0.98;
}

/** Copy a PNG blob to the clipboard. Resolves false when the browser refuses (permissions, Safari...). */
export async function copyImageBlob(blob) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
