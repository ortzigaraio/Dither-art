// WebGL2 helpers for the GPU modes (PLAN.md 2, 18.2): feature probe, programs, buffers, textures, framebuffers,
// read-back, and an instanced thick-line renderer (core WebGL clamps gl.lineWidth to 1 px on most platforms).
//
// The pipeline owns the WebGL2 canvas (`mode.surface = 'gl'`) and rebuilds every GL mode's state after
// `webglcontextrestored`; modes keep their GL objects in their state and free them in dispose().

let probe = null;

/** True when this browser can create a WebGL2 context (probed once, the probe context is released). */
export function hasWebGL2() {
  if (probe !== null) return probe;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const gl = c.getContext('webgl2');
    probe = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    probe = false;
  }
  return probe;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

/**
 * Link a program and look up its uniforms.
 * @returns {{ prog: WebGLProgram, u: Record<string, WebGLUniformLocation>, a: Record<string, number> }}
 */
export function createProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`program link failed: ${log}`);
  }
  const u = {};
  const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(prog, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, info.name);
  }
  const a = {};
  const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES) || 0;
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(prog, i);
    a[info.name] = gl.getAttribLocation(prog, info.name);
  }
  return { prog, u, a };
}

/** A texture from pixels (or empty). `data` may be a canvas / ImageData / typed array. */
export function createTexture(gl, { width, height, data = null, internalFormat, format, type, filter, wrap } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const ifmt = internalFormat ?? gl.RGBA8;
  const fmt = format ?? gl.RGBA;
  const typ = type ?? gl.UNSIGNED_BYTE;
  if (data && !ArrayBuffer.isView(data)) gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, fmt, typ, data);
  else gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, width, height, 0, fmt, typ, data);
  const f = filter ?? gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap ?? gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap ?? gl.CLAMP_TO_EDGE);
  return tex;
}

/** Colour (RGBA8) + depth framebuffer of a fixed size. */
export function createTarget(gl, width, height, { depth = true } = {}) {
  const tex = createTexture(gl, { width, height, filter: gl.NEAREST });
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let rb = null;
  if (depth) {
    rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    fbo, tex, rb, width, height,
    dispose() {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      if (rb) gl.deleteRenderbuffer(rb);
    },
  };
}

/** A target of the requested size, recreated only when the size changes. */
export function ensureTarget(gl, holder, key, width, height, opts) {
  const t = holder[key];
  if (t && t.width === width && t.height === height) return t;
  t?.dispose();
  holder[key] = createTarget(gl, width, height, opts);
  return holder[key];
}

/** Read RGBA8 pixels of the bound framebuffer (bottom-up rows, as GL stores them). */
export function readPixels(gl, width, height, into = null) {
  const out = into && into.length === width * height * 4 ? into : new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

/** Set the drawing size of the GL canvas (and the viewport). */
export function sizeCanvas(gl, canvas, width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  return { w, h };
}

/** '#rrggbb' -> [r, g, b] in 0..1. */
export function rgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Full-screen triangle (no buffers: gl_VertexID)
export const FULLSCREEN_VS = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Turbo colour map (Google, 2019), polynomial approximation by Ruofei Du. Mirrored in JS by turbo() below.
export const GLSL_TURBO = `
vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec4 kR4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(dot(v4, kR4) + dot(v2, kR2), dot(v4, kG4) + dot(v2, kG2), dot(v4, kB4) + dot(v2, kB2)), 0.0, 1.0);
}`;

/** Turbo colour map in JS (same polynomial as GLSL_TURBO). Returns [r, g, b] 0..1. */
export function turbo(x) {
  x = Math.max(0, Math.min(1, x));
  const x2 = x * x;
  const x3 = x2 * x;
  const x4 = x2 * x2;
  const x5 = x4 * x;
  const c = (k4, k2) => Math.max(0, Math.min(1, k4[0] + k4[1] * x + k4[2] * x2 + k4[3] * x3 + k2[0] * x4 + k2[1] * x5));
  return [
    c([0.13572138, 4.61539260, -42.66032258, 132.13108234], [-152.94239396, 59.28637943]),
    c([0.09140261, 2.19418839, 4.84296658, -14.18503333], [4.27729857, 2.82956604]),
    c([0.10667330, 12.64194608, -60.58204836, 110.36276771], [-89.90310912, 27.34824973]),
  ];
}

// ---------------------------------------------------------------------------
// Thick lines: one instance per segment, a quad expanded in screen space by the vertex shader
// ---------------------------------------------------------------------------

const LINE_VS = `#version 300 es
in vec2 a_corner;      // x: 0 at p0, 1 at p1; y: -1 / +1 side
in vec3 a_p0;
in vec3 a_p1;
in vec2 a_along;       // distance along the polyline at p0 and p1 (for dashes)
uniform mat4 u_viewProj;
uniform vec2 u_res;    // viewport in px
uniform float u_width; // px
out float v_along;
void main() {
  vec4 c0 = u_viewProj * vec4(a_p0, 1.0);
  vec4 c1 = u_viewProj * vec4(a_p1, 1.0);
  if (c0.w <= 1e-5 || c1.w <= 1e-5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 s0 = c0.xy / c0.w * u_res * 0.5;
  vec2 s1 = c1.xy / c1.w * u_res * 0.5;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  vec4 c = mix(c0, c1, a_corner.x);
  float hw = u_width * 0.5;
  vec2 off = n * a_corner.y * hw + dir * (a_corner.x * 2.0 - 1.0) * hw * 0.5;
  c.xy += off / (u_res * 0.5) * c.w;
  gl_Position = c;
  v_along = mix(a_along.x, a_along.y, a_corner.x);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in float v_along;
uniform vec4 u_color;
uniform float u_dash;   // dash period in world units, 0 = solid
out vec4 o;
void main() {
  if (u_dash > 0.0 && fract(v_along / u_dash) > 0.5) discard;
  o = u_color;
}`;

/**
 * Instanced segment renderer. `setSegments(data, count)` takes Float32Array [x0 y0 z0 x1 y1 z1 a0 a1] per segment.
 */
export function createLineRenderer(gl) {
  const P = createProgram(gl, LINE_VS, LINE_FS);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const corner = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(P.a.a_corner);
  gl.vertexAttribPointer(P.a.a_corner, 2, gl.FLOAT, false, 0, 0);
  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  const stride = 8 * 4;
  const attr = (name, size, offset) => {
    const loc = P.a[name];
    if (loc === undefined || loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(loc, 1);
  };
  attr('a_p0', 3, 0);
  attr('a_p1', 3, 12);
  attr('a_along', 2, 24);
  gl.bindVertexArray(null);
  let count = 0;
  return {
    setSegments(data, n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      count = n;
    },
    get count() { return count; },
    draw({ viewProj, width, height, lineWidth = 1, color = [1, 1, 1, 1], dash = 0 }) {
      if (!count) return;
      gl.useProgram(P.prog);
      gl.uniformMatrix4fv(P.u.u_viewProj, false, viewProj);
      gl.uniform2f(P.u.u_res, width, height);
      gl.uniform1f(P.u.u_width, lineWidth);
      gl.uniform4f(P.u.u_color, color[0], color[1], color[2], color[3] ?? 1);
      gl.uniform1f(P.u.u_dash, dash);
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.deleteBuffer(corner);
      gl.deleteBuffer(inst);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(P.prog);
    },
  };
}
