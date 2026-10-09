// LiDAR scan and point cloud (PLAN.md 7.21): one point every `step` work pixels at (x, y, depth · depthScale), drawn as
// WebGL2 points in perspective with distance attenuation. Colour by depth (Turbo), height, the picture or ink.
// A scan plane sweeps through the depth and lights up the points it passes; ring mode samples dense horizontal
// scanlines like a spinning sensor; noise jitters the points per scan tick and dropout loses a fraction of them.
// Everything that moves is a function of the frame time (deterministic video export). PLY export: ASCII x y z r g b.

import { createProgram, createLineRenderer, sizeCanvas, rgb01, GLSL_TURBO, turbo } from '../engine/gl.js';
import { orbitCamera } from '../engine/math3d.js';
import { cameraParams } from '../engine/camera.js';
import { workResolution, fieldHash, hashed, logicalSize } from '../engine/vector.js';
import { hash01 } from '../engine/rand.js';
import { normalizeHex } from '../engine/color.js';
import { LIMITS, config } from '../config.js';

const COLOR_BY = ['depth', 'height', 'original', 'ink'];
const PREVIEW_CAP = 4096;
const SCAN_TICKS = 12; // noise re-rolls per second (one "scan")

const VS = `#version 300 es
in vec3 a_pos;
in vec3 a_col;
in vec2 a_rnd;          // x: per-point random 0..1 (dropout), y: depth 0..1
uniform mat4 u_viewProj;
uniform mat4 u_view;
uniform float u_pointSize;
uniform float u_scale;  // output px per logical px
uniform float u_dropout;
uniform float u_noise;
uniform float u_tick;
uniform int u_colorBy;
uniform vec3 u_ink;
uniform float u_scanPos;    // 0..1 along depth, < 0 = off
uniform float u_scanWidth;
uniform vec3 u_scanColor;
uniform float u_yRange;
out vec3 v_col;
out float v_glow;
${GLSL_TURBO}
float h1(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
void main() {
  if (a_rnd.x < u_dropout) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_col = vec3(0.0); v_glow = 0.0; return; }
  vec3 p = a_pos;
  if (u_noise > 0.0) {
    float s = a_rnd.x * 9973.0 + u_tick * 17.13;
    p += (vec3(h1(s), h1(s + 1.7), h1(s + 3.1)) - 0.5) * u_noise * 0.06;
  }
  vec4 eye = u_view * vec4(p, 1.0);
  gl_Position = u_viewProj * vec4(p, 1.0);
  vec3 c;
  if (u_colorBy == 0) c = turbo(a_rnd.y);
  else if (u_colorBy == 1) c = turbo(clamp(a_pos.y / u_yRange * 0.5 + 0.5, 0.0, 1.0));
  else if (u_colorBy == 2) c = a_col;
  else c = u_ink;
  float glow = 0.0;
  if (u_scanPos >= 0.0) {
    float d = a_rnd.y - u_scanPos;
    glow = exp(-(d * d) / max(1e-5, u_scanWidth * u_scanWidth));
    float trail = d > 0.0 ? exp(-d / max(1e-3, u_scanWidth * 4.0)) * 0.35 : 0.0; // already scanned: a fading wake
    c = mix(c, u_scanColor, clamp(glow, 0.0, 1.0)) + c * trail;
  }
  v_col = c;
  v_glow = glow;
  float dist = max(0.05, -eye.z);
  gl_PointSize = clamp(u_pointSize * u_scale * (4.5 / dist) * (1.0 + glow * 0.9), 1.0, 64.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_col;
in float v_glow;
uniform float u_alpha;
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float a = (1.0 - smoothstep(0.35, 1.0, r2)) * u_alpha;
  o = vec4(v_col * a, a);
}`;

/** Point cloud of the work field: positions, colours, per-point random and depth (cached on the CPU for PLY). */
function buildCloud(ctx, depth, p) {
  const W = ctx.width;
  const H = ctx.height;
  const rgba = ctx.rgba;
  const A = W / H;
  const ax = A >= 1 ? 1.2 : 1.2 * A;
  const ay = A >= 1 ? 1.2 / A : 1.2;
  const step = Math.max(1, Math.round(p.step));
  // ring mode: dense horizontal scanlines (every 1/3 step along x, every 2 steps down)
  const sx = p.ringMode ? Math.max(1, Math.round(step / 3)) : step;
  const sy = p.ringMode ? step * 2 : step;
  const nx = Math.floor((W - 1) / sx) + 1;
  const ny = Math.floor((H - 1) / sy) + 1;
  const n = nx * ny;
  const data = new Float32Array(n * 8);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    const y = Math.min(H - 1, j * sy);
    for (let i = 0; i < nx; i++) {
      const x = Math.min(W - 1, i * sx);
      const idx = y * W + x;
      const d = depth[idx];
      const o = k * 8;
      data[o] = (x / Math.max(1, W - 1) * 2 - 1) * ax;
      data[o + 1] = -(y / Math.max(1, H - 1) * 2 - 1) * ay;
      data[o + 2] = (d - 0.5) * p.depthScale;
      data[o + 3] = rgba[idx * 4] / 255;
      data[o + 4] = rgba[idx * 4 + 1] / 255;
      data[o + 5] = rgba[idx * 4 + 2] / 255;
      data[o + 6] = hash01(9137, i, j, 1); // deterministic per point
      data[o + 7] = d;
      k++;
    }
  }
  return { data, count: n, ay, nx, ny };
}

/** Polar grid on the ground under the cloud (circles + radial lines) as instanced segments. */
function groundGrid(y) {
  const segs = [];
  const rings = [0.5, 1, 1.5, 2];
  for (const r of rings) {
    const N = 72;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2;
      const a1 = ((i + 1) / N) * Math.PI * 2;
      segs.push(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r, 0, 0);
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    segs.push(0, y, 0, Math.cos(a) * 2, y, Math.sin(a) * 2, 0, 0);
  }
  return new Float32Array(segs);
}

export default {
  id: 'lidar',
  category: '3d',
  name: { es: 'Escaneo LiDAR', en: 'LiDAR scan' },
  blurb: { es: 'Nube de puntos 3D con barrido de escaneo', en: '3D point cloud with a scanning sweep' },
  badges: ['3D', 'GPU', 'ANIM'],
  animated: true,
  surface: 'gl',
  camera: true,
  uses: ['image', 'depth'],
  exports: ['png', 'ply', 'video'],
  draftScale: 1,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'sensor', name: { es: 'Sensor', en: 'Sensor' }, mode: { ringMode: true, colorBy: 'depth', noise: 0.3, dropout: 0.15 } },
    { id: 'photo', name: { es: 'Foto 3D', en: '3D photo' }, mode: { colorBy: 'original', step: 2, pointSize: 2, scanSpeed: 0 } },
    { id: 'night', name: { es: 'Visión nocturna', en: 'Night vision' }, mode: { colorBy: 'ink', ink: '#39ff6a', scanColor: '#ffffff' } },
  ],

  params: [
    {
      id: 'step', type: 'range', min: 1, max: 16, step: 1, default: 3, unit: 'px',
      label: { es: 'Paso entre puntos', en: 'Point step' },
      help: { es: 'Un punto cada N píxeles de la imagen de trabajo.', en: 'One point every N pixels of the work picture.' },
    },
    {
      id: 'depthScale', type: 'range', min: 0, max: 3, step: 0.05, default: 1.2,
      label: { es: 'Escala de profundidad', en: 'Depth scale' },
    },
    {
      id: 'pointSize', type: 'range', min: 0.5, max: 6, step: 0.1, default: 1.6,
      label: { es: 'Tamaño de punto', en: 'Point size' },
    },
    {
      id: 'colorBy', type: 'select', default: 'depth',
      options: [
        { value: 'depth', label: { es: 'Profundidad (Turbo)', en: 'Depth (Turbo)' } },
        { value: 'height', label: { es: 'Altura', en: 'Height' } },
        { value: 'original', label: { es: 'Color original', en: 'Original colour' } },
        { value: 'ink', label: { es: 'Tinta', en: 'Ink' } },
      ],
      label: { es: 'Color por', en: 'Colour by' },
    },
    {
      id: 'ink', type: 'color', default: '#c4f169',
      label: { es: 'Tinta', en: 'Ink' },
      showIf: (p) => p.colorBy === 'ink',
    },
    {
      id: 'bgColor', type: 'color', default: '#05070a',
      label: { es: 'Fondo', en: 'Background' },
    },
    {
      id: 'scanSpeed', type: 'range', min: 0, max: 2, step: 0.05, default: 0.35,
      label: { es: 'Velocidad de barrido', en: 'Scan speed' },
      help: { es: 'Barridos por segundo del plano de escaneo (0 = sin barrido).', en: 'Sweeps per second of the scan plane (0 = no sweep).' },
    },
    {
      id: 'scanWidth', type: 'range', min: 0.01, max: 0.3, step: 0.01, default: 0.05,
      label: { es: 'Ancho del barrido', en: 'Scan width' },
      showIf: (p) => p.scanSpeed > 0,
    },
    {
      id: 'scanColor', type: 'color', default: '#ffffff',
      label: { es: 'Color del barrido', en: 'Scan colour' },
      showIf: (p) => p.scanSpeed > 0,
    },
    {
      id: 'ringMode', type: 'toggle', default: false,
      label: { es: 'Modo anillos', en: 'Ring mode' },
      help: { es: 'Puntos alineados en líneas de escaneo densas, como un sensor real.', en: 'Points aligned on dense scanlines, like a real sensor.' },
    },
    {
      id: 'noise', type: 'range', min: 0, max: 1, step: 0.05, default: 0.1,
      label: { es: 'Ruido', en: 'Noise' },
    },
    {
      id: 'dropout', type: 'range', min: 0, max: 0.8, step: 0.01, default: 0.05,
      label: { es: 'Pérdida de puntos', en: 'Dropout' },
    },
    {
      id: 'glow', type: 'toggle', default: true,
      label: { es: 'Brillo aditivo', en: 'Additive glow' },
    },
    {
      id: 'grid', type: 'toggle', default: true,
      label: { es: 'Rejilla del suelo', en: 'Ground grid' },
    },
    ...cameraParams({ yaw: 28, pitch: 14, distance: 4.4, fov: 45, autoRotate: 8 }),
  ],

  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, 480);
  },

  init(ctx) {
    const gl = ctx.gl;
    const P = createProgram(gl, VS, FS);
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = 32;
    const attr = (name, size, off) => {
      const loc = P.a[name];
      if (loc === undefined) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    };
    attr('a_pos', 3, 0);
    attr('a_col', 3, 12);
    attr('a_rnd', 2, 24);
    gl.bindVertexArray(null);
    return { gl, P, vao, vbo, lines: createLineRenderer(gl), cloud: null, key: '', gridY: null };
  },

  async render(ctx, state) {
    const depth = await ctx.depth();
    const gl = ctx.gl;
    const p = ctx.params.mode;

    const key = hashed([ctx.width, ctx.height, fieldHash(depth, 3), fieldHash(ctx.luma(), 7), p.step, p.ringMode, p.depthScale]);
    if (state.key !== key) {
      state.cloud = buildCloud(ctx, depth, p);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, state.cloud.data, gl.STATIC_DRAW);
      state.key = key;
      const gy = -state.cloud.ay - 0.15;
      if (state.gridY !== gy) {
        const segs = groundGrid(gy);
        state.lines.setSegments(segs, segs.length / 8);
        state.gridY = gy;
      }
    }

    const { LW, LH } = logicalSize(ctx);
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : PREVIEW_CAP;
    const s = Math.max(0.05, Math.min(ctx.outScale || 1, cap / LW, cap / LH));
    const { w, h } = sizeCanvas(gl, ctx.out.canvas, LW * s, LH * s);
    const cam = orbitCamera(p, { time: ctx.time, aspect: w / h });

    const bg = rgb01(normalizeHex(p.bgColor) || '#05070a');
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (p.grid) {
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const gc = p.colorBy === 'ink' ? rgb01(p.ink) : [0.45, 0.6, 0.75];
      state.lines.draw({ viewProj: cam.viewProj, width: w, height: h, lineWidth: Math.max(1, s), color: [gc[0], gc[1], gc[2], 0.22] });
    }

    const { P } = state;
    gl.useProgram(P.prog);
    if (p.glow) {
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive: dense areas bloom
    } else {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    const scanPos = p.scanSpeed > 0 ? ((ctx.time * p.scanSpeed) % 1.2) - 0.1 : -1; // 1.2: a short pause between sweeps
    gl.uniformMatrix4fv(P.u.u_viewProj, false, cam.viewProj);
    gl.uniformMatrix4fv(P.u.u_view, false, cam.view);
    gl.uniform1f(P.u.u_pointSize, p.pointSize);
    gl.uniform1f(P.u.u_scale, s);
    gl.uniform1f(P.u.u_dropout, p.dropout);
    gl.uniform1f(P.u.u_noise, p.noise);
    gl.uniform1f(P.u.u_tick, Math.floor(ctx.time * SCAN_TICKS + 1e-6));
    gl.uniform1i(P.u.u_colorBy, Math.max(0, COLOR_BY.indexOf(p.colorBy)));
    gl.uniform3fv(P.u.u_ink, rgb01(p.ink));
    gl.uniform1f(P.u.u_scanPos, scanPos < -0.05 ? -1 : 1 - scanPos); // sweep from near (1) to far (0)
    gl.uniform1f(P.u.u_scanWidth, p.scanWidth);
    gl.uniform3fv(P.u.u_scanColor, rgb01(p.scanColor));
    gl.uniform1f(P.u.u_yRange, state.cloud.ay);
    gl.uniform1f(P.u.u_alpha, p.glow ? 0.55 : 1);
    gl.bindVertexArray(state.vao);
    gl.drawArrays(gl.POINTS, 0, state.cloud.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    state.ply = { colorBy: p.colorBy, ink: p.ink, dropout: p.dropout, ay: state.cloud.ay };
    let kept = 0;
    const data = state.cloud.data;
    for (let i = 0; i < state.cloud.count; i++) if (!(data[i * 8 + 6] < p.dropout)) kept++;
    return { cols: state.cloud.nx, rows: state.cloud.ny, points: kept, effectiveScale: s, depthSource: depth.source || 'brightness' };
  },

  /** ASCII PLY of the current cloud (dropout applied, scan noise not): x y z and the colour of `colorBy`. */
  toPLY(state) {
    if (!state?.cloud) return '';
    const { data, count } = state.cloud;
    const { colorBy, ink, dropout, ay } = state.ply;
    const inkRgb = rgb01(ink);
    const lines = [];
    const f = (v) => (Math.round(v * 1e5) / 1e5).toString();
    for (let i = 0; i < count; i++) {
      const o = i * 8;
      if (data[o + 6] < dropout) continue;
      let c;
      if (colorBy === 'depth') c = turbo(data[o + 7]);
      else if (colorBy === 'height') c = turbo(Math.max(0, Math.min(1, (data[o + 1] / ay) * 0.5 + 0.5)));
      else if (colorBy === 'original') c = [data[o + 3], data[o + 4], data[o + 5]];
      else c = inkRgb;
      const b = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
      lines.push(`${f(data[o])} ${f(data[o + 1])} ${f(data[o + 2])} ${b(c[0])} ${b(c[1])} ${b(c[2])}`);
    }
    const header = [
      'ply', 'format ascii 1.0', `comment ${config.productName} LiDAR point cloud`, `element vertex ${lines.length}`,
      'property float x', 'property float y', 'property float z',
      'property uchar red', 'property uchar green', 'property uchar blue', 'end_header',
    ];
    return `${header.join('\n')}\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
  },

  dispose(state) {
    const gl = state?.gl;
    if (gl && state.P) {
      gl.deleteProgram(state.P.prog);
      gl.deleteVertexArray(state.vao);
      gl.deleteBuffer(state.vbo);
      state.lines.dispose();
    }
  },
};
