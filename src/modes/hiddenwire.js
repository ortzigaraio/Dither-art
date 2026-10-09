// Hidden-line CAD wireframe (PLAN.md 7.22): a height mesh built from the depth (meshRes cells along the long side),
// drawn with hidden-line removal on WebGL2:
//   pass 1  the triangles, filled with the background colour, with polygonOffset (they only write depth)
//   pass 2  (optional) hidden edges: depthFunc(GREATER), dashed and faint
//   pass 3  visible edges with the depth test
// Edges are thick instanced quads (engine/gl.js), since core WebGL draws 1 px lines only.
// Topologies: rows, columns, grid, triangles. Cameras: perspective / orthographic orbit, isometric, front, top.
//
// SVG export of the visible segments only: the triangles are rendered once more into an offscreen target that stores
// the view depth (24 bits packed in RGBA8), read back with readPixels; every edge is sampled about once per pixel on
// the CPU with the same matrices (engine/math3d.js) and kept where its depth is not behind the stored surface.

import { createProgram, createLineRenderer, sizeCanvas, ensureTarget, readPixels, rgb01 } from '../engine/gl.js';
import { orbitCamera, transform4 } from '../engine/math3d.js';
import { cameraParams } from '../engine/camera.js';
import { workResolution, fieldHash, hashed, logicalSize } from '../engine/vector.js';
import { normalizeHex } from '../engine/color.js';
import { sceneToSVG } from '../io/exportSVG.js';
import { LIMITS, config } from '../config.js';

const PREVIEW_CAP = 4096;

export const STYLES = {
  dark: { bg: '#05070a', line: '#e8eef5', hidden: '#5b6470' },
  paper: { bg: '#f4f3ee', line: '#15181e', hidden: '#9aa0a8' },
  cad: { bg: '#0d1b2a', line: '#7fd4ff', hidden: '#2f5d7c' },
};

const FILL_VS = `#version 300 es
in vec3 a_pos;
uniform mat4 u_viewProj;
uniform mat4 u_view;
out float v_z;
void main() {
  v_z = -(u_view * vec4(a_pos, 1.0)).z;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}`;

const FILL_FS = `#version 300 es
precision highp float;
in float v_z;
uniform vec4 u_color;
uniform int u_encode;   // 1: write the view depth packed in RGB (24 bits)
uniform vec2 u_zr;      // depth range for the packing
out vec4 o;
void main() {
  if (u_encode == 1) {
    float d = clamp((v_z - u_zr.x) / (u_zr.y - u_zr.x), 0.0, 0.99999);
    vec3 enc = fract(d * vec3(1.0, 255.0, 65025.0));
    enc.xy -= enc.yz / 255.0;
    o = vec4(enc, 1.0);
  } else {
    o = u_color;
  }
}`;

/** Height mesh from the depth field: vertex positions (x, height, z) on an nx x ny grid. */
export function buildMesh(depth, W, H, p, aspect) {
  const res = Math.max(2, Math.round(p.meshRes));
  const nx = aspect >= 1 ? res + 1 : Math.max(2, Math.round(res * aspect) + 1);
  const ny = aspect >= 1 ? Math.max(2, Math.round(res / aspect) + 1) : res + 1;
  const ax = aspect >= 1 ? 1.25 : 1.25 * aspect;
  const az = aspect >= 1 ? 1.25 / aspect : 1.25;
  const hs = p.heightScale * 0.6;
  const pos = new Float32Array(nx * ny * 3);
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const v = j / (ny - 1);
    let fy = v * (H - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(H - 1, y0 + 1);
    fy -= y0;
    for (let i = 0; i < nx; i++) {
      const u = i / (nx - 1);
      let fx = u * (W - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(W - 1, x0 + 1);
      fx -= x0;
      const a = depth[y0 * W + x0] + (depth[y0 * W + x1] - depth[y0 * W + x0]) * fx;
      const b = depth[y1 * W + x0] + (depth[y1 * W + x1] - depth[y1 * W + x0]) * fx;
      const d = a + (b - a) * fy;
      const k = j * nx + i;
      heights[k] = d * hs;
      pos[k * 3] = (u * 2 - 1) * ax;
      pos[k * 3 + 1] = d * hs;
      pos[k * 3 + 2] = (v * 2 - 1) * az;
    }
  }
  const tri = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let t = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      tri[t++] = a; tri[t++] = c; tri[t++] = d;
      tri[t++] = a; tri[t++] = d; tri[t++] = b;
    }
  }
  return { nx, ny, ax, az, hs, pos, heights, tri };
}

/**
 * Edge lines of a topology: each line is a list of vertex indices (rows, columns, and for 'triangles' the diagonals
 * matching the triangle split a-d).
 */
export function meshLines(mesh, topology) {
  const { nx, ny } = mesh;
  const lines = [];
  if (topology !== 'cols') for (let j = 0; j < ny; j++) lines.push({ kind: 'row', index: j, v: Array.from({ length: nx }, (_, i) => j * nx + i) });
  if (topology !== 'rows') for (let i = 0; i < nx; i++) lines.push({ kind: 'col', index: i, v: Array.from({ length: ny }, (_, j) => j * nx + i) });
  if (topology === 'triangles') {
    // diagonals a -> d run down-right: one line per diagonal of the grid
    for (let s = -(ny - 2); s <= nx - 2; s++) {
      const v = [];
      for (let j = 0; j < ny; j++) {
        const i = j + s;
        if (i >= 0 && i < nx) v.push(j * nx + i);
      }
      if (v.length >= 2) lines.push({ kind: 'diag', index: s, v });
    }
  }
  return lines;
}

/** Instanced segment data [x0 y0 z0 x1 y1 z1 along0 along1] for the line renderer. */
function segmentData(mesh, lines) {
  let n = 0;
  for (const l of lines) n += l.v.length - 1;
  const out = new Float32Array(n * 8);
  const P = mesh.pos;
  let k = 0;
  for (const l of lines) {
    let along = 0;
    for (let i = 0; i + 1 < l.v.length; i++) {
      const a = l.v[i] * 3;
      const b = l.v[i + 1] * 3;
      const len = Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
      out.set([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], along, along + len], k * 8);
      along += len;
      k++;
    }
  }
  return { data: out, count: n };
}

/** Camera of the chosen preset (presets fix the angles; distance, field of view and pan stay the user's). */
export function cameraFor(p, time, aspect, mesh) {
  const target = [0, mesh.hs * 0.35, 0];
  if (p.camera === 'isometric') return orbitCamera({ ...p, yaw: 45, pitch: 35.264, autoRotate: 0 }, { time, aspect, projection: 'ortho', target });
  if (p.camera === 'front') return orbitCamera({ ...p, yaw: 0, pitch: 0, autoRotate: 0 }, { time, aspect, projection: 'ortho', target });
  if (p.camera === 'top') return orbitCamera({ ...p, yaw: 0, pitch: 89, autoRotate: 0 }, { time, aspect, projection: 'ortho', target });
  return orbitCamera(p, { time, aspect, projection: p.camera === 'ortho' ? 'ortho' : 'perspective', target });
}

/**
 * Visible / hidden polylines of every edge line, sampled against the depth buffer (24-bit packed view depth).
 * Coordinates are output pixels (y down). Returns { visible: [{points, kind, index}], hidden: [...] }.
 */
export function classifyEdges(mesh, lines, cam, buf, w, h, zr) {
  const P = mesh.pos;
  const span = zr[1] - zr[0];
  const depthAt = (x, y) => {
    // buffer rows are bottom-up
    let best = -Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = Math.min(h - 1, Math.max(0, Math.floor(y) + dy));
      const row = (h - 1 - yy) * w;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(w - 1, Math.max(0, Math.floor(x) + dx));
        const o = (row + xx) * 4;
        if (buf[o + 3] === 0 || (buf[o] === 255 && buf[o + 1] === 255 && buf[o + 2] === 255)) return Infinity; // background
        const d = (buf[o] / 255 + buf[o + 1] / 65025 + buf[o + 2] / 16581375) * span + zr[0];
        if (d > best) best = d;
      }
    }
    return best;
  };
  const eps = Math.max(0.004, span * 0.004);
  const VP = cam.viewProj;
  const V = cam.view;
  const out = { visible: [], hidden: [] };
  for (const l of lines) {
    let cur = null;
    let curVis = null;
    const flush = () => {
      if (cur && cur.length >= 4) (curVis ? out.visible : out.hidden).push({ points: Float32Array.from(cur), kind: l.kind, index: l.index });
      cur = null;
    };
    for (let s = 0; s + 1 < l.v.length; s++) {
      const a = l.v[s] * 3;
      const b = l.v[s + 1] * 3;
      const ca = transform4(VP, P[a], P[a + 1], P[a + 2]);
      const cb = transform4(VP, P[b], P[b + 1], P[b + 2]);
      const sa = [(ca[0] / ca[3] * 0.5 + 0.5) * w, (0.5 - ca[1] / ca[3] * 0.5) * h];
      const sb = [(cb[0] / cb[3] * 0.5 + 0.5) * w, (0.5 - cb[1] / cb[3] * 0.5) * h];
      const k = Math.max(1, Math.ceil(Math.hypot(sb[0] - sa[0], sb[1] - sa[1])));
      for (let q = s === 0 ? 0 : 1; q <= k; q++) {
        const t = q / k;
        const x = P[a] + (P[b] - P[a]) * t;
        const y = P[a + 1] + (P[b + 1] - P[a + 1]) * t;
        const z = P[a + 2] + (P[b + 2] - P[a + 2]) * t;
        const c = transform4(VP, x, y, z);
        const sx = (c[0] / c[3] * 0.5 + 0.5) * w;
        const sy = (0.5 - c[1] / c[3] * 0.5) * h;
        const ze = -(V[2] * x + V[6] * y + V[10] * z + V[14]);
        const inside = sx >= 0 && sx < w && sy >= 0 && sy < h;
        const vis = inside && ze <= depthAt(sx, sy) + eps;
        if (!inside) { flush(); continue; }
        if (cur && vis !== curVis) {
          // close the run on this sample so the two pieces meet
          cur.push(sx, sy);
          flush();
        }
        if (!cur) { cur = []; curVis = vis; }
        cur.push(sx, sy);
      }
    }
    flush();
  }
  return out;
}

export default {
  id: 'hiddenwire',
  category: '3d',
  name: { es: 'Wireframe CAD oculto', en: 'Hidden-line CAD wireframe' },
  blurb: { es: 'Malla 3D de la profundidad con líneas ocultas eliminadas', en: '3D mesh from depth with hidden lines removed' },
  badges: ['SVG', '3D', 'GPU', 'ANIM'],
  animated: false,
  animatedWhen: (p) => !!p.autoRotate && (p.camera === 'perspective' || p.camera === 'ortho'),
  surface: 'gl',
  camera: true,
  uses: ['image', 'depth'],
  exports: ['png', 'svg', 'video'],
  svgOptions: true,
  draftScale: 1,
  hide: ['cols', 'dither', 'serpentine'],

  presets: [
    { id: 'blueprint', name: { es: 'CAD', en: 'CAD' }, mode: { style: 'cad', topology: 'grid', camera: 'isometric' } },
    { id: 'technical', name: { es: 'Técnico', en: 'Technical' }, mode: { style: 'paper', topology: 'triangles', hiddenDashed: true } },
    { id: 'pleasures', name: { es: 'Líneas', en: 'Lines' }, mode: { style: 'dark', topology: 'rows', meshRes: 120, camera: 'perspective', pitch: 18 } },
  ],

  params: [
    {
      id: 'meshRes', type: 'range', min: 20, max: 200, step: 1, default: 80,
      label: { es: 'Resolución de la malla', en: 'Mesh resolution' },
      help: { es: 'Celdas a lo largo del lado mayor.', en: 'Cells along the long side.' },
    },
    {
      id: 'heightScale', type: 'range', min: 0, max: 2, step: 0.05, default: 0.7,
      label: { es: 'Altura', en: 'Height' },
    },
    {
      id: 'topology', type: 'select', default: 'grid',
      options: [
        { value: 'rows', label: { es: 'Solo filas', en: 'Rows only' } },
        { value: 'cols', label: { es: 'Solo columnas', en: 'Columns only' } },
        { value: 'grid', label: { es: 'Rejilla', en: 'Grid' } },
        { value: 'triangles', label: { es: 'Triángulos', en: 'Triangles' } },
      ],
      label: { es: 'Topología', en: 'Topology' },
    },
    {
      id: 'camera', type: 'select', default: 'perspective',
      options: [
        { value: 'perspective', label: { es: 'Perspectiva', en: 'Perspective' } },
        { value: 'ortho', label: { es: 'Ortográfica (órbita)', en: 'Orthographic (orbit)' } },
        { value: 'isometric', label: { es: 'Isométrica', en: 'Isometric' } },
        { value: 'front', label: { es: 'Ortográfica frontal', en: 'Front orthographic' } },
        { value: 'top', label: { es: 'Ortográfica superior', en: 'Top orthographic' } },
      ],
      label: { es: 'Cámara', en: 'Camera' },
    },
    {
      id: 'style', type: 'select', default: 'dark',
      options: [
        { value: 'dark', label: { es: 'Blanco sobre negro', en: 'White on black' } },
        { value: 'paper', label: { es: 'Negro sobre blanco (técnico)', en: 'Black on white (technical)' } },
        { value: 'cad', label: { es: 'CAD cian', en: 'CAD cyan' } },
      ],
      label: { es: 'Estilo', en: 'Style' },
    },
    {
      id: 'lineWidth', type: 'range', min: 0.5, max: 4, step: 0.1, default: 1.1, unit: 'px',
      label: { es: 'Grosor de línea', en: 'Line width' },
    },
    {
      id: 'hiddenDashed', type: 'toggle', default: false,
      label: { es: 'Líneas ocultas discontinuas', en: 'Dashed hidden lines' },
      help: { es: 'Muestra las aristas ocultas en discontinuo tenue (también en el SVG).', en: 'Shows hidden edges as faint dashes (also in the SVG).' },
    },
    ...cameraParams({ yaw: 30, pitch: 32, distance: 3.3, fov: 40, autoRotate: 0 }),
  ],

  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, 320);
  },

  init(ctx) {
    const gl = ctx.gl;
    const P = createProgram(gl, FILL_VS, FILL_FS);
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(P.a.a_pos);
    gl.vertexAttribPointer(P.a.a_pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
    return { gl, P, vao, vbo, ibo, lines: createLineRenderer(gl), mesh: null, edgeLines: null, key: '', targets: {}, scene: null };
  },

  async render(ctx, state) {
    const depth = await ctx.depth();
    const gl = ctx.gl;
    const p = ctx.params.mode;
    const style = STYLES[p.style] || STYLES.dark;
    const W = ctx.width;
    const H = ctx.height;

    const key = hashed([W, H, fieldHash(depth, 3), p.meshRes, p.heightScale, p.topology]);
    if (state.key !== key) {
      state.mesh = buildMesh(depth, W, H, p, W / H);
      state.edgeLines = meshLines(state.mesh, p.topology);
      const seg = segmentData(state.mesh, state.edgeLines);
      gl.bindVertexArray(state.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, state.mesh.pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, state.mesh.tri, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      state.lines.setSegments(seg.data, seg.count);
      state.key = key;
    }
    const mesh = state.mesh;

    const { LW, LH } = logicalSize(ctx);
    const cap = ctx.isExport ? LIMITS.maxExportImageSide : PREVIEW_CAP;
    const s = Math.max(0.05, Math.min(ctx.outScale || 1, cap / LW, cap / LH));
    const { w, h } = sizeCanvas(gl, ctx.out.canvas, LW * s, LH * s);
    const cam = cameraFor(p, ctx.time, w / h, mesh);
    const bg = rgb01(normalizeHex(style.bg));
    const lw = Math.max(1, p.lineWidth * s);

    const drawFill = (encode, zr) => {
      const { P } = state;
      gl.useProgram(P.prog);
      gl.uniformMatrix4fv(P.u.u_viewProj, false, cam.viewProj);
      gl.uniformMatrix4fv(P.u.u_view, false, cam.view);
      gl.uniform4f(P.u.u_color, bg[0], bg[1], bg[2], 1);
      gl.uniform1i(P.u.u_encode, encode ? 1 : 0);
      gl.uniform2f(P.u.u_zr, zr[0], zr[1]);
      gl.bindVertexArray(state.vao);
      gl.drawElements(gl.TRIANGLES, mesh.tri.length, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    };

    gl.disable(gl.BLEND);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 2);
    drawFill(false, [0, 1]);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(false);
    if (p.hiddenDashed) {
      gl.depthFunc(gl.GREATER);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const hc = rgb01(style.hidden);
      state.lines.draw({ viewProj: cam.viewProj, width: w, height: h, lineWidth: Math.max(1, lw * 0.8), color: [hc[0], hc[1], hc[2], 0.9], dash: 0.05 });
      gl.disable(gl.BLEND);
    }
    gl.depthFunc(gl.LEQUAL);
    const lc = rgb01(style.line);
    state.lines.draw({ viewProj: cam.viewProj, width: w, height: h, lineWidth: lw, color: [lc[0], lc[1], lc[2], 1] });
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);

    // exports: classify every edge against a depth render for the SVG (visible segments only)
    state.scene = null;
    if (ctx.isExport) {
      const R = Math.hypot(mesh.ax, mesh.az, mesh.hs) + 0.1;
      const zc = cam.distance;
      const zr = [Math.max(1e-3, zc - R - 0.5), zc + R + 0.5];
      const T = ensureTarget(gl, state.targets, 'depth', w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      drawFill(true, zr);
      gl.disable(gl.DEPTH_TEST);
      const buf = readPixels(gl, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      const cls = classifyEdges(mesh, state.edgeLines, cam, buf, w, h, zr);
      const toLogical = (list) => list.map((l) => {
        const pts = l.points;
        for (let i = 0; i < pts.length; i++) pts[i] /= s;
        return { points: pts, closed: false, kind: l.kind, index: l.index };
      });
      const layers = [];
      if (p.hiddenDashed && cls.hidden.length) {
        layers.push({ id: 'hidden', label: 'Hidden edges', color: style.hidden, width: Math.max(0.3, p.lineWidth * 0.8), dash: [4, 3], paths: toLogical(cls.hidden) });
      }
      layers.push({ id: 'visible', label: 'Visible edges', color: style.line, width: p.lineWidth, paths: toLogical(cls.visible) });
      state.scene = {
        width: LW, height: LH, background: style.bg, layers,
        title: `${config.productName} hidden-line wireframe`, desc: `${p.topology}, ${p.camera}, mesh ${mesh.nx}x${mesh.ny}`,
      };
      state.classified = { visible: cls.visible.length, hidden: cls.hidden.length };
    }
    state.camera = { viewProj: Array.from(cam.viewProj), w, h, s };
    return { cols: mesh.nx, rows: mesh.ny, effectiveScale: s, depthSource: depth.source || 'brightness' };
  },

  toSVG(state, opts = {}) {
    return state?.scene ? sceneToSVG(state.scene, opts) : '';
  },

  dispose(state) {
    const gl = state?.gl;
    if (gl && state.P) {
      gl.deleteProgram(state.P.prog);
      gl.deleteVertexArray(state.vao);
      gl.deleteBuffer(state.vbo);
      gl.deleteBuffer(state.ibo);
      state.lines.dispose();
      for (const t of Object.values(state.targets)) t.dispose();
    }
  },
};
