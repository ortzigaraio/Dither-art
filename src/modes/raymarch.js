// Raymarched 3D ASCII (PLAN.md 7.23): a signed-distance scene (torus — a homage to donut.c —, sphere, rounded cube,
// octahedron, gyroid or an animated morph) raymarched in a WebGL2 fragment shader at one pixel per character cell.
// The picture is wrapped on the object as a texture (triplanar or spherical mapping) and can displace its surface.
// The tiny render is read back (readPixels) and drawn with the ASCII glyph renderer, so it exports as TXT / HTML / ANSI.
// Motion is a pure function of the frame time (object spin + camera auto-rotation): video exports are deterministic.

import asciiMode from './ascii.js';
import { createProgram, createTexture, sizeCanvas, readPixels, FULLSCREEN_VS } from '../engine/gl.js';
import { orbitCamera, DEG } from '../engine/math3d.js';
import { cameraParams } from '../engine/camera.js';
import { workResolution, fieldHash } from '../engine/vector.js';
import { resolveColors, isDarkBackground, rgbToHex } from '../engine/color.js';
import { TEXT_COLOR_MODES, textRows, cellAspectOf, cellsFromPixels, drawTextCells } from '../engine/textcells.js';
import { cropRect } from '../engine/preprocess.js';
import { gridToText } from '../io/exportText.js';
import { LIMITS, config } from '../config.js';

const TEXT_PARAM_IDS = ['gradient', 'customGradient', 'autoSort', 'invertGradient', 'spaceDensity', 'font', 'cellSize', 'lineHeight', 'letterSpacing'];
export const TEXT_PARAMS = asciiMode.params.filter((p) => TEXT_PARAM_IDS.includes(p.id));

const SHAPES = ['torus', 'sphere', 'box', 'octahedron', 'gyroid', 'morph'];
const hexOf = (rgb) => rgbToHex(rgb[0], rgb[1], rgb[2]);

const FS = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_aspect;       // width / height of the whole picture
uniform vec3 u_eye, u_right, u_up, u_fwd;
uniform float u_tanHalf;
uniform mat3 u_rot;           // object rotation (world -> object)
uniform int u_shape;
uniform float u_time;
uniform sampler2D u_tex;
uniform float u_texMix;
uniform float u_disp;
uniform int u_mapping;        // 0 triplanar, 1 spherical
uniform vec3 u_light;
uniform float u_far;
out vec4 o;

const float PI = 3.14159265;

vec3 texAt(vec3 q, vec3 n) {
  if (u_mapping == 1) {
    vec3 s = normalize(q + 1e-6);
    vec2 uv = vec2(atan(s.z, s.x) / (2.0 * PI) + 0.5, acos(clamp(s.y, -1.0, 1.0)) / PI);
    return texture(u_tex, uv).rgb;
  }
  vec3 w = pow(abs(n), vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-6);
  vec3 a = texture(u_tex, vec2(0.5 + q.z * 0.5, 0.5 - q.y * 0.5)).rgb;
  vec3 b = texture(u_tex, vec2(0.5 + q.x * 0.5, 0.5 - q.z * 0.5)).rgb;
  vec3 c = texture(u_tex, vec2(0.5 + q.x * 0.5, 0.5 - q.y * 0.5)).rgb;
  return a * w.x + b * w.y + c * w.z;
}

float sdTorus(vec3 p) { vec2 q = vec2(length(p.xz) - 0.95, p.y); return length(q) - 0.42; }
float sdSphere(vec3 p) { return length(p) - 1.05; }
float sdBox(vec3 p) { vec3 q = abs(p) - vec3(0.72); return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - 0.16; }
float sdOcta(vec3 p) { p = abs(p); return (p.x + p.y + p.z - 1.25) * 0.57735027; }
float sdGyroid(vec3 p) {
  float k = 3.2;
  float g = abs(dot(sin(p * k), cos(p.zxy * k))) / k - 0.06;
  return max(length(p) - 1.15, g * 0.75);
}
float shapeD(int s, vec3 p) {
  if (s == 0) return sdTorus(p);
  if (s == 1) return sdSphere(p);
  if (s == 2) return sdBox(p);
  if (s == 3) return sdOcta(p);
  return sdGyroid(p);
}
float baseD(vec3 q) {
  if (u_shape < 5) return shapeD(u_shape, q);
  // morph: torus -> sphere -> cube -> octahedron -> gyroid -> torus ..., a smooth blend in the last 40 % of each stage
  float t = u_time * 0.3;
  int i = int(mod(floor(t), 5.0));
  int j = int(mod(floor(t) + 1.0, 5.0));
  float f = smoothstep(0.6, 1.0, fract(t));
  return mix(shapeD(i, q), shapeD(j, q), f);
}
float sceneD(vec3 p) {
  vec3 q = u_rot * p;
  float d = baseD(q);
  if (u_disp > 0.0 && d < 0.4) {
    vec3 c = texAt(q, normalize(q + 1e-6));
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    d -= (l - 0.5) * u_disp * 0.28;
  }
  return d;
}
vec3 normalAt(vec3 p, float t) {
  float e = 0.0015 * max(1.0, t);
  vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * sceneD(p + k.xyy * e) + k.yyx * sceneD(p + k.yyx * e) + k.yxy * sceneD(p + k.yxy * e) + k.xxx * sceneD(p + k.xxx * e));
}
float occlusion(vec3 p, vec3 n) {
  float occ = 0.0;
  float w = 1.0;
  for (int i = 1; i <= 4; i++) {
    float h = 0.06 * float(i);
    occ += (h - sceneD(p + n * h)) * w;
    w *= 0.6;
  }
  return clamp(1.0 - occ * 2.2, 0.0, 1.0);
}
void main() {
  vec2 ndc = gl_FragCoord.xy / u_res * 2.0 - 1.0;
  ndc.x *= u_aspect;
  vec3 rd = normalize(u_fwd + (u_right * ndc.x + u_up * ndc.y) * u_tanHalf);
  vec3 ro = u_eye;
  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < 110; i++) {
    vec3 p = ro + rd * t;
    float d = sceneD(p);
    if (d < 0.0008 * max(1.0, t)) { hit = true; break; }
    t += d * 0.8;
    if (t > u_far) break;
  }
  if (!hit) { o = vec4(0.0); return; }
  vec3 p = ro + rd * t;
  vec3 n = normalAt(p, t);
  vec3 q = u_rot * p;
  vec3 qn = u_rot * n;
  vec3 L = normalize(u_light);
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), -rd), 0.0), 28.0);
  float ao = occlusion(p, n);
  float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
  float shade = 0.07 + 0.88 * diff * (0.55 + 0.45 * ao) + 0.08 * rim * ao;
  vec3 albedo = mix(vec3(1.0), texAt(q, qn), u_texMix);
  vec3 col = albedo * shade + vec3(0.55) * spec * ao;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/**
 * Object rotation at time t: R = Rx(rotX t) * Ry(rotY t) (object -> world). The shader needs world -> object, the
 * transpose; a column-major mat3 whose columns are the rows of R is exactly R^T.
 */
export function objectRotation(rotX, rotY, t) {
  const ax = rotX * DEG * t;
  const ay = rotY * DEG * t;
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  const R = [
    [cy, 0, sy],
    [sx * sy, cx, -sx * cy],
    [-cx * sy, sx, cx * cy],
  ];
  return new Float32Array([...R[0], ...R[1], ...R[2]]);
}

const MODE = {
  id: 'raymarch',
  category: '3d',
  name: { es: 'ASCII raymarching 3D', en: 'Raymarched 3D ASCII' },
  blurb: { es: 'Geometría 3D con SDF en la GPU, dibujada con caracteres', en: 'GPU signed-distance 3D shapes drawn with characters' },
  badges: ['TXT', '3D', 'GPU', 'ANIM'],
  animated: true,
  surface: 'gl',
  camera: true,
  uses: ['image', 'color'],
  colorModes: TEXT_COLOR_MODES,
  exports: ['png', 'txt', 'html', 'ansi', 'video'],
  draftScale: 1,

  presets: [
    { id: 'donut', name: { es: 'donut.c', en: 'donut.c' }, mode: { shape: 'torus', textureMix: 0, displace: 0, gradient: 'standard' } },
    { id: 'planet', name: { es: 'Planeta', en: 'Planet' }, mode: { shape: 'sphere', mapping: 'spherical', textureMix: 1, displace: 0.35, rotX: 0, rotY: 30 } },
    { id: 'gyroid', name: { es: 'Giroide', en: 'Gyroid' }, mode: { shape: 'gyroid', textureMix: 0.5, gradient: 'detailed' } },
  ],

  params: [
    {
      id: 'shape', type: 'select', default: 'torus',
      options: [
        { value: 'torus', label: { es: 'Toroide (donut.c)', en: 'Torus (donut.c)' } },
        { value: 'sphere', label: { es: 'Esfera', en: 'Sphere' } },
        { value: 'box', label: { es: 'Cubo redondeado', en: 'Rounded cube' } },
        { value: 'octahedron', label: { es: 'Octaedro', en: 'Octahedron' } },
        { value: 'gyroid', label: { es: 'Giroide', en: 'Gyroid' } },
        { value: 'morph', label: { es: 'Morph (animado)', en: 'Morph (animated)' } },
      ],
      label: { es: 'Forma', en: 'Shape' },
    },
    {
      id: 'rotX', type: 'range', min: -180, max: 180, step: 1, default: 40, unit: '°/s',
      label: { es: 'Giro en X', en: 'Spin X' },
    },
    {
      id: 'rotY', type: 'range', min: -180, max: 180, step: 1, default: 65, unit: '°/s',
      label: { es: 'Giro en Y', en: 'Spin Y' },
    },
    {
      id: 'lightAngle', type: 'range', min: 0, max: 360, step: 1, default: 45, unit: '°',
      label: { es: 'Ángulo de la luz', en: 'Light angle' },
    },
    {
      id: 'mapping', type: 'select', default: 'triplanar',
      options: [
        { value: 'triplanar', label: { es: 'Triplanar', en: 'Triplanar' } },
        { value: 'spherical', label: { es: 'Esférico', en: 'Spherical' } },
      ],
      label: { es: 'Proyección de la imagen', en: 'Picture mapping' },
    },
    {
      id: 'textureMix', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6,
      label: { es: 'Mezcla de textura', en: 'Texture mix' },
      help: { es: '0 = solo sombreado; 1 = la imagen pinta la superficie.', en: '0 = shading only; 1 = the picture paints the surface.' },
    },
    {
      id: 'displace', type: 'range', min: 0, max: 1, step: 0.05, default: 0.15,
      label: { es: 'Desplazamiento', en: 'Displacement' },
      help: { es: 'La luminosidad de la imagen levanta o hunde la superficie.', en: 'The picture\'s brightness raises or sinks the surface.' },
    },
    ...cameraParams({ yaw: 0, pitch: 8, distance: 4.4, fov: 40, autoRotate: 0 }),
    ...TEXT_PARAMS,
  ],

  /** The work picture is the texture (≤ 384 px); the character grid follows the global columns. */
  resolution(params, srcW, srcH) {
    return workResolution(srcW, srcH, 384);
  },

  preOptions(params, theme) {
    const cr = resolveColors(params.color, theme, TEXT_COLOR_MODES);
    const dark = isDarkBackground(cr);
    return { matte: cr.bgTransparent ? (dark ? '#000000' : '#ffffff') : hexOf(cr.bg), edgeBlend: dark ? 'light' : 'dark' };
  },

  init(ctx) {
    const gl = ctx.gl;
    return { gl, P: createProgram(gl, FULLSCREEN_VS, FS), vao: gl.createVertexArray(), tex: null, texKey: '', px: null, cells: {} };
  },

  render(ctx, state) {
    const gl = ctx.gl;
    const p = ctx.params.mode;
    const cr = resolveColors(ctx.params.color, ctx.theme, TEXT_COLOR_MODES);
    const dark = isDarkBackground(cr);
    const crop = cropRect(ctx.params.global, ctx.srcWidth, ctx.srcHeight);
    const cols = Math.max(4, Math.min(LIMITS.maxCols, Math.round(ctx.params.global.cols)));
    const rows = Math.min(LIMITS.maxCols, textRows(p, cols, crop.sw, crop.sh));

    // picture texture (re-uploaded only when the analysed picture changes)
    const rgba = ctx.rgba;
    const key = `${ctx.width}x${ctx.height}|${fieldHash(ctx.luma(), 5)}`;
    if (state.texKey !== key) {
      if (state.tex) gl.deleteTexture(state.tex);
      state.tex = createTexture(gl, { width: ctx.width, height: ctx.height, data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), wrap: gl.REPEAT });
      state.texKey = key;
    }

    const { w, h } = sizeCanvas(gl, ctx.out.canvas, cols, rows);
    const aspect = (cols * cellAspectOf(p)) / rows;
    const cam = orbitCamera(p, { time: ctx.time, aspect });
    const la = p.lightAngle * DEG;
    // light from the camera side, rotated around the view axis by lightAngle
    const L = [
      cam.right[0] * Math.cos(la) + cam.up[0] * Math.sin(la) * 0.8 - cam.forward[0] * 0.9,
      cam.right[1] * Math.cos(la) + cam.up[1] * Math.sin(la) * 0.8 - cam.forward[1] * 0.9,
      cam.right[2] * Math.cos(la) + cam.up[2] * Math.sin(la) * 0.8 - cam.forward[2] * 0.9,
    ];

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
    gl.uniformMatrix3fv(P.u.u_rot, false, objectRotation(p.rotX, p.rotY, ctx.time));
    gl.uniform1i(P.u.u_shape, Math.max(0, SHAPES.indexOf(p.shape)));
    gl.uniform1f(P.u.u_time, ctx.time);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.tex);
    gl.uniform1i(P.u.u_tex, 0);
    gl.uniform1f(P.u.u_texMix, p.textureMix);
    gl.uniform1f(P.u.u_disp, p.displace);
    gl.uniform1i(P.u.u_mapping, p.mapping === 'spherical' ? 1 : 0);
    gl.uniform3fv(P.u.u_light, L);
    gl.uniform1f(P.u.u_far, cam.distance + 4);
    gl.bindVertexArray(state.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    state.px = readPixels(gl, w, h, state.px);
    const cells = cellsFromPixels(state.px, cols, rows, state.cells);
    state.cells = cells;
    return drawTextCells(ctx, state, { cols, rows, ...cells, p, cr, dark, title: 'raymarch' });
  },

  toText(state, format, opts) {
    if (!state?.grid) return '';
    return gridToText(state.grid, format, { title: `${config.productName} raymarch`, ...opts });
  },

  dispose(state) {
    // after a context loss the objects are already gone; deleting them is a no-op
    const gl = state?.gl;
    if (gl && state.P) {
      gl.deleteProgram(state.P.prog);
      gl.deleteVertexArray(state.vao);
      if (state.tex) gl.deleteTexture(state.tex);
    }
  },
};

export default MODE;
