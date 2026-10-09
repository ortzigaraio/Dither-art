// Glitch art (PLAN.md 7.12): combinable effects (RGB split, band shift, block corruption, bit crush, DCT artefacts,
// scanlines, noise, interlace), each with its own intensity. Deterministic: the pixels depend only on the picture, the
// seed and (with `animate`) on the frame time, so exports reproduce the preview. Implemented on the CPU (PLAN.md 19).

import { applyGlitch } from '../engine/glitch.js';
import { baseWidth, blockScale, mixSeed, presentPixels, workRatio } from '../engine/pixelkit.js';

const intensity = (id, es, en, def, help) => ({
  id, type: 'range', min: 0, max: 1, step: 0.01, default: def, label: { es, en }, ...(help ? { help } : {}),
});

/** The seed of a frame: with `animate` it changes `rate` times per second of frame time. */
export const frameSeed = (p, time) => (p.animate ? mixSeed(p.seed, Math.floor(Math.max(0, time) * p.rate + 1e-6)) : p.seed >>> 0);

const MODE = {
  id: 'glitch',
  category: 'pixel',
  name: { es: 'Glitch art', en: 'Glitch art' },
  blurb: { es: 'Separación RGB, franjas, bloques corruptos y artefactos', en: 'RGB split, stripes, corrupt blocks and artefacts' },
  badges: ['ANIM'],
  animated: false,
  animatedWhen: (p) => !!p.animate,
  uses: ['image'],
  exports: ['png', 'video'],
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'vhs', name: { es: 'Cinta VHS', en: 'VHS tape' }, mode: { rgbSplit: 0.3, bandShift: 0.35, scanlines: 0.4, noise: 0.2, interlace: 0.3, bitCrush: 0, blockCorrupt: 0, dct: 0 } },
    { id: 'datamosh', name: { es: 'Datamosh', en: 'Datamosh' }, mode: { rgbSplit: 0.1, bandShift: 0, blockCorrupt: 0.6, blockSize: '16', dct: 0.4, noise: 0, scanlines: 0 } },
    { id: 'broken', name: { es: 'Señal rota', en: 'Broken signal' }, mode: { rgbSplit: 0.6, bandShift: 0.7, bitCrush: 0.5, noise: 0.35, animate: true, rate: 10 } },
  ],

  params: [
    intensity('rgbSplit', 'Separación RGB', 'RGB split', 0.35, { es: 'Desplaza los canales rojo y azul en direcciones opuestas.', en: 'Moves the red and blue channels in opposite directions.' }),
    intensity('bandShift', 'Franjas desplazadas', 'Stripe shift', 0.3, { es: 'Franjas horizontales que se desplazan de lado.', en: 'Horizontal stripes that slide sideways.' }),
    intensity('blockCorrupt', 'Bloques corruptos', 'Block corruption', 0, { es: 'Macrobloques repetidos o desplazados, al estilo datamosh.', en: 'Repeated or displaced macroblocks, datamosh style.' }),
    {
      id: 'blockSize', type: 'select', default: '16',
      options: [{ value: '8', label: { es: '8 px', en: '8 px' } }, { value: '16', label: { es: '16 px', en: '16 px' } }],
      label: { es: 'Tamaño de bloque', en: 'Block size' },
      showIf: (p) => p.blockCorrupt > 0,
    },
    intensity('bitCrush', 'Bit-crush', 'Bit crush', 0, { es: 'Reduce los bits por canal, de 8 a 1.', en: 'Reduces the bits per channel, from 8 down to 1.' }),
    intensity('dct', 'Artefactos DCT', 'DCT artefacts', 0, { es: 'Bloques de 8×8 cuantizados como en un JPEG muy comprimido.', en: '8×8 blocks quantised like a heavily compressed JPEG.' }),
    intensity('scanlines', 'Líneas de barrido', 'Scanlines', 0),
    intensity('noise', 'Ruido', 'Noise', 0.1),
    intensity('interlace', 'Entrelazado', 'Interlace', 0, { es: 'Las filas impares se desplazan y se atenúan.', en: 'Odd rows slide and dim.' }),
    {
      id: 'seed', type: 'seed', default: 1,
      label: { es: 'Semilla', en: 'Seed' },
      help: { es: 'La misma semilla da siempre el mismo resultado.', en: 'The same seed always gives the same result.' },
    },
    {
      id: 'animate', type: 'toggle', default: false,
      label: { es: 'Animar', en: 'Animate' },
      help: { es: 'La semilla cambia cada pocos fotogramas; el resultado depende solo del tiempo del fotograma.', en: 'The seed changes every few frames; the result depends only on the frame time.' },
    },
    {
      id: 'rate', type: 'range', min: 1, max: 30, step: 1, default: 8, unit: '/s',
      label: { es: 'Cambios por segundo', en: 'Changes per second' },
      showIf: (p) => p.animate,
    },
  ],

  resolution(params, srcW, srcH, opts = {}) {
    const W = baseWidth(srcW, opts.isExport ? 2048 : 1280);
    return { width: W, height: Math.max(1, Math.round((W * srcH) / srcW)) };
  },

  preOptions() {
    return { matte: '#000000', edgeBlend: 'light' };
  },

  init() {
    return { scratch: {}, work: {} };
  },

  render(ctx, state) {
    const p = ctx.params.mode;
    const W = ctx.width;
    const H = ctx.height;
    const pixels = applyGlitch(ctx.rgba, W, H, { ...p, blockSize: Number(p.blockSize) }, frameSeed(p, ctx.time), state.work);
    const ratio = workRatio(MODE, ctx);
    const { k, effectiveScale } = blockScale(ctx, ratio, 1, W, H);
    presentPixels(ctx, state.scratch, pixels, W, H, k);
    return { cols: W, rows: H, effectiveScale };
  },

  dispose(state) {
    if (state?.scratch?.canvas) { state.scratch.canvas.width = state.scratch.canvas.height = 1; state.scratch.canvas = null; }
    if (state) state.work = {};
  },
};

export default MODE;
