// Pixel sorting (PLAN.md 7.13): along parallel lines at any angle (Bresenham-style, the picture is never rotated),
// runs of pixels chosen by luma threshold, edges, random lengths or the whole line are sorted by a key (luma, hue,
// saturation, R, G, B). Runs in the heavy worker with progress and cancellation (see engine/pixelsort.js);
// "quantise" posterises after sorting, the COLOR group's palette mode snaps to a palette, `showMask` shows the runs.

import { resolveColors } from '../engine/color.js';
import { baseWidth, blockScale, presentPixels, workRatio } from '../engine/pixelkit.js';
import * as heavy from '../engine/heavy.js';

const COLOR_MODES = ['original', 'palette'];

const MODE = {
  id: 'pixelsort',
  category: 'pixel',
  name: { es: 'Pixel sorting', en: 'Pixel sorting' },
  blurb: { es: 'Ordena píxeles por líneas en cualquier ángulo', en: 'Sorts pixels along lines at any angle' },
  badges: [],
  animated: false,
  uses: ['image', 'color'],
  colorModes: COLOR_MODES,
  exports: ['png', 'video'],
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'drip', name: { es: 'Goteo vertical', en: 'Vertical drip' }, mode: { angle: 90, intervalMode: 'threshold', lower: 0.25, upper: 0.8, key: 'luma', order: 'asc', maxSpan: 600 } },
    { id: 'hue', name: { es: 'Arcoíris horizontal', en: 'Horizontal rainbow' }, mode: { angle: 0, intervalMode: 'full', key: 'hue', order: 'asc', maxSpan: 300, randomness: 0.3 } },
    { id: 'quantized', name: { es: 'Glitch cuantificado', en: 'Quantised glitch' }, mode: { angle: 35, intervalMode: 'edges', lower: 0.18, key: 'luma', order: 'desc', quantize: true, quantizeLevels: 6 } },
  ],

  params: [
    {
      id: 'angle', type: 'range', min: 0, max: 360, step: 1, default: 0, unit: '°',
      label: { es: 'Ángulo', en: 'Angle' },
      help: { es: '0° ordena de izquierda a derecha, 90° de arriba abajo.', en: '0° sorts left to right, 90° top to bottom.' },
    },
    {
      id: 'intervalMode', type: 'select', default: 'threshold',
      options: [
        { value: 'threshold', label: { es: 'Umbral de luminosidad', en: 'Luma threshold' } },
        { value: 'edges', label: { es: 'Bordes', en: 'Edges' } },
        { value: 'random', label: { es: 'Aleatorio', en: 'Random' } },
        { value: 'full', label: { es: 'Línea completa', en: 'Full line' } },
      ],
      label: { es: 'Intervalos', en: 'Intervals' },
      help: { es: 'Cómo se eligen los tramos de cada línea que se ordenan.', en: 'How the runs of each line that get sorted are chosen.' },
    },
    {
      id: 'lower', type: 'range', min: 0, max: 1, step: 0.01, default: 0.25,
      label: { es: 'Límite inferior / umbral de borde', en: 'Lower limit / edge threshold' },
      help: { es: 'Umbral: luminosidad mínima de los píxeles que se ordenan. Bordes: salto de luminosidad que corta un tramo.', en: 'Threshold: minimum luma of the pixels that get sorted. Edges: the luma jump that ends a run.' },
      showIf: (p) => p.intervalMode === 'threshold' || p.intervalMode === 'edges',
    },
    {
      id: 'upper', type: 'range', min: 0, max: 1, step: 0.01, default: 0.8,
      label: { es: 'Límite superior', en: 'Upper limit' },
      showIf: (p) => p.intervalMode === 'threshold',
    },
    {
      id: 'key', type: 'select', default: 'luma',
      options: [
        { value: 'luma', label: { es: 'Luminosidad', en: 'Luma' } },
        { value: 'hue', label: { es: 'Tono', en: 'Hue' } },
        { value: 'saturation', label: { es: 'Saturación', en: 'Saturation' } },
        { value: 'red', label: { es: 'Rojo', en: 'Red' } },
        { value: 'green', label: { es: 'Verde', en: 'Green' } },
        { value: 'blue', label: { es: 'Azul', en: 'Blue' } },
      ],
      label: { es: 'Ordenar por', en: 'Sort by' },
    },
    {
      id: 'order', type: 'select', default: 'asc',
      options: [{ value: 'asc', label: { es: 'Ascendente', en: 'Ascending' } }, { value: 'desc', label: { es: 'Descendente', en: 'Descending' } }],
      label: { es: 'Orden', en: 'Order' },
    },
    {
      id: 'maxSpan', type: 'range', min: 8, max: 2000, step: 1, default: 400, unit: 'px',
      label: { es: 'Longitud máxima del tramo', en: 'Maximum run length' },
    },
    {
      id: 'randomness', type: 'range', min: 0, max: 1, step: 0.01, default: 0,
      label: { es: 'Aleatoriedad', en: 'Randomness' },
      help: { es: 'Probabilidad de dejar un tramo sin ordenar.', en: 'Chance of leaving a run unsorted.' },
    },
    {
      id: 'quantize', type: 'toggle', default: false,
      label: { es: 'Cuantizar', en: 'Quantise' },
      help: { es: 'Posteriza el resultado después de ordenar (glitch cuantificado).', en: 'Posterises the result after sorting (quantised glitch).' },
    },
    {
      id: 'quantizeLevels', type: 'range', min: 2, max: 32, step: 1, default: 8,
      label: { es: 'Niveles', en: 'Levels' },
      showIf: (p) => p.quantize,
    },
    {
      id: 'showMask', type: 'toggle', default: false,
      label: { es: 'Mostrar máscara', en: 'Show mask' },
      help: { es: 'Muestra en blanco los píxeles que se ordenan.', en: 'Shows the pixels that get sorted in white.' },
    },
    {
      id: 'seed', type: 'seed', default: 5,
      label: { es: 'Semilla', en: 'Seed' },
      showIf: (p) => p.randomness > 0 || p.intervalMode === 'random',
    },
  ],

  /** Preview of a video is limited to 640 px wide (PLAN.md 7.13); exports use up to 2560 px. */
  resolution(params, srcW, srcH, opts = {}) {
    const cap = opts.isExport ? 2560 : opts.isVideo ? 640 : 1280;
    const W = baseWidth(srcW, cap);
    return { width: W, height: Math.max(1, Math.round((W * srcH) / srcW)) };
  },

  preOptions() {
    return { matte: '#000000', edgeBlend: 'light' };
  },

  init() {
    return { scratch: {}, mask: null };
  },

  async render(ctx, state) {
    const p = ctx.params.mode;
    const W = ctx.width;
    const H = ctx.height;
    const cr = resolveColors(ctx.params.color, ctx.theme, COLOR_MODES);
    const payload = {
      rgba: new Uint8ClampedArray(ctx.rgba.subarray(0, W * H * 4)), // a copy: it is moved to the worker
      w: W, h: H, angle: p.angle, intervalMode: p.intervalMode, lower: p.lower, upper: Math.max(p.upper, p.lower),
      key: p.key, order: p.order, maxSpan: p.maxSpan, randomness: p.randomness, seed: p.seed | 0,
      quantizeLevels: p.quantize ? p.quantizeLevels : 0,
      palette: cr.mode === 'palette' ? cr.palette : null,
      showMask: p.showMask,
    };
    const res = await heavy.run('pixelSort', payload, { signal: ctx.signal, transfer: [payload.rgba.buffer] });
    state.mask = res.mask;
    const ratio = workRatio(MODE, ctx);
    const { k, effectiveScale } = blockScale(ctx, ratio, 1, W, H);
    presentPixels(ctx, state.scratch, res.rgba, W, H, k);
    return { cols: W, rows: H, effectiveScale };
  },

  dispose(state) {
    if (state?.scratch?.canvas) { state.scratch.canvas.width = state.scratch.canvas.height = 1; state.scratch.canvas = null; }
    if (state) state.mask = null;
  },
};

export default MODE;
