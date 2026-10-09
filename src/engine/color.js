// Output colour: conversions, gradients, palette matching and the shared COLOR schema (PLAN.md 5.4).

import { PALETTES, PALETTE_IDS } from './palettes.js';

// ---------------------------------------------------------------------------
// Parsing and conversion
// ---------------------------------------------------------------------------

const HEX6 = /^#?([0-9a-f]{6})$/i;
const HEX3 = /^#?([0-9a-f]{3})$/i;

export function isHex(s) {
  return typeof s === 'string' && (HEX6.test(s) || HEX3.test(s));
}

/** '#abc' | 'abc' | '#aabbcc' -> [r,g,b] or null */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const s = hex.trim();
  let m = HEX6.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = HEX3.exec(s);
  if (m) {
    const [a, b, c] = m[1];
    return [parseInt(a + a, 16), parseInt(b + b, 16), parseInt(c + c, 16)];
  }
  return null;
}

export function rgbToHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Canonical '#rrggbb' (lowercase) or null. */
export function normalizeHex(s) {
  const rgb = hexToRgb(s);
  return rgb ? rgbToHex(rgb[0], rgb[1], rgb[2]) : null;
}

export const luma01 = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

export function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

// sRGB -> linear lookup
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0..255) -> CIE Lab (D65). */
export function rgbToLab(r, g, b) {
  const lr = LINEAR[r | 0];
  const lg = LINEAR[g | 0];
  const lb = LINEAR[b | 0];
  let x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047;
  let y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb;
  let z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883;
  const f = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** Extra saturation for the output only: boost 0..2 (1 = unchanged). */
export function boostSaturation(r, g, b, boost) {
  if (boost === 1) return [r, g, b];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [
    Math.max(0, Math.min(255, y + (r - y) * boost)),
    Math.max(0, Math.min(255, y + (g - y) * boost)),
    Math.max(0, Math.min(255, y + (b - y) * boost)),
  ];
}

// ---------------------------------------------------------------------------
// Gradients and palettes
// ---------------------------------------------------------------------------

/** 256-entry RGB lookup table (Uint8Array of 768) interpolating the stops evenly. */
export function buildGradientLUT(stops, n = 256) {
  const lut = new Uint8Array(n * 3);
  const last = stops.length - 1;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const pos = t * last;
    const k = Math.min(last - 1, Math.floor(pos));
    const c = last === 0 ? stops[0] : mixRgb(stops[k], stops[k + 1], pos - k);
    lut[i * 3] = c[0];
    lut[i * 3 + 1] = c[1];
    lut[i * 3 + 2] = c[2];
  }
  return lut;
}

/** Returns a function (r,g,b) -> palette index using Lab distance (or plain RGB). */
export function makePaletteMatcher(palette, metric = 'lab') {
  const n = palette.length;
  if (metric === 'rgb') {
    return (r, g, b) => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const p = palette[i];
        const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
  }
  const labs = palette.map((p) => rgbToLab(p[0], p[1], p[2]));
  return (r, g, b) => {
    const [L, A, B] = rgbToLab(r, g, b);
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const q = labs[i];
      const d = (L - q[0]) ** 2 + (A - q[1]) ** 2 + (B - q[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
}

/** Pull up to `max` hex colours out of free text ("#112233 #abc, ff00aa"). */
export function parseHexList(text, max = 64) {
  const out = [];
  const re = /#?[0-9a-f]{6}\b|#?[0-9a-f]{3}\b/gi;
  for (const m of String(text ?? '').matchAll(re)) {
    const rgb = hexToRgb(m[0]);
    if (rgb) out.push(rgb);
    if (out.length >= max) break;
  }
  return out;
}

export function getPaletteRGB(id, customText) {
  if (id === 'custom') {
    const list = parseHexList(customText);
    if (list.length >= 2) return list;
    return PALETTES.custom.colors.map(hexToRgb);
  }
  const pal = PALETTES[id] || PALETTES.horain;
  return pal.colors.map(hexToRgb);
}

// ---------------------------------------------------------------------------
// COLOR group schema (shared by every mode that declares `uses: ['color']`)
// ---------------------------------------------------------------------------

export const COLOR_MODE_OPTIONS = [
  { value: 'mono', label: { es: 'Monocromo', en: 'Monochrome' } },
  { value: 'original', label: { es: 'Color original', en: 'Original color' } },
  { value: 'gradient', label: { es: 'Gradiente', en: 'Gradient' } },
  { value: 'palette', label: { es: 'Paleta', en: 'Palette' } },
];

export const COLOR_PARAMS = [
  {
    id: 'colorMode', type: 'select', default: 'mono', options: COLOR_MODE_OPTIONS,
    label: { es: 'Modo de color', en: 'Color mode' },
    help: {
      es: 'Monocromo usa un solo color de tinta; Color original toma el color de la imagen; Gradiente colorea según la luminosidad; Paleta ajusta los colores a una paleta retro.',
      en: 'Monochrome uses one ink color; Original color takes the image color; Gradient colors by brightness; Palette snaps colors to a retro palette.',
    },
  },
  {
    id: 'ink', type: 'color', default: null, themeKey: 'ink',
    label: { es: 'Color de tinta', en: 'Ink color' },
    help: { es: 'Color de los caracteres. Sigue al tema hasta que elijas otro.', en: 'Color of the characters. Follows the theme until you pick another one.' },
    showIf: (p) => p.colorMode === 'mono',
  },
  {
    id: 'gradStops', type: 'colors', default: null, min: 2, max: 3,
    label: { es: 'Paradas del gradiente', en: 'Gradient stops' },
    help: { es: 'De 2 a 3 colores, de oscuro a claro.', en: '2 to 3 colors, from dark to bright.' },
    showIf: (p) => p.colorMode === 'gradient',
  },
  {
    id: 'palette', type: 'select', default: 'horain',
    options: PALETTE_IDS.map((id) => ({ value: id, label: PALETTES[id].name })),
    label: { es: 'Paleta', en: 'Palette' },
    showIf: (p) => p.colorMode === 'palette',
  },
  {
    id: 'customPalette', type: 'text', default: '#15181E #C4F169 #F7F8FA',
    label: { es: 'Colores (hex)', en: 'Colors (hex)' },
    help: { es: 'Lista de colores hex separados por espacios.', en: 'Hex colors separated by spaces.' },
    showIf: (p) => p.colorMode === 'palette' && p.palette === 'custom',
  },
  {
    id: 'colorBoost', type: 'range', min: 0, max: 200, step: 1, default: 100, unit: '%',
    label: { es: 'Saturación de salida', en: 'Output saturation' },
    help: { es: 'Saturación extra aplicada solo al color de salida.', en: 'Extra saturation applied only to the output color.' },
    showIf: (p) => p.colorMode === 'original' || p.colorMode === 'palette',
  },
  {
    id: 'bg', type: 'color', default: null, themeKey: 'bg',
    label: { es: 'Color de fondo', en: 'Background color' },
    help: { es: 'Fondo de la salida. Sigue al tema hasta que elijas otro.', en: 'Output background. Follows the theme until you pick another one.' },
    showIf: (p) => !p.bgTransparent,
  },
  {
    id: 'bgTransparent', type: 'toggle', default: false,
    label: { es: 'Fondo transparente', en: 'Transparent background' },
    help: { es: 'El PNG exportado y el visor muestran el fondo transparente.', en: 'The exported PNG and the viewer show a transparent background.' },
  },
];

/** COLOR schema restricted to the modes a given art mode supports. */
export function colorSchemaFor(mode) {
  const allowed = mode?.colorModes || COLOR_MODE_OPTIONS.map((o) => o.value);
  return COLOR_PARAMS.map((p) => (p.id === 'colorMode' ? { ...p, options: p.options.filter((o) => allowed.includes(o.value)) } : p));
}

/**
 * Turn stored colour params into ready-to-use numbers.
 * `theme` carries the current theme's `{ ink, bg }` hex strings.
 */
export function resolveColors(cp, theme, allowedModes) {
  let mode = cp.colorMode;
  if (allowedModes && !allowedModes.includes(mode)) mode = allowedModes[0] || 'mono';
  const ink = hexToRgb(cp.ink) || hexToRgb(theme.ink) || [196, 241, 105];
  const bg = hexToRgb(cp.bg) || hexToRgb(theme.bg) || [21, 24, 30];
  let stops = Array.isArray(cp.gradStops) ? cp.gradStops.map(hexToRgb).filter(Boolean) : [];
  if (stops.length < 2) stops = [mixRgb(bg, ink, 0.35), ink];
  return {
    mode,
    ink,
    bg,
    bgTransparent: !!cp.bgTransparent,
    stops,
    palette: getPaletteRGB(cp.palette, cp.customPalette),
    boost: Math.max(0, Math.min(2, (cp.colorBoost ?? 100) / 100)),
  };
}

/** True when the background reads as dark, which decides whether bright pixels get dense glyphs. */
export function isDarkBackground(resolved) {
  if (resolved.bgTransparent) return luma01(...resolved.ink) > 0.5;
  return luma01(...resolved.bg) < 0.5;
}
