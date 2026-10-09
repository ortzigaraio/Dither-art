// Thermography palettes (PLAN.md 7.11): every palette is a handful of anchor colours interpolated into a 256-entry
// look-up table (the same buildGradientLUT as the gradient colour mode). Viridis, Inferno, Magma, Plasma and Turbo use
// anchors sampled from the matplotlib / Google colour maps; the endpoints are exact.

import { hexToRgb, buildGradientLUT } from './color.js';
import { PALETTES } from './palettes.js';

export const THERMAL_PALETTES = {
  ironbow: { name: { es: 'Ironbow', en: 'Ironbow' }, stops: PALETTES.ironbow.colors },
  inferno: { name: { es: 'Inferno', en: 'Inferno' }, stops: ['#000004', '#160b39', '#420a68', '#6a176e', '#932667', '#bc3754', '#dd513a', '#f37819', '#fca50a', '#f6d746', '#fcffa4'] },
  magma: { name: { es: 'Magma', en: 'Magma' }, stops: ['#000004', '#140e36', '#3b0f70', '#641a80', '#8c2981', '#b73779', '#de4968', '#f7705c', '#fe9f6d', '#fecf92', '#fcfdbf'] },
  plasma: { name: { es: 'Plasma', en: 'Plasma' }, stops: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'] },
  viridis: { name: { es: 'Viridis', en: 'Viridis' }, stops: ['#440154', '#482878', '#3e4a89', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'] },
  turbo: { name: { es: 'Turbo', en: 'Turbo' }, stops: ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b', '#d1e834', '#f3c63a', '#fe9b2d', '#f36315', '#d93806', '#b11901', '#7a0403'] },
  jet: { name: { es: 'Arcoíris / Jet', en: 'Rainbow / Jet' }, stops: ['#00007f', '#0000ff', '#007fff', '#00ffff', '#7fff7f', '#ffff00', '#ff7f00', '#ff0000', '#7f0000'] },
  arctic: { name: { es: 'Ártica', en: 'Arctic' }, stops: ['#000000', '#001a4d', '#0050b3', '#1e90ff', '#7fe3ff', '#ffffff'] },
  whitehot: { name: { es: 'Blanco caliente', en: 'White hot' }, stops: ['#000000', '#ffffff'] },
  blackhot: { name: { es: 'Negro caliente', en: 'Black hot' }, stops: ['#ffffff', '#000000'] },
  lava: { name: { es: 'Lava', en: 'Lava' }, stops: ['#000000', '#3a0000', '#a00000', '#ff4500', '#ffa500', '#ffee66', '#ffffff'] },
  custom: { name: { es: 'Gradiente personalizado', en: 'Custom gradient' }, stops: ['#000000', '#ff3300', '#ffffff'] },
};

export const THERMAL_IDS = Object.keys(THERMAL_PALETTES);

const cache = new Map();

/** 256 x RGB look-up table (768 bytes) of a palette; `customStops` (hex strings) feeds the custom gradient. */
export function thermalLUT(id, customStops) {
  const stops = (id === 'custom' && Array.isArray(customStops) && customStops.length >= 2 ? customStops : THERMAL_PALETTES[id]?.stops || THERMAL_PALETTES.ironbow.stops)
    .map(hexToRgb).filter(Boolean);
  const key = `${id}|${stops.join(';')}`;
  let lut = cache.get(key);
  if (!lut) {
    lut = buildGradientLUT(stops.length >= 2 ? stops : [[0, 0, 0], [255, 255, 255]]);
    if (cache.size > 24) cache.clear();
    cache.set(key, lut);
  }
  return lut;
}

/** 0..1 temperature -> "30.0°C" for the fictional readout. */
export const formatTemp = (v, lo, hi) => `${(lo + v * (hi - lo)).toFixed(1)}°C`;

/** HSV (h in 0..1, s and v in 0..1) -> [r, g, b] in 0..255. */
export function hsvToRgb(h, s, v) {
  const hh = (h - Math.floor(h)) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255];
}
