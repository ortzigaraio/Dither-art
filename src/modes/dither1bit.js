// Dithering 1-bit (PLAN.md 7.7): reduces the picture to two inks (or N tone levels between them) with ordered
// dithering (Bayer, blue noise, random: main thread), error diffusion (every kernel of 5.3: heavy worker above a
// size threshold) or plain thresholding. Each work pixel becomes a pixelSize x pixelSize block, scaled with
// nearest neighbour so the pixels stay sharp.

import { DITHER_OPTIONS, quantize, isErrorDiffusion } from '../engine/dither.js';
import { hexToRgb } from '../engine/color.js';
import { baseWidth, blockScale, presentPixels, workRatio } from '../engine/pixelkit.js';
import * as heavy from '../engine/heavy.js';

const HEAVY_PIXELS = 60000; // error diffusion above this runs in the worker (PLAN.md 15: 1080p < 300 ms there)

/** dark -> light pairs of the "ink and paper" presets of PLAN.md 7.7 */
export const TONES = {
  mac: { dark: '#000000', light: '#ffffff', name: { es: 'Macintosh', en: 'Macintosh' } },
  gameboy: { dark: '#0f380f', light: '#9bbc0f', name: { es: 'Game Boy', en: 'Game Boy' } },
  obradinn: { dark: '#333319', light: '#e5ffff', name: { es: 'Obra Dinn', en: 'Obra Dinn' } },
  amber: { dark: '#000000', light: '#ffb000', name: { es: 'Ámbar', en: 'Amber' } },
  phosphor: { dark: '#000000', light: '#39ff6a', name: { es: 'Fósforo verde', en: 'Green phosphor' } },
  custom: { dark: '#15181e', light: '#c4f169', name: { es: 'Personalizado', en: 'Custom' } },
};

const toneOptions = Object.entries(TONES).map(([value, v]) => ({ value, label: v.name }));

export function toneColors(p) {
  const tone = TONES[p.tone] || TONES.mac;
  const dark = hexToRgb(p.tone === 'custom' ? p.darkColor : tone.dark) || hexToRgb(tone.dark);
  const light = hexToRgb(p.tone === 'custom' ? p.lightColor : tone.light) || hexToRgb(tone.light);
  return { dark, light };
}

const MODE = {
  id: 'dither1bit',
  category: 'pixel',
  name: { es: 'Dithering 1-bit', en: '1-bit Dithering' },
  blurb: { es: 'Dos tintas y tramado ordenado o por difusión de error', en: 'Two inks with ordered or error-diffusion dithering' },
  badges: [],
  animated: false,
  uses: ['image'],
  exports: ['png', 'video'],
  hide: ['cols', 'dither', 'serpentine'], // the mode has its own algorithm and resolution (pixel size)

  presets: [
    { id: 'mac', name: { es: 'Macintosh', en: 'Macintosh' }, mode: { tone: 'mac', algorithm: 'atkinson', pixelSize: 2, levels: 2, perChannel: false } },
    { id: 'gameboy', name: { es: 'Game Boy', en: 'Game Boy' }, mode: { tone: 'gameboy', algorithm: 'bayer4', pixelSize: 3, levels: 4, perChannel: false } },
    { id: 'obradinn', name: { es: 'Obra Dinn', en: 'Obra Dinn' }, mode: { tone: 'obradinn', algorithm: 'blue-noise', pixelSize: 2, levels: 2, perChannel: false } },
    { id: 'amber', name: { es: 'Terminal ámbar', en: 'Amber terminal' }, mode: { tone: 'amber', algorithm: 'bayer8', pixelSize: 2, levels: 2, perChannel: false } },
    { id: 'phosphor', name: { es: 'Fósforo verde', en: 'Green phosphor' }, mode: { tone: 'phosphor', algorithm: 'floyd-steinberg', pixelSize: 2, levels: 2, perChannel: false } },
  ],

  params: [
    {
      id: 'algorithm', type: 'select', default: 'bayer4', options: DITHER_OPTIONS,
      label: { es: 'Algoritmo', en: 'Algorithm' },
      help: { es: 'Bayer y ruido azul son ordenados (rápidos); el resto difunde el error entre píxeles.', en: 'Bayer and blue noise are ordered (fast); the rest diffuse the error between pixels.' },
    },
    {
      id: 'serpentine', type: 'toggle', default: false,
      label: { es: 'Serpentina', en: 'Serpentine' },
      showIf: (p) => isErrorDiffusion(p.algorithm),
    },
    {
      id: 'seed', type: 'seed', default: 7,
      label: { es: 'Semilla', en: 'Seed' },
      showIf: (p) => p.algorithm === 'random',
    },
    {
      id: 'pixelSize', type: 'range', min: 1, max: 16, step: 1, default: 2, unit: 'px',
      label: { es: 'Tamaño de píxel', en: 'Pixel size' },
      help: { es: 'Cada píxel del tramado se dibuja como un bloque de este tamaño.', en: 'Each dithered pixel is drawn as a block of this size.' },
    },
    {
      id: 'levels', type: 'range', min: 2, max: 8, step: 1, default: 2,
      label: { es: 'Niveles', en: 'Levels' },
      help: { es: '2 = solo tinta y papel; más niveles añaden tonos intermedios.', en: '2 = ink and paper only; more levels add in-between tones.' },
    },
    {
      id: 'bias', type: 'range', min: -0.5, max: 0.5, step: 0.01, default: 0,
      label: { es: 'Sesgo', en: 'Bias' },
      help: { es: 'Desplaza el umbral: valores positivos aclaran el resultado.', en: 'Shifts the threshold: positive values lighten the result.' },
    },
    {
      id: 'perChannel', type: 'toggle', default: false,
      label: { es: 'Por canal RGB', en: 'Per RGB channel' },
      help: { es: 'Tramado independiente de rojo, verde y azul: aspecto retro en color.', en: 'Dithers red, green and blue independently: a colour retro look.' },
    },
    {
      id: 'tone', type: 'select', default: 'mac', options: toneOptions,
      label: { es: 'Tinta y papel', en: 'Ink and paper' },
    },
    {
      id: 'darkColor', type: 'color', default: '#15181e',
      label: { es: 'Color oscuro', en: 'Dark color' },
      showIf: (p) => p.tone === 'custom',
    },
    {
      id: 'lightColor', type: 'color', default: '#c4f169',
      label: { es: 'Color claro', en: 'Light color' },
      showIf: (p) => p.tone === 'custom',
    },
  ],

  resolution(params, srcW, srcH, opts = {}) {
    const unit = Math.max(1, Math.round(params.mode.pixelSize));
    const base = baseWidth(srcW, opts.isExport ? 2560 : 1280);
    const W = Math.max(1, Math.round(base / unit));
    return { width: W, height: Math.max(1, Math.round((W * srcH) / srcW)) };
  },

  init() {
    return { scratch: {}, buf: null };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const W = ctx.width;
    const H = ctx.height;
    const n = W * H;
    const levels = Math.max(2, Math.min(8, Math.round(p.levels)));
    const { dark, light } = toneColors(p);
    const opts = { serpentine: p.serpentine, seed: p.seed | 0, bias: p.bias };
    const useWorker = isErrorDiffusion(p.algorithm) && n > HEAVY_PIXELS;
    const run = (buffer) => (useWorker
      ? heavy.run('quantize', { buffer, w: W, h: H, levels, algorithm: p.algorithm, opts }, { signal: ctx.signal })
      : quantize(buffer, W, H, levels, p.algorithm, opts));

    const out = state.buf && state.buf.length === n * 4 ? state.buf : (state.buf = new Uint8ClampedArray(n * 4));
    const max = levels - 1;
    if (!p.perChannel) {
      const idx = await run(Float32Array.from(ctx.luma()));
      const lut = new Uint8ClampedArray(levels * 3);
      for (let l = 0; l < levels; l++) for (let c = 0; c < 3; c++) lut[l * 3 + c] = dark[c] + (light[c] - dark[c]) * (l / max);
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const l = idx[i] * 3;
        out[o] = lut[l]; out[o + 1] = lut[l + 1]; out[o + 2] = lut[l + 2]; out[o + 3] = 255;
      }
    } else {
      const rgba = ctx.rgba;
      const planes = [0, 1, 2].map((c) => {
        const b = new Float32Array(n);
        for (let i = 0; i < n; i++) b[i] = rgba[i * 4 + c] / 255;
        return b;
      });
      const idx = await Promise.all(planes.map(run));
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        for (let c = 0; c < 3; c++) out[o + c] = dark[c] + (light[c] - dark[c]) * (idx[c][i] / max);
        out[o + 3] = 255;
      }
    }

    const ratio = workRatio(MODE, ctx);
    const unit = Math.max(1, Math.round(p.pixelSize));
    const { k, effectiveScale } = blockScale(ctx, ratio, unit, W, H);
    presentPixels(ctx, state.scratch, out, W, H, k);
    return { cols: W, rows: H, effectiveScale };
  },

  dispose(state) {
    if (state?.scratch?.canvas) { state.scratch.canvas.width = state.scratch.canvas.height = 1; state.scratch.canvas = null; }
    if (state) state.buf = null;
  },
};

export default MODE;
