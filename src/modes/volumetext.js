// Volumetric ASCII / Braille (PLAN.md 7.24): the picture + its depth become an extruded relief (a height field) that a
// WebGL2 fragment shader raymarches: linear steps until the ray goes below the surface, bisection to refine, normals
// from the depth gradient, Lambert or toon light, a soft shadow, cheap ambient occlusion and fog. The render is made
// at one pixel per character (2 x 4 per character for Braille), read back and drawn as ASCII, Braille or blocks.
// The camera is the shared orbit camera (tilt = pitch, orbit speed = auto-rotate): deterministic on the frame time.

import { createProgram, createTexture, sizeCanvas, readPixels, FULLSCREEN_VS, GLSL_TURBO } from '../engine/gl.js';
import { orbitCamera, DEG } from '../engine/math3d.js';
import { cameraParams } from '../engine/camera.js';
import { workResolution, fieldHash } from '../engine/vector.js';
import { resolveColors, isDarkBackground, rgbToHex } from '../engine/color.js';
import { DITHER_OPTIONS } from '../engine/dither.js';
import {
  TEXT_COLOR_MODES, textRows, cellAspectOf, cellsFromPixels, drawTextCells, drawBrailleCells, autoLevel,
} from '../engine/textcells.js';
import { cropRect } from '../engine/preprocess.js';
import { gridToText } from '../io/exportText.js';
import { TEXT_PARAMS } from './raymarch.js';
import { LIMITS, config } from '../config.js';

const hexOf = (rgb) => rgbToHex(rgb[0], rgb[1], rgb[2]);
const COLOR_BY = ['image', 'height', 'shade'];

const FS = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_aspect;
uniform vec3 u_eye, u_right, u_up, u_fwd;
uniform float u_tanHalf;
uniform sampler2D u_depth;   // R16F height 0..1
uniform sampler2D u_color;   // picture
uniform vec2 u_texel;        // 1 / depth size
uniform vec2 u_ext;          // half extents of the relief in x and z
uniform float u_hs;          // height scale (world units)
uniform vec3 u_light;
uniform int u_toon;
uniform float u_fog;
uniform float u_ao;
uniform int u_colorBy;       // 0 image, 1 height, 2 shade
out vec4 o;
${GLSL_TURBO}

vec2 uvOf(vec3 p) { return vec2(p.x / u_ext.x * 0.5 + 0.5, p.z / u_ext.y * 0.5 + 0.5); }
float H(vec2 uv) { return texture(u_depth, uv).r * u_hs; }

bool boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float t0, out float t1, out vec3 nEnter) {
  vec3 inv = 1.0 / rd;
  vec3 ta = (bmin - ro) * inv;
  vec3 tb = (bmax - ro) * inv;
  vec3 tmin = min(ta, tb);
  vec3 tmax = max(ta, tb);
  t0 = max(max(tmin.x, tmin.y), tmin.z);
  t1 = min(min(tmax.x, tmax.y), tmax.z);
  nEnter = vec3(0.0);
  if (t0 == tmin.x) nEnter = vec3(-sign(rd.x), 0.0, 0.0);
  else if (t0 == tmin.y) nEnter = vec3(0.0, -sign(rd.y), 0.0);
  else nEnter = vec3(0.0, 0.0, -sign(rd.z));
  return t1 >= max(t0, 0.0);
}

vec3 normalAt(vec2 uv) {
  float hl = H(uv - vec2(u_texel.x, 0.0)), hr = H(uv + vec2(u_texel.x, 0.0));
  float hd = H(uv - vec2(0.0, u_texel.y)), hu = H(uv + vec2(0.0, u_texel.y));
  float dx = 2.0 * u_ext.x * u_texel.x * 2.0;
  float dz = 2.0 * u_ext.y * u_texel.y * 2.0;
  return normalize(vec3((hl - hr) / dx, 1.0, (hd - hu) / dz));
}

void main() {
  vec2 ndc = gl_FragCoord.xy / u_res * 2.0 - 1.0;
  ndc.x *= u_aspect;
  vec3 rd = normalize(u_fwd + (u_right * ndc.x + u_up * ndc.y) * u_tanHalf);
  vec3 ro = u_eye;
  vec3 bmin = vec3(-u_ext.x, -0.06, -u_ext.y);
  vec3 bmax = vec3(u_ext.x, u_hs + 1e-3, u_ext.y);
  float t0, t1;
  vec3 nEnter;
  if (!boxHit(ro, rd, bmin, bmax, t0, t1, nEnter)) { o = vec4(0.0); return; }
  t0 = max(t0, 0.0);
  vec3 p = ro + rd * t0;
  vec3 n;
  float tHit = -1.0;
  vec2 uv;
  if (nEnter.y < 0.5 && p.y <= H(uvOf(p)) + 1e-4) {
    tHit = t0; // the side walls of the extruded block
    n = nEnter;
    uv = uvOf(p);
  } else {
    // march below the surface, then bisect
    const int STEPS = 150;
    float dt = (t1 - t0) / float(STEPS);
    float ta = t0;
    float fa = p.y - H(uvOf(p));
    for (int i = 1; i <= STEPS; i++) {
      float tb = t0 + dt * float(i);
      vec3 q = ro + rd * tb;
      float fb = q.y - H(uvOf(q));
      if (fb < 0.0) {
        for (int k = 0; k < 7; k++) {
          float tm = 0.5 * (ta + tb);
          vec3 m = ro + rd * tm;
          float fm = m.y - H(uvOf(m));
          if (fm < 0.0) tb = tm; else ta = tm;
        }
        tHit = tb;
        break;
      }
      ta = tb;
      fa = fb;
    }
    if (tHit < 0.0) { o = vec4(0.0); return; }
    p = ro + rd * tHit;
    uv = uvOf(p);
    n = normalAt(uv);
  }
  vec3 L = normalize(u_light);
  float diff = max(dot(n, L), 0.0);
  // soft shadow: march towards the light over the height field
  float sh = 1.0;
  vec3 sp = p + n * 0.01;
  for (int i = 1; i <= 24; i++) {
    vec3 q = sp + L * (0.04 * float(i));
    if (q.y > u_hs + 0.01) break;
    vec2 quv = uvOf(q);
    if (quv.x < 0.0 || quv.x > 1.0 || quv.y < 0.0 || quv.y > 1.0) break;
    float d = q.y - H(quv);
    sh = min(sh, clamp(8.0 * d / (0.04 * float(i)), 0.0, 1.0));
  }
  if (u_toon == 1) diff = floor(diff * sh * 4.0 + 0.5) / 4.0; else diff *= 0.35 + 0.65 * sh;
  // cheap ambient occlusion: how far the neighbourhood rises above this point
  float h0 = H(uv);
  float acc = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 off = vec2(cos(a), sin(a)) * u_texel * 6.0;
    acc += max(0.0, H(uv + off) - h0);
  }
  float ao = clamp(1.0 - u_ao * acc / max(0.08, u_hs) * 1.2, 0.0, 1.0);
  float shade = (0.12 + 0.88 * diff) * ao;
  vec3 albedo = u_colorBy == 0 ? texture(u_color, uv).rgb : u_colorBy == 1 ? turbo(h0 / max(1e-4, u_hs)) : vec3(1.0);
  // fog towards the background (empty cells), by distance beyond the nearest point of the relief
  float fogK = 1.0 - exp(-u_fog * 2.2 * max(0.0, tHit - (length(ro) - length(u_ext) - u_hs)));
  float fade = 1.0 - fogK * 0.92;
  // RGB: the colour (lit albedo); alpha: the light that picks the glyph (the shape reads by its lighting, the
  // picture's own brightness only modulates it a little)
  float alb = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  float light = clamp(shade * (0.7 + 0.3 * alb) * fade, 0.0, 1.0);
  vec3 col = clamp(albedo * (0.25 + 0.75 * shade) * fade, 0.0, 1.0);
  o = vec4(col, (128.0 + 127.0 * light) / 255.0);
}`;

export default {
  id: 'volumetext',
  category: '3d',
  name: { es: 'Texto volumétrico', en: 'Volumetric text' },
  blurb: { es: 'La imagen como relieve 3D, en ASCII, Braille o bloques', en: 'The picture as a 3D relief, in ASCII, Braille or blocks' },
  badges: ['TXT', '3D', 'GPU', 'ANIM'],
  animated: true,
  surface: 'gl',
  camera: true,
  uses: ['image', 'depth', 'color'],
  colorModes: TEXT_COLOR_MODES,
  exports: ['png', 'txt', 'html', 'ansi', 'video'],
  draftScale: 1,

  presets: [
    { id: 'relief', name: { es: 'Relieve', en: 'Relief' }, mode: { charset: 'ascii', heightScale: 0.6, shading: 'lambert' } },
    { id: 'braille', name: { es: 'Braille', en: 'Braille' }, mode: { charset: 'braille', heightScale: 0.9, fog: 0.2 } },
    { id: 'toon', name: { es: 'Bloques toon', en: 'Toon blocks' }, mode: { charset: 'blocks', shading: 'toon', colorBy: 'height' } },
  ],

  params: [
    {
      id: 'charset', type: 'select', default: 'ascii',
      options: [
        { value: 'ascii', label: { es: 'ASCII', en: 'ASCII' } },
        { value: 'braille', label: { es: 'Braille (2×4 puntos)', en: 'Braille (2×4 dots)' } },
        { value: 'blocks', label: { es: 'Bloques', en: 'Blocks' } },
      ],
      label: { es: 'Caracteres', en: 'Characters' },
    },
    {
      id: 'heightScale', type: 'range', min: 0, max: 2, step: 0.05, default: 0.6,
      label: { es: 'Altura del relieve', en: 'Relief height' },
    },
    {
      id: 'shading', type: 'select', default: 'lambert',
      options: [
        { value: 'lambert', label: { es: 'Lambert', en: 'Lambert' } },
        { value: 'toon', label: { es: 'Toon', en: 'Toon' } },
      ],
      label: { es: 'Sombreado', en: 'Shading' },
    },
    {
      id: 'lightDir', type: 'range', min: 0, max: 360, step: 1, default: 135, unit: '°',
      label: { es: 'Dirección de la luz', en: 'Light direction' },
    },
    {
      id: 'lightHeight', type: 'range', min: 5, max: 85, step: 1, default: 40, unit: '°',
      label: { es: 'Altura de la luz', en: 'Light elevation' },
    },
    {
      id: 'ao', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6,
      label: { es: 'Oclusión ambiental', en: 'Ambient occlusion' },
    },
    {
      id: 'fog', type: 'range', min: 0, max: 1, step: 0.05, default: 0.3,
      label: { es: 'Niebla', en: 'Fog' },
    },
    {
      id: 'colorBy', type: 'select', default: 'image',
      options: [
        { value: 'image', label: { es: 'Imagen', en: 'Picture' } },
        { value: 'height', label: { es: 'Altura (Turbo)', en: 'Height (Turbo)' } },
        { value: 'shade', label: { es: 'Solo luz', en: 'Light only' } },
      ],
      label: { es: 'Color por', en: 'Colour by' },
      help: { es: 'Color que usa el modo "Color original" del grupo COLOR.', en: 'Colour used by the "Original colour" mode of the COLOR group.' },
    },
    {
      id: 'brailleThreshold', type: 'range', min: 0, max: 1, step: 0.01, default: 0.45,
      label: { es: 'Umbral Braille', en: 'Braille threshold' },
      showIf: (p) => p.charset === 'braille',
    },
    {
      id: 'brailleDither', type: 'select', default: 'atkinson', options: DITHER_OPTIONS,
      label: { es: 'Tramado Braille', en: 'Braille dithering' },
      showIf: (p) => p.charset === 'braille',
    },
    ...cameraParams({ yaw: 0, pitch: 38, distance: 3.1, fov: 40, autoRotate: 14 }, {
      pitch: { es: 'Inclinación', en: 'Tilt' },
      autoRotate: { es: 'Velocidad de órbita', en: 'Orbit speed' },
    }),
    ...TEXT_PARAMS.map((tp) => (tp.id === 'gradient' || tp.id === 'customGradient' || tp.id === 'autoSort' || tp.id === 'invertGradient' || tp.id === 'spaceDensity'
      ? { ...tp, showIf: (p, all) => p.charset === 'ascii' && (!tp.showIf || tp.showIf(p, all)) }
      : { ...tp, showIf: (p) => p.charset !== 'braille' })),
  ],

  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, 320);
  },

  preOptions(params, theme) {
    const cr = resolveColors(params.color, theme, TEXT_COLOR_MODES);
    const dark = isDarkBackground(cr);
    return { matte: cr.bgTransparent ? (dark ? '#000000' : '#ffffff') : hexOf(cr.bg), edgeBlend: dark ? 'light' : 'dark' };
  },

  init(ctx) {
    const gl = ctx.gl;
    return { gl, P: createProgram(gl, FULLSCREEN_VS, FS), vao: gl.createVertexArray(), depthTex: null, colorTex: null, key: '', px: null, cells: {} };
  },

  async render(ctx, state) {
    const depth = await ctx.depth();
    // every await is above: the GL work below runs in one go
    const gl = ctx.gl;
    const p = ctx.params.mode;
    const cr = resolveColors(ctx.params.color, ctx.theme, TEXT_COLOR_MODES);
    const dark = isDarkBackground(cr);
    const crop = cropRect(ctx.params.global, ctx.srcWidth, ctx.srcHeight);
    const W = ctx.width;
    const H = ctx.height;
    const braille = p.charset === 'braille';
    const cols = Math.max(4, Math.min(LIMITS.maxCols, Math.round(ctx.params.global.cols)));
    const rows = braille
      ? Math.max(1, Math.round((cols * 2 * (crop.sh / crop.sw)) / 4))
      : Math.min(LIMITS.maxCols, textRows(p, cols, crop.sw, crop.sh));
    const pw = braille ? cols * 2 : cols;
    const ph = braille ? rows * 4 : rows;

    const key = `${W}x${H}|${fieldHash(depth, 3)}|${fieldHash(ctx.luma(), 5)}`;
    if (state.key !== key) {
      if (state.depthTex) gl.deleteTexture(state.depthTex);
      if (state.colorTex) gl.deleteTexture(state.colorTex);
      state.depthTex = createTexture(gl, { width: W, height: H, data: depth, internalFormat: gl.R16F, format: gl.RED, type: gl.FLOAT });
      const rgba = ctx.rgba;
      state.colorTex = createTexture(gl, { width: W, height: H, data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) });
      state.key = key;
    }

    const { w, h } = sizeCanvas(gl, ctx.out.canvas, pw, ph);
    const aspect = braille ? pw / ph : (cols * cellAspectOf(p)) / rows;
    const cam = orbitCamera(p, { time: ctx.time, aspect });
    const A = crop.sw / crop.sh;
    const ext = A >= 1 ? [1.15, 1.15 / A] : [1.15 * A, 1.15];
    const az = p.lightDir * DEG;
    const el = p.lightHeight * DEG;
    const L = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];

    const { P } = state;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.prog);
    gl.uniform2f(P.u.u_res, w, h);
    gl.uniform1f(P.u.u_aspect, aspect);
    gl.uniform3fv(P.u.u_eye, cam.eye);
    gl.uniform3fv(P.u.u_right, cam.right);
    gl.uniform3fv(P.u.u_up, cam.up);
    gl.uniform3fv(P.u.u_fwd, cam.forward);
    gl.uniform1f(P.u.u_tanHalf, Math.tan((cam.fov * DEG) / 2));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.depthTex);
    gl.uniform1i(P.u.u_depth, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.colorTex);
    gl.uniform1i(P.u.u_color, 1);
    gl.uniform2f(P.u.u_texel, 1 / W, 1 / H);
    gl.uniform2f(P.u.u_ext, ext[0], ext[1]);
    gl.uniform1f(P.u.u_hs, Math.max(0.001, p.heightScale * 0.55));
    gl.uniform3fv(P.u.u_light, L);
    gl.uniform1i(P.u.u_toon, p.shading === 'toon' ? 1 : 0);
    gl.uniform1f(P.u.u_fog, p.fog);
    gl.uniform1f(P.u.u_ao, p.ao);
    gl.uniform1i(P.u.u_colorBy, Math.max(0, COLOR_BY.indexOf(p.colorBy)));
    gl.bindVertexArray(state.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);

    state.px = readPixels(gl, w, h, state.px);
    const cells = cellsFromPixels(state.px, pw, ph, state.cells, true);
    state.cells = cells;
    state.lev = autoLevel(cells.lum, cells.mask, state.lev);
    cells.lum = state.lev;
    let meta;
    if (braille) {
      meta = drawBrailleCells(ctx, state, { cols, rows, ...cells, cr, dark, threshold: p.brailleThreshold, dither: p.brailleDither });
    } else {
      meta = drawTextCells(ctx, state, { cols, rows, ...cells, p, cr, dark, gradient: p.charset === 'blocks' ? 'blocks' : undefined });
    }
    return { ...meta, depthSource: depth.source || 'brightness' };
  },

  toText(state, format, opts) {
    if (!state?.grid) return '';
    return gridToText(state.grid, format, { title: `${config.productName} volumetric text`, ...opts });
  },

  dispose(state) {
    const gl = state?.gl;
    if (gl && state.P) {
      gl.deleteProgram(state.P.prog);
      gl.deleteVertexArray(state.vao);
      if (state.depthTex) gl.deleteTexture(state.depthTex);
      if (state.colorTex) gl.deleteTexture(state.colorTex);
    }
  },
};
