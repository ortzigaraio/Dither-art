// File validation (PLAN.md 18.1): the real type is decided from magic bytes, never from the
// extension or file.type, and size/pixel limits are checked before anything gets decoded.

import { LIMITS } from '../config.js';

export class FileError extends Error {
  constructor(code, vars = {}) {
    super(code);
    this.name = 'FileError';
    this.code = code;     // i18n key suffix: err.<code>
    this.vars = vars;
  }
}

export const IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'gif', 'avif', 'bmp'];
export const VIDEO_FORMATS = ['mp4', 'webm', 'mov'];

const MIME = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

const str = (b, at, len) => {
  let s = '';
  for (let i = at; i < at + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
const u32be = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u16le = (b, at) => b[at] | (b[at + 1] << 8);
const u16be = (b, at) => (b[at] << 8) | b[at + 1];

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);
const MOV_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/**
 * Identify a file from its first bytes.
 * @returns {{kind:'image'|'video', format:string, mime:string} | {kind:'unknown', hint:string}}
 */
export function sniffBytes(b) {
  const unknown = (hint) => ({ kind: 'unknown', hint });
  const ok = (kind, format) => ({ kind, format, mime: MIME[format] });
  if (!b || b.length < 4) return unknown('short');

  // PNG
  if (b.length >= 8 && b[0] === 0x89 && str(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return ok('image', 'png');
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ok('image', 'jpeg');
  // GIF
  const g = str(b, 0, 6);
  if (g === 'GIF87a' || g === 'GIF89a') return ok('image', 'gif');
  // WebP: RIFF....WEBP
  if (str(b, 0, 4) === 'RIFF' && str(b, 8, 4) === 'WEBP') return ok('image', 'webp');
  // BMP: "BM", reserved fields zero, known DIB header size
  if (b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d && u32le(b, 6) === 0) {
    const dib = u32le(b, 14);
    if ([12, 40, 52, 56, 64, 108, 124].includes(dib)) return ok('image', 'bmp');
  }
  // ISO base media (MP4 / MOV / AVIF / HEIC)
  if (b.length >= 12 && str(b, 4, 4) === 'ftyp') {
    const major = str(b, 8, 4);
    const brands = [major];
    const boxEnd = Math.min(b.length, u32be(b, 0) || b.length);
    for (let i = 16; i + 4 <= boxEnd; i += 4) brands.push(str(b, i, 4));
    if (brands.includes('avif') || brands.includes('avis')) return ok('image', 'avif');
    if (brands.some((x) => HEIF_BRANDS.has(x))) return unknown('heic');
    if (major === 'qt  ') return ok('video', 'mov');
    if (AUDIO_BRANDS.has(major)) return unknown('audio');
    return ok('video', 'mp4');
  }
  // Old-style QuickTime without ftyp
  if (b.length >= 8 && MOV_ATOMS.has(str(b, 4, 4))) return ok('video', 'mov');
  // EBML: WebM vs Matroska
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = str(b, 0, Math.min(b.length, 64));
    if (head.includes('webm')) return ok('video', 'webm');
    return unknown('matroska');
  }
  // Things we recognise only to reject them with a clear reason
  if (str(b, 0, 4) === '%PDF') return unknown('pdf');
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  const head = str(b, i, 9).toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype')) return unknown('svg');
  return unknown('other');
}

/** Read the pixel size from the file header, or null when it cannot be known without decoding. */
export function readImageSize(b, format) {
  try {
    switch (format) {
      case 'png':
        return b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
      case 'gif':
        return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
      case 'bmp': {
        if (b.length < 26) return null;
        const dib = u32le(b, 14);
        if (dib === 12) return { width: u16le(b, 18), height: u16le(b, 20) };
        const w = u32le(b, 18) | 0;
        const h = u32le(b, 22) | 0;
        return { width: Math.abs(w), height: Math.abs(h) };
      }
      case 'webp': {
        const chunk = str(b, 12, 4);
        if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        if (chunk === 'VP8L' && b.length >= 25) {
          const bits = u32le(b, 21);
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X' && b.length >= 30) {
          return {
            width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
            height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
          };
        }
        return null;
      }
      case 'jpeg': {
        let i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) { i++; continue; }
          const m = b[i + 1];
          if (m === 0xff) { i++; continue; }
          if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
          const len = u16be(b, i + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
            return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
          }
          i += 2 + len;
        }
        return null;
      }
      case 'avif': {
        for (let i = 4; i + 16 <= b.length; i++) {
          if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) { // 'ispe'
            return { width: u32be(b, i + 8), height: u32be(b, i + 12) };
          }
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n % (1024 ** 3) === 0 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n % (1024 ** 2) === 0 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function readHead(file, n) {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}

/**
 * Validate a user file. Throws FileError; resolves to
 * `{ kind, format, mime, width, height, warnings }` (width/height may be null).
 */
export async function validateFile(file) {
  if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function') throw new FileError('unsupported');
  if (file.size === 0) throw new FileError('empty');

  const head = await readHead(file, LIMITS.sniffBytes);
  const type = sniffBytes(head);
  if (type.kind === 'unknown') throw new FileError('unsupported');

  const warnings = [];
  if (type.kind === 'image') {
    if (file.size > LIMITS.imageMaxBytes) throw new FileError('tooLarge', { max: formatBytes(LIMITS.imageMaxBytes) });
    let size = readImageSize(head, type.format);
    if (!size && (type.format === 'jpeg' || type.format === 'avif')) {
      const more = await readHead(file, type.format === 'jpeg' ? 262144 : 16384);
      size = readImageSize(more, type.format);
    }
    if (size && size.width * size.height > LIMITS.imageMaxPixels) {
      throw new FileError('tooManyPixels', { max: Math.round(LIMITS.imageMaxPixels / 1e6) });
    }
    if (size && (size.width === 0 || size.height === 0)) throw new FileError('decode');
    if (type.format === 'gif') warnings.push('gifFirstFrame');
    return { ...type, width: size?.width ?? null, height: size?.height ?? null, warnings };
  }

  if (file.size > LIMITS.videoMaxBytes) throw new FileError('tooLarge', { max: formatBytes(LIMITS.videoMaxBytes) });
  if (file.size > LIMITS.videoWarnBytes) warnings.push('bigVideo');
  return { ...type, width: null, height: null, warnings };
}
