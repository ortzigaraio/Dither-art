// Global Post-FX (PLAN.md 5.6): one full-screen WebGL2 shader applied to the raster output of any mode
// (preview, PNG and video exports). SVG / TXT / HTML / ANSI exports read the mode state, so they never see it.
// Off by default: every effect is 0 and `isActive()` is false, so the pipeline skips this pass entirely.
//
// One shared WebGL2 context (module level) serves every pipeline: each call uploads the frame, draws the
// effect and copies the result to the caller's 2D canvas, so the GL canvas only holds pixels in between.
// Without WebGL2, or while its context is lost, the frame passes through unchanged (the panel says so).

import { hasWebGL2 } from './gl.js';

const range = (id, min, max, def, label, extra = {}) => ({ id, type: 'range', min, max, step: 1, default: def, label, ...extra });

/** "CRT completo" (full CRT) preset values, also used by the `preset` select (links). */
export const CRT_PRESET = { scanlines: 55, scanDensity: 3, curvature: 35, glow: 45, glowRadius: 6, chroma: 2, vignette: 55, grain: 18, flicker: 12 };
const OFF = { scanlines: 0, curvature: 0, glow: 0, chroma: 0, vignette: 0, grain: 0, flicker: 0 };
const SOFT = { scanlines: 25, scanDensity: 2, curvature: 0, glow: 30, glowRadius: 8, chroma: 0, vignette: 35, grain: 8, flicker: 0 };
const VHS = { scanlines: 20, scanDensity: 2, curvature: 10, glow: 20, glowRadius: 5, chroma: 5, vignette: 30, grain: 40, flicker: 25 };

export const POSTFX_PARAMS = [
  {
    id: 'preset', type: 'select', default: 'off',
    options: [
      { value: 'off', label: { es: 'Apagado', en: 'Off' } },
      { value: 'crt', label: { es: 'CRT completo', en: 'Full CRT' } },
      { value: 'soft', label: { es: 'Brillo suave', en: 'Soft glow' } },
      { value: 'vhs', label: { es: 'Cinta VHS', en: 'VHS tape' } },
      { value: 'custom', label: { es: 'Personalizado', en: 'Custom' } },
    ],
    links: { off: OFF, crt: CRT_PRESET, soft: SOFT, vhs: VHS },
    linkFallback: 'custom',
    label: { es: 'Preset', en: 'Preset' },
    help: {
      es: 'Efectos de pantalla sobre la imagen final (PNG y video). No afectan a SVG ni a texto.',
      en: 'Screen effects on the final picture (PNG and video). They never touch SVG or text exports.',
    },
  },
  range('scanlines', 0, 100, 0, { es: 'Scanlines', en: 'Scanlines' }, { unit: '%' }),
  range('scanDensity', 1, 8, 3, { es: 'Densidad de líneas', en: 'Line spacing' }, { unit: 'px', showIf: (p) => p.scanlines > 0 }),
  range('curvature', 0, 100, 0, { es: 'Curvatura CRT', en: 'CRT curvature' }, { unit: '%' }),
  range('glow', 0, 100, 0, { es: 'Glow / bloom', en: 'Glow / bloom' }, { unit: '%' }),
  range('glowRadius', 1, 20, 6, { es: 'Radio del glow', en: 'Glow radius' }, { unit: 'px', showIf: (p) => p.glow > 0 }),
  range('chroma', 0, 10, 0, { es: 'Aberración cromática', en: 'Chromatic aberration' }, { unit: 'px' }),
  range('vignette', 0, 100, 0, { es: 'Viñeta', en: 'Vignette' }, { unit: '%' }),
  range('grain', 0, 100, 0, { es: 'Grano', en: 'Grain' }, {
    unit: '%',
    help: { es: 'Ruido de película; se anima en video y en modos animados.', en: 'Film noise; animated in video and animated modes.' },
  }),
  range('flicker', 0, 100, 0, { es: 'Parpadeo', en: 'Flicker' }, { unit: '%' }),
];

const EFFECTS = ['scanlines', 'curvature', 'glow', 'chroma', 'vignette', 'grain', 'flicker'];

/** True when at least one effect is on. */
export function isActive(fx) {
  if (!fx) return false;
  return EFFECTS.some((k) => Number(fx[k]) > 0);
}

/** Effects whose look changes with time (they make a still picture move only if the caller animates it). */
export function isTimeVarying(fx) {
  return !!fx && (Number(fx.grain) > 0 || Number(fx.flicker) > 0);
}

/** Stable key of the settings (to skip re-processing an unchanged frame). */
export function fxKey(fx) {
  return POSTFX_PARAMS.filter((p) => p.type === 'range').map((p) => fx?.[p.id] ?? p.default).join(',');
}

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Order: curvature (UV warp) -> chromatic aberration (per-channel radial offset) -> glow (bright pass blurred with
// a 24-tap golden-angle disc, added) -> scanlines -> vignette -> flicker -> grain. Alpha is kept (transparent
// frames stay transparent outside the picture; curvature leaves transparent corners).
const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSize;      // output size in px
uniform float uScale;    // output px per logical px (export 2x/4x keeps the look)
uniform float uScan, uScanDensity, uCurve, uGlow, uGlowRadius, uChroma, uVignette, uGrain, uFlicker, uTime;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

vec4 tex(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uTex, uv);
}

void main() {
  // texture rows are top-down (uploaded with UNPACK_FLIP_Y false) and we draw bottom-up: flip once here
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  if (uCurve > 0.0) {
    vec2 c = uv * 2.0 - 1.0;
    float k = uCurve * 0.16;
    c *= 1.0 + k * dot(c, c);
    uv = c * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { outColor = vec4(0.0); return; }
  }
  vec4 base = tex(uv);
  vec3 col = base.rgb;
  float a = base.a;
  if (uChroma > 0.0) {
    vec2 dir = (uv - 0.5);
    float len = max(length(dir), 1e-4);
    vec2 off = dir / len * (uChroma * uScale) / uSize * (0.35 + len);
    vec4 r = tex(uv + off);
    vec4 b = tex(uv - off);
    col = vec3(r.r, col.g, b.b);
    a = max(a, max(r.a, b.a));
  }
  if (uGlow > 0.0) {
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    float rad = uGlowRadius * uScale;
    for (int i = 0; i < 24; i++) {
      float fi = float(i);
      float r = sqrt((fi + 0.5) / 24.0) * rad;
      float th = fi * 2.39996323;
      vec2 o = vec2(cos(th), sin(th)) * r / uSize;
      vec4 s = tex(uv + o);
      float l = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
      float w = 1.0 - (r / max(rad, 1e-3)) * 0.6;
      acc += s.rgb * s.a * smoothstep(0.35, 0.9, l) * w;
      wsum += w;
    }
    vec3 bloom = acc / max(wsum, 1e-3);
    col += bloom * uGlow * 1.6;
    a = max(a, clamp(dot(bloom, vec3(0.333)) * uGlow * 1.6, 0.0, 1.0));
  }
  vec2 px = uv * uSize;
  if (uScan > 0.0) {
    float period = max(1.0, uScanDensity * uScale);
    float s = 0.5 + 0.5 * cos(6.2831853 * px.y / period);
    col *= 1.0 - uScan * 0.75 * s;
  }
  if (uVignette > 0.0) {
    vec2 c = uv - 0.5;
    float v = smoothstep(0.85, 0.25, length(c) * 1.25);
    col *= mix(1.0, v, uVignette);
  }
  if (uFlicker > 0.0) {
    float f = hash(vec2(floor(uTime * 30.0), 7.13));
    col *= 1.0 - uFlicker * 0.25 * f;
  }
  if (uGrain > 0.0) {
    float n = hash(floor(px / max(1.0, uScale)) + fract(uTime * 7.31) * 113.0) - 0.5;
    col += n * uGrain * 0.35;
  }
  outColor = vec4(clamp(col, 0.0, 1.0) * 1.0, a);
}`;

let shared = null; // { canvas, gl, prog, tex, loc, lost }

function setup() {
  if (shared) return shared;
  if (!hasWebGL2()) return null;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) return null;
  const s = { canvas, gl, prog: null, tex: null, loc: {}, lost: false };
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); s.lost = true; });
  canvas.addEventListener('webglcontextrestored', () => { s.lost = false; build(s); });
  build(s);
  shared = s;
  return s;
}

function build(s) {
  const { gl } = s;
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`postfx shader: ${gl.getShaderInfoLog(sh)}`);
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`postfx link: ${gl.getProgramInfoLog(prog)}`);
  s.prog = prog;
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  s.tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, s.tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  for (const n of ['uTex', 'uSize', 'uScale', 'uScan', 'uScanDensity', 'uCurve', 'uGlow', 'uGlowRadius', 'uChroma', 'uVignette', 'uGrain', 'uFlicker', 'uTime']) {
    s.loc[n] = gl.getUniformLocation(prog, n);
  }
}

/** Whether Post-FX can run in this browser (WebGL2). */
export function postfxAvailable() {
  return hasWebGL2();
}

/**
 * Apply the effects to `src` and draw the result into `dst` (a 2D canvas, resized to match).
 * Returns false (and leaves `dst` untouched) when the effects cannot run: the caller then keeps `src`.
 * @param {HTMLCanvasElement} src
 * @param {HTMLCanvasElement} dst
 * @param {object} fx     POSTFX params
 * @param {{ time?: number, scale?: number }} [o]
 */
export function applyPostFX(src, dst, fx, { time = 0, scale = 1 } = {}) {
  let s;
  try { s = setup(); } catch (err) { console.warn('[dither] post-fx unavailable', err); return false; }
  if (!s || s.lost || s.gl.isContextLost()) return false;
  const { gl, canvas } = s;
  const W = src.width;
  const H = src.height;
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (!W || !H || W > maxTex || H > maxTex) return false;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  gl.viewport(0, 0, W, H);
  gl.useProgram(s.prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  const L = s.loc;
  const pct = (k) => Math.max(0, Math.min(100, Number(fx[k]) || 0)) / 100;
  gl.uniform1i(L.uTex, 0);
  gl.uniform2f(L.uSize, W, H);
  gl.uniform1f(L.uScale, Math.max(0.25, scale));
  gl.uniform1f(L.uScan, pct('scanlines'));
  gl.uniform1f(L.uScanDensity, Math.max(1, Number(fx.scanDensity) || 3));
  gl.uniform1f(L.uCurve, pct('curvature'));
  gl.uniform1f(L.uGlow, pct('glow'));
  gl.uniform1f(L.uGlowRadius, Math.max(1, Number(fx.glowRadius) || 6));
  gl.uniform1f(L.uChroma, Math.max(0, Math.min(10, Number(fx.chroma) || 0)));
  gl.uniform1f(L.uVignette, pct('vignette'));
  gl.uniform1f(L.uGrain, pct('grain'));
  gl.uniform1f(L.uFlicker, pct('flicker'));
  gl.uniform1f(L.uTime, Number(time) || 0);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (dst.width !== W || dst.height !== H) { dst.width = W; dst.height = H; }
  const g = dst.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.drawImage(canvas, 0, 0);
  return true;
}
