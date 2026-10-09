// Reaction-diffusion and cellular automata (PLAN.md 7.25), WebGL2 ping-pong, animated.
//
// Gray-Scott: the picture's luma interpolates the feed / kill rates (f = mix(fA, fB, t), k = mix(kA, kB, t)), so the
// pattern draws the picture. State formats fall back from RG32F to RG16F to packed RGBA8 (engine/sim.js).
// Cellular automaton: Life-like B/S rules seeded with the dithered picture; imageLock re-seeds cells from the picture
// with a fixed probability per generation so the picture persists.
//
// Determinism (5.7): the state at time t is the simulation of N(t) steps from the seed (seeded PRNG), N(t) =
// floor(t · 60 · stepsPerFrame) for reaction-diffusion and floor(t · rate) generations for the automaton, capped.
// Exports start at t = 0 and walk forward, so the cached state only ever advances. The studio preview starts its
// clock at the first frame (and at RESET or a change of a simulation parameter), advances at most 60 steps per
// rendered frame (18.2, fewer while frames take long) and, on a slow GPU, slides its clock instead of falling
// behind; it reports the simulated time (`meta.exportTime`) so a PNG export re-simulates exactly the picture on screen.

import { createTexture, sizeCanvas } from '../engine/gl.js';
import {
  NAMED_RULES, parseRule, pickSimFormat, createReactionDiffusion, createAutomaton, seedReactionDiffusion, ditherCells,
  simProgram, GLSL_CODEC,
} from '../engine/sim.js';
import { resolveColors, isDarkBackground, buildGradientLUT, luma01 } from '../engine/color.js';
import { logicalSize, workResolution, fieldHash, hashed, blurField } from '../engine/vector.js';
import { LIMITS } from '../config.js';

const COLOR_MODES = ['mono', 'gradient', 'palette', 'original'];
export const SIM_FPS = 60;                 // reaction-diffusion "frames" per second of simulated time
export const MAX_RD_STEPS = 60000;         // cap of N(t) (≈ 50 s at the default 20 steps per frame)
export const MAX_CA_GENERATIONS = 20000;
const LIVE_BUDGET = LIMITS.maxReactionSteps; // most steps per rendered preview frame (PLAN.md 18.2)
const LIVE_START = 24;                     // first budget of a new preview; it adapts to the frame time
const FRAME_TARGET_MS = 33;
const CHUNK = 400;                         // steps between yields while an export catches up
const BASE_LONG = 768;                     // reaction-diffusion grid long side at simScale = 1
const CA_BASE_LONG = 320;                  // automaton grid long side at simScale = 1 (cells big enough to read)
const PREVIEW_CAP = 4096;

// Feed / kill pairs: A where the picture is dark, B where it is light (light areas grow the denser pattern).
export const PATTERNS = {
  coral: { fA: 0.0400, fB: 0.0545, kA: 0.0660, kB: 0.0580 },
  mitosis: { fA: 0.0367, fB: 0.0367, kA: 0.0715, kB: 0.0583 },
  maze: { fA: 0.0290, fB: 0.0290, kA: 0.0640, kB: 0.0540 },
  worms: { fA: 0.0780, fB: 0.0780, kA: 0.0640, kB: 0.0580 },
  spots: { fA: 0.0350, fB: 0.0350, kA: 0.0695, kB: 0.0585 },
  fingerprints: { fA: 0.0250, fB: 0.0600, kA: 0.0620, kB: 0.0609 },
};

const DISPLAY_FS = (packed) => `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_state;
uniform sampler2D u_lut;      // 256 x 1 colour ramp
uniform sampler2D u_img;      // the picture (original colour mode)
uniform vec2 u_out;           // output size, px
uniform int u_kind;           // 0 reaction-diffusion, 1 automaton
uniform int u_color;          // 0 ramp, 1 picture colour
uniform vec3 u_bg;
uniform float u_boost;
uniform int u_transparent;
uniform int u_flip;           // light background: the pattern is drawn as paper
uniform vec2 u_edge;          // RD: centre and half width of the V -> ink ramp
uniform float u_relief;       // RD: embossed lighting 0..1
uniform float u_trail;        // CA: trail visibility
uniform float u_gap;          // CA: gap between cells (fraction of a cell, 0 = none)
out vec4 o;
${GLSL_CODEC(packed)}
ivec2 mx;
float V(ivec2 q) { return dec(texelFetch(u_state, clamp(q, ivec2(0), mx), 0)).y; }
float Vs(vec2 sp) {
  vec2 f = sp - 0.5;
  vec2 i = floor(f);
  vec2 t = f - i;
  ivec2 b = ivec2(i);
  return mix(mix(V(b), V(b + ivec2(1, 0)), t.x), mix(V(b + ivec2(0, 1)), V(b + ivec2(1, 1)), t.x), t.y);
}
void main() {
  mx = textureSize(u_state, 0) - 1;
  vec2 size = vec2(textureSize(u_state, 0));
  vec2 uv = vec2(gl_FragCoord.x / u_out.x, 1.0 - gl_FragCoord.y / u_out.y);
  vec2 sp = uv * size;
  float t;
  float light = 1.0;
  bool gap = false;
  if (u_kind == 0) {
    float v = Vs(sp);
    t = smoothstep(u_edge.x - u_edge.y, u_edge.x + u_edge.y, v);
    if (u_relief > 0.0) {
      float dx = Vs(sp + vec2(0.75, 0.0)) - Vs(sp - vec2(0.75, 0.0));
      float dy = Vs(sp + vec2(0.0, 0.75)) - Vs(sp - vec2(0.0, 0.75));
      vec3 n = normalize(vec3(-dx * 5.0, dy * 5.0, 1.0));
      vec3 L = normalize(vec3(-0.55, 0.6, 0.58));
      float lam = (0.35 + 0.65 * max(dot(n, L), 0.0)) / (0.35 + 0.65 * L.z);
      float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0) * 0.45 * t;
      light = mix(1.0, lam, u_relief) + spec * u_relief;
    }
  } else {
    vec4 s = texelFetch(u_state, clamp(ivec2(floor(sp)), ivec2(0), mx), 0);
    t = s.r > 0.5 ? 1.0 : s.g * u_trail;
    if (u_gap > 0.0) {
      vec2 l = fract(sp);
      gap = any(lessThan(l, vec2(u_gap * 0.5))) || any(greaterThan(l, vec2(1.0 - u_gap * 0.5)));
    }
  }
  if (u_flip == 1) t = 1.0 - t;
  vec3 col;
  if (u_color == 1) {
    vec3 ic = texture(u_img, uv).rgb;
    float y = dot(ic, vec3(0.2126, 0.7152, 0.0722));
    ic = clamp(vec3(y) + (ic - vec3(y)) * u_boost, 0.0, 1.0);
    col = u_transparent == 1 ? ic : mix(u_bg, ic, t);
  } else {
    col = texture(u_lut, vec2((t * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  }
  col = clamp(col * light, 0.0, 1.0);
  float a = u_transparent == 1 ? t : 1.0;
  if (gap) { col = u_bg; a = u_transparent == 1 ? 0.0 : 1.0; }
  o = vec4(col * a, a);
}`;

/** The rule a parameter set asks for, falling back to Life when the custom text is invalid. */
export function ruleOf(p) {
  if (p.rule === 'custom') {
    const r = parseRule(p.customRule);
    return r ? { ...r, error: false } : { ...parseRule(NAMED_RULES.life), error: true };
  }
  return { ...parseRule(NAMED_RULES[p.rule] || NAMED_RULES.life), error: false };
}

/**
 * Simulated steps per second: reaction-diffusion runs `stepsPerFrame` steps per 1/60 s, the automaton `caRate`
 * generations per second. `cap` bounds N(t) (a re-simulation from the seed never exceeds it).
 */
export function clockOf(p) {
  if (p.sim === 'ca') {
    const rate = Math.max(1, Math.min(60, Math.round(p.caRate)));
    return { sps: rate, stepsPer: 1, cap: MAX_CA_GENERATIONS };
  }
  const spf = Math.max(1, Math.min(LIMITS.maxReactionSteps, Math.round(p.stepsPerFrame)));
  return { sps: SIM_FPS * spf, stepsPer: spf, cap: MAX_RD_STEPS };
}

/** N(t): simulated steps at time t (seconds since the start of the simulation). */
export function stepsAt(t, clock) {
  return Math.max(0, Math.min(clock.cap, Math.floor(t * clock.sps + 1e-6)));
}

const abortError = () => new DOMException('simulation aborted', 'AbortError');

const rdOnly = (p) => p.sim !== 'ca';
const caOnly = (p) => p.sim === 'ca';
const fRange = { type: 'range', min: 0.005, max: 0.1, step: 0.0001 };
const kRange = { type: 'range', min: 0.03, max: 0.075, step: 0.0001 };

const MODE = {
  id: 'reactiondiffusion',
  category: 'sim',
  name: { es: 'Reacción-difusión / Vida', en: 'Reaction-diffusion / Life' },
  blurb: { es: 'Patrones de Turing y Juego de la Vida que dibujan la imagen', en: 'Turing patterns and the Game of Life drawing the picture' },
  badges: ['GPU', 'ANIM'],
  animated: true,
  surface: 'gl',
  uses: ['image', 'color'],
  colorModes: COLOR_MODES,
  exports: ['png', 'video'],
  draftScale: 1, // a slider drag must not change the grid (that would restart the simulation)
  hide: ['cols', 'dither', 'serpentine'],
  thumb: { mode: { simScale: 0.25, stepsPerFrame: 60, pattern: 'coral' } },

  presets: [
    { id: 'coral', name: { es: 'Retrato de coral', en: 'Coral portrait' }, mode: { sim: 'rd', pattern: 'coral', ...PATTERNS.coral, seedType: 'edges', relief: 0.4 } },
    { id: 'maze', name: { es: 'Laberinto', en: 'Labyrinth' }, mode: { sim: 'rd', pattern: 'maze', ...PATTERNS.maze, seedType: 'random', relief: 0 }, color: { colorMode: 'gradient' } },
    { id: 'ghosts', name: { es: 'Vida con estela', en: 'Life with trails' }, mode: { sim: 'ca', rule: 'life', imageLock: 0.03, trail: 0.88 } },
  ],

  params: [
    {
      id: 'sim', type: 'select', default: 'rd',
      options: [
        { value: 'rd', label: { es: 'Reacción-difusión (Gray-Scott)', en: 'Reaction-diffusion (Gray-Scott)' } },
        { value: 'ca', label: { es: 'Autómata celular (B/S)', en: 'Cellular automaton (B/S)' } },
      ],
      label: { es: 'Simulación', en: 'Simulation' },
    },
    // ---- reaction-diffusion ----
    {
      id: 'pattern', type: 'select', default: 'coral',
      options: [
        { value: 'coral', label: { es: 'Coral', en: 'Coral' } },
        { value: 'mitosis', label: { es: 'Mitosis', en: 'Mitosis' } },
        { value: 'maze', label: { es: 'Laberinto', en: 'Labyrinth' } },
        { value: 'worms', label: { es: 'Gusanos', en: 'Worms' } },
        { value: 'spots', label: { es: 'Puntos', en: 'Spots' } },
        { value: 'fingerprints', label: { es: 'Huellas', en: 'Fingerprints' } },
        { value: 'custom', label: { es: 'Personalizado', en: 'Custom' } },
      ],
      links: PATTERNS,
      linkFallback: 'custom',
      label: { es: 'Patrón', en: 'Pattern' },
      help: {
        es: 'Carga valores de f y k en los cuatro controles de abajo; puedes retocarlos después.',
        en: 'Loads f and k values into the four controls below; you can fine-tune them afterwards.',
      },
      showIf: rdOnly,
    },
    {
      id: 'fA', ...fRange, default: PATTERNS.coral.fA,
      label: { es: 'f en sombras (A)', en: 'f in shadows (A)' },
      help: { es: 'Tasa de alimentación donde la imagen es oscura: f = mezcla(fA, fB, luminosidad).', en: 'Feed rate where the picture is dark: f = mix(fA, fB, luma).' },
      showIf: rdOnly,
    },
    {
      id: 'fB', ...fRange, default: PATTERNS.coral.fB,
      label: { es: 'f en luces (B)', en: 'f in highlights (B)' },
      showIf: rdOnly,
    },
    {
      id: 'kA', ...kRange, default: PATTERNS.coral.kA,
      label: { es: 'k en sombras (A)', en: 'k in shadows (A)' },
      help: { es: 'Tasa de eliminación donde la imagen es oscura.', en: 'Kill rate where the picture is dark.' },
      showIf: rdOnly,
    },
    {
      id: 'kB', ...kRange, default: PATTERNS.coral.kB,
      label: { es: 'k en luces (B)', en: 'k in highlights (B)' },
      showIf: rdOnly,
    },
    {
      id: 'stepsPerFrame', type: 'range', min: 1, max: LIMITS.maxReactionSteps, step: 1, default: 20,
      label: { es: 'Pasos por fotograma', en: 'Steps per frame' },
      help: { es: 'Iteraciones de la simulación por cada 1/60 s. Más pasos = crece más rápido.', en: 'Simulation iterations per 1/60 s. More steps = faster growth.' },
      showIf: rdOnly,
    },
    {
      id: 'Du', type: 'range', min: 0.1, max: 1, step: 0.01, default: 1,
      label: { es: 'Difusión U', en: 'Diffusion U' },
      showIf: rdOnly,
    },
    {
      id: 'Dv', type: 'range', min: 0.05, max: 1, step: 0.01, default: 0.5,
      label: { es: 'Difusión V', en: 'Diffusion V' },
      help: { es: 'La relación Du/Dv decide el tamaño de los motivos (clásico: 1.0 / 0.5).', en: 'The Du/Dv ratio sets the size of the features (classic: 1.0 / 0.5).' },
      showIf: rdOnly,
    },
    {
      id: 'imageInfluence', type: 'range', min: 0, max: 1, step: 0.01, default: 0.8,
      label: { es: 'Influencia de la imagen', en: 'Image influence' },
      help: { es: '0 = el mismo patrón en todas partes; 1 = las sombras usan A y las luces B.', en: '0 = the same pattern everywhere; 1 = shadows use A and highlights B.' },
      showIf: rdOnly,
    },
    {
      id: 'seedType', type: 'select', default: 'edges',
      options: [
        { value: 'edges', label: { es: 'Bordes de la imagen', en: 'Picture edges' } },
        { value: 'random', label: { es: 'Aleatorio', en: 'Random' } },
        { value: 'center', label: { es: 'Centro', en: 'Centre' } },
      ],
      label: { es: 'Semillas', en: 'Seeds' },
      help: { es: 'Dónde empieza la reacción.', en: 'Where the reaction starts.' },
      showIf: rdOnly,
    },
    {
      id: 'softness', type: 'range', min: 0, max: 1, step: 0.01, default: 0.3,
      label: { es: 'Suavidad del borde', en: 'Edge softness' },
      showIf: rdOnly,
    },
    {
      id: 'relief', type: 'range', min: 0, max: 1, step: 0.01, default: 0.35,
      label: { es: 'Relieve', en: 'Relief' },
      help: { es: 'Iluminación en relieve a partir de la concentración.', en: 'Embossed lighting from the concentration.' },
      showIf: rdOnly,
    },
    // ---- cellular automaton ----
    {
      id: 'rule', type: 'select', default: 'life',
      options: [
        { value: 'life', label: { es: 'Juego de la Vida (B3/S23)', en: 'Game of Life (B3/S23)' } },
        { value: 'highlife', label: { es: 'HighLife (B36/S23)', en: 'HighLife (B36/S23)' } },
        { value: 'daynight', label: { es: 'Día y Noche (B3678/S34678)', en: 'Day & Night (B3678/S34678)' } },
        { value: 'seeds', label: { es: 'Seeds (B2/S)', en: 'Seeds (B2/S)' } },
        { value: 'custom', label: { es: 'Personalizada', en: 'Custom' } },
      ],
      label: { es: 'Regla', en: 'Rule' },
      showIf: caOnly,
    },
    {
      id: 'customRule', type: 'text', default: 'B3/S23', maxLength: 24,
      validate: (v) => !!parseRule(v),
      invalid: { es: 'Regla no válida: usa B<dígitos 0-8>/S<dígitos 0-8>, p. ej. B36/S23. Mientras tanto se usa B3/S23.', en: 'Invalid rule: use B<digits 0-8>/S<digits 0-8>, e.g. B36/S23. B3/S23 is used meanwhile.' },
      label: { es: 'Regla B/S', en: 'B/S rule' },
      help: { es: 'B = vecinos que hacen nacer una célula, S = vecinos con los que sobrevive.', en: 'B = neighbour counts that give birth, S = counts that keep a cell alive.' },
      showIf: (p) => p.sim === 'ca' && p.rule === 'custom',
    },
    {
      id: 'caRate', type: 'range', min: 1, max: 60, step: 1, default: 12, unit: '/s',
      label: { es: 'Generaciones por segundo', en: 'Generations per second' },
      showIf: caOnly,
    },
    {
      id: 'imageLock', type: 'range', min: 0, max: 1, step: 0.01, default: 0.04,
      label: { es: 'Fijar imagen', en: 'Image lock' },
      help: { es: 'Probabilidad por generación de re-sembrar cada célula con la imagen, para que la imagen persista.', en: 'Chance per generation that a cell is re-seeded from the picture, so the picture persists.' },
      showIf: caOnly,
    },
    {
      id: 'caDither', type: 'select', default: 'atkinson',
      options: [
        { value: 'floyd-steinberg', label: { es: 'Floyd–Steinberg', en: 'Floyd–Steinberg' } },
        { value: 'atkinson', label: { es: 'Atkinson', en: 'Atkinson' } },
        { value: 'bayer4', label: { es: 'Bayer 4×4', en: 'Bayer 4×4' } },
        { value: 'blue-noise', label: { es: 'Ruido azul', en: 'Blue noise' } },
        { value: 'random', label: { es: 'Aleatorio', en: 'Random' } },
      ],
      label: { es: 'Tramado de la siembra', en: 'Seed dithering' },
      showIf: caOnly,
    },
    {
      id: 'trail', type: 'range', min: 0, max: 0.98, step: 0.01, default: 0.82,
      label: { es: 'Estela', en: 'Trail' },
      help: { es: 'Las células muertas se apagan poco a poco.', en: 'Dead cells fade out gradually.' },
      showIf: caOnly,
    },
    {
      id: 'cellGap', type: 'toggle', default: true,
      label: { es: 'Separar celdas', en: 'Cell gaps' },
      showIf: caOnly,
    },
    // ---- shared ----
    {
      id: 'simScale', type: 'range', min: 0.25, max: 1, step: 0.05, default: 0.5,
      label: { es: 'Escala de simulación', en: 'Simulation scale' },
      help: {
        es: 'Tamaño de la rejilla (1 = 768 celdas en el lado mayor; 320 en el autómata). Más pequeña = motivos más grandes y más rápido.',
        en: 'Grid size (1 = 768 cells on the long side; 320 for the automaton). Smaller = bigger features and faster.',
      },
    },
    {
      id: 'seed', type: 'seed', default: 7,
      label: { es: 'Semilla aleatoria', en: 'Random seed' },
    },
    {
      id: 'restart', type: 'button', action: 'restart',
      label: { es: 'Reiniciar simulación', en: 'Restart simulation' },
    },
  ],

  resolution(params, srcW, srcH) {
    const s = Math.max(0.25, Math.min(1, params.mode.simScale || 0.5));
    return workResolution(srcW, srcH, Math.round((params.mode.sim === 'ca' ? CA_BASE_LONG : BASE_LONG) * s));
  },

  init(ctx) {
    const gl = ctx.gl;
    return {
      gl, sim: null, fmt: null, display: {}, vao: gl.createVertexArray(), lut: null, lutKey: '', img: null, imgKey: '',
      fieldKey: '', simKey: '', origin: 0, done: 0, lastT: -Infinity, restart: false, budget: LIVE_START, lastWall: 0,
    };
  },

  async render(ctx, state) {
    const gl = ctx.gl;
    const p = ctx.params.mode;
    const W = ctx.width;
    const H = ctx.height;
    const isCA = p.sim === 'ca';
    const cr = resolveColors(ctx.params.color, ctx.theme, COLOR_MODES);
    const dark = isDarkBackground(cr);
    const rule = isCA ? ruleOf(p) : null;
    const clock = clockOf(p);
    const live = !!ctx.progressive;

    // ---- the simulation object (kind, size and format) ----
    const kind = isCA ? 'ca' : 'rd';
    if (!state.sim || state.sim.kind !== kind || state.sim.width !== W || state.sim.height !== H) {
      state.sim?.dispose();
      if (isCA) state.sim = createAutomaton(gl, W, H);
      else {
        state.fmt = state.fmt || pickSimFormat(gl);
        state.sim = createReactionDiffusion(gl, W, H, state.fmt);
      }
      state.sim.kind = kind;
      state.simKey = '';
      state.fieldKey = '';
    }
    const sim = state.sim;

    // ---- picture fields: f/k modulation (RD) or the dithered picture (CA); video frames refresh them every render ----
    const fieldKey = ctx.isVideo ? `video|${hashed(ctx.params.global)}` : fieldHash(ctx.luma(), 3);
    const seedNum = p.seed >>> 0;
    if (ctx.isVideo || state.fieldKey !== `${fieldKey}|${kind}|${p.caDither}|${dark}|${seedNum}`) {
      const luma = ctx.luma();
      if (isCA) {
        state.cells = ditherCells(luma, W, H, p.caDither, seedNum, dark);
        sim.setImage(state.cells);
      } else {
        sim.setLuma(blurField(luma, W, H, 1.2));
      }
      state.fieldKey = `${fieldKey}|${kind}|${p.caDither}|${dark}|${seedNum}`;
    }

    // ---- reset when anything that shapes the simulation changed ----
    const simKey = hashed([
      kind, W, H, seedNum, fieldKey,
      isCA ? [rule.text, p.caDither, clock.sps, p.imageLock, p.trail, dark]
        : [p.seedType, p.fA, p.fB, p.kA, p.kB, p.Du, p.Dv, p.imageInfluence, clock.stepsPer],
    ]);
    const t = ctx.time;
    let reset = state.simKey !== simKey || state.restart;
    if (live && t < state.lastT - 1e-9) reset = true; // a video looped or was sought backwards
    if (!live && stepsAt(t, clock) < state.done) reset = true; // asked for an earlier time: simulate again from the seed
    if (reset) {
      if (isCA) sim.upload(state.cells);
      else sim.upload(seedReactionDiffusion(W, H, p.seedType, seedNum, p.seedType === 'edges' ? { mag: ctx.sobel().mag } : {}));
      state.origin = live ? t : 0;
      state.done = 0;
      state.simKey = simKey;
      state.restart = false;
    }
    state.lastT = t;

    // ---- advance to N(t) ----
    const target = stepsAt(t - state.origin, clock);
    const advance = (n) => {
      if (n <= 0) return;
      if (isCA) sim.step(n, state.done, { bMask: rule.bMask, sMask: rule.sMask, lock: p.imageLock, seed: seedNum, decay: p.trail });
      else sim.step(n, { fA: p.fA, fB: p.fB, kA: p.kA, kB: p.kB, Du: p.Du, Dv: p.Dv, influence: p.imageInfluence });
      state.done += n;
    };
    if (live) {
      // the budget follows the frame interval (the GPU work of the previous frame shows up in it): long frames get
      // fewer steps so the studio stays responsive on a slow GPU, never more than 60 (PLAN.md 18.2)
      const now = performance.now();
      const dt = now - state.lastWall;
      state.lastWall = now;
      if (dt > 0 && dt < 1000) {
        const k = Math.max(0.5, Math.min(1.25, FRAME_TARGET_MS / dt));
        // never below one simulated frame (1/60 s), so the pattern keeps growing even when drawing is slow
        state.budget = Math.max(Math.min(clock.stepsPer, 20), Math.min(LIVE_BUDGET, Math.round(state.budget * k)));
      }
      const need = target - state.done;
      const n = Math.min(need, state.budget);
      advance(n);
      if (need > n) state.origin += (need - n) / clock.sps; // the simulated clock slides instead of lagging behind
    } else {
      while (state.done < target) {
        if (ctx.signal?.aborted) throw abortError();
        advance(Math.min(CHUNK, target - state.done));
        if (state.done < target) {
          gl.flush();
          await new Promise((r) => setTimeout(r, 0)); // keep the page responsive while an export catches up
        }
      }
    }

    // ---- colour ramp ----
    const lutKey = hashed([cr.mode, cr.ink, cr.bg, cr.stops, cr.mode === 'palette' ? cr.palette : 0]);
    if (state.lutKey !== lutKey) {
      const lut = new Uint8Array(256 * 4);
      let rgb;
      if (cr.mode === 'gradient') rgb = buildGradientLUT(cr.stops);
      else if (cr.mode === 'palette') {
        const pal = cr.palette.slice().sort((a, b) => luma01(...a) - luma01(...b));
        rgb = new Uint8Array(256 * 3);
        for (let i = 0; i < 256; i++) {
          const c = pal[Math.min(pal.length - 1, Math.floor((i / 256) * pal.length))];
          rgb.set(c, i * 3);
        }
      } else rgb = buildGradientLUT([cr.bg, cr.ink]);
      for (let i = 0; i < 256; i++) {
        lut[i * 4] = rgb[i * 3];
        lut[i * 4 + 1] = rgb[i * 3 + 1];
        lut[i * 4 + 2] = rgb[i * 3 + 2];
        lut[i * 4 + 3] = 255;
      }
      if (state.lut) gl.deleteTexture(state.lut);
      state.lut = createTexture(gl, { width: 256, height: 1, data: lut });
      state.lutKey = lutKey;
    }
    if (cr.mode === 'original') {
      const imgKey = `${fieldKey}|${W}x${H}`;
      if (ctx.isVideo || state.imgKey !== imgKey || !state.img) {
        if (state.img) gl.deleteTexture(state.img);
        const rgba = ctx.rgba;
        state.img = createTexture(gl, { width: W, height: H, data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) });
        state.imgKey = imgKey;
      }
    }

    // ---- display ----
    const packed = !isCA && !!sim.packed;
    const progKey = packed ? 'packed' : 'plain';
    if (!state.display[progKey]) state.display[progKey] = simProgram(gl, DISPLAY_FS(packed));
    const P = state.display[progKey];
    const { LW, LH } = logicalSize(ctx);
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : PREVIEW_CAP;
    const s = Math.max(0.05, Math.min(ctx.outScale || 1, cap / LW, cap / LH));
    const { w, h } = sizeCanvas(gl, ctx.out.canvas, LW * s, LH * s);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sim.texture);
    gl.uniform1i(P.u.u_state, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.lut);
    gl.uniform1i(P.u.u_lut, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, cr.mode === 'original' ? state.img : state.lut);
    gl.uniform1i(P.u.u_img, 2);
    gl.uniform2f(P.u.u_out, w, h);
    gl.uniform1i(P.u.u_kind, isCA ? 1 : 0);
    gl.uniform1i(P.u.u_color, cr.mode === 'original' ? 1 : 0);
    gl.uniform3f(P.u.u_bg, cr.bg[0] / 255, cr.bg[1] / 255, cr.bg[2] / 255);
    gl.uniform1f(P.u.u_boost, cr.boost);
    gl.uniform1i(P.u.u_transparent, cr.bgTransparent ? 1 : 0);
    gl.uniform1i(P.u.u_flip, !isCA && !dark ? 1 : 0); // the automaton flips its seed instead (alive = ink)
    gl.uniform2f(P.u.u_edge, 0.2, 0.012 + 0.14 * p.softness);
    gl.uniform1f(P.u.u_relief, isCA ? 0 : p.relief);
    gl.uniform1f(P.u.u_trail, p.trail > 0 ? 0.85 : 0);
    const cellPx = w / W;
    gl.uniform1f(P.u.u_gap, isCA && p.cellGap && cellPx >= 3 ? Math.min(0.3, 1 / cellPx) : 0);
    gl.bindVertexArray(state.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    const simTime = state.done / clock.sps;
    return {
      cols: W,
      rows: H,
      format: sim.format,
      steps: state.done,
      simTime,
      exportTime: simTime,
      effectiveScale: s,
      transparent: cr.bgTransparent,
      rule: rule?.text ?? null,
      ruleError: !!rule?.error,
    };
  },

  /** Button actions (studio): RESTART the simulation from its seed. */
  onAction(action, state) {
    if (action === 'restart' && state) state.restart = true;
  },

  dispose(state) {
    const gl = state?.gl;
    if (!gl) return;
    state.sim?.dispose();
    for (const P of Object.values(state.display || {})) gl.deleteProgram(P.prog);
    if (state.lut) gl.deleteTexture(state.lut);
    if (state.img) gl.deleteTexture(state.img);
    gl.deleteVertexArray(state.vao);
  },
};

export default MODE;
