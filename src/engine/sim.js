// GPU simulations for the SIMULATION mode (PLAN.md 7.25): Gray-Scott reaction-diffusion and Life-like cellular
// automata, both stepped on WebGL2 with ping-pong framebuffers, plus their CPU-side seeds and the B/S rule parser.
//
// Reaction-diffusion state is (U, V) per cell. It lives in an RG float texture when the context can render to one
// (EXT_color_buffer_float -> RG32F; EXT_color_buffer_half_float or the float extension -> RG16F) and otherwise in a
// plain RGBA8 texture with both values packed as 16-bit fixed point (U in RG, V in BA). Every tier is probed with a
// real framebuffer-completeness check, so a driver that advertises an extension but cannot attach the format falls
// through to the next one. The automaton always uses RGBA8 (R = alive, G = fading trail).
//
// Everything here is deterministic: the same seed, parameters, image and number of steps give the same state.

import { rng, mixSeed } from './rand.js';
import { quantize } from './dither.js';

// ---------------------------------------------------------------------------
// Life-like rules: strict "B<digits>/S<digits>" parser
// ---------------------------------------------------------------------------

export const NAMED_RULES = {
  life: 'B3/S23',
  highlife: 'B36/S23',
  daynight: 'B3678/S34678',
  seeds: 'B2/S',
};

const RULE_RE = /^[Bb]([0-8]*)\/[Ss]([0-8]*)$/;
const MAX_RULE_CHARS = 24;

/**
 * Parse a Life-like rule in B/S notation ("B3/S23", "b36/s23", "B2/S"). Strict: ASCII digits 0–8 only, each digit at
 * most once per side, birth first, nothing else but surrounding spaces, at least one digit in total.
 * @returns {{ birth: number[], survive: number[], bMask: number, sMask: number, text: string } | null}
 */
export function parseRule(input) {
  if (typeof input !== 'string' || input.length > MAX_RULE_CHARS) return null;
  const s = input.replace(/^[ \t]+|[ \t]+$/g, '');
  const m = RULE_RE.exec(s);
  if (!m) return null;
  const side = (digits) => {
    const out = [];
    for (const ch of digits) {
      const d = ch.charCodeAt(0) - 48;
      if (out.includes(d)) return null;
      out.push(d);
    }
    return out.sort((a, b) => a - b);
  };
  const birth = side(m[1]);
  const survive = side(m[2]);
  if (!birth || !survive || birth.length + survive.length === 0) return null;
  const mask = (list) => list.reduce((acc, d) => acc | (1 << d), 0);
  return { birth, survive, bMask: mask(birth), sMask: mask(survive), text: `B${birth.join('')}/S${survive.join('')}` };
}

/** One generation of a Life-like rule on the CPU (dead cells outside the grid). Reference for the GPU shader. */
export function lifeStepCPU(cells, w, h, rule) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && cells[yy * w + xx]) n++;
        }
      }
      const alive = !!cells[y * w + x];
      out[y * w + x] = (alive ? (rule.sMask >> n) & 1 : (rule.bMask >> n) & 1) ? 1 : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Texture formats
// ---------------------------------------------------------------------------

let disabledExts = new Set();

/** Test hook: pretend these WebGL extensions are missing (null = back to normal). Forces the fallback path. */
export function setDisabledExtensions(list) {
  disabledExts = new Set(Array.isArray(list) ? list : []);
}

const ext = (gl, name) => (disabledExts.has(name) ? null : gl.getExtension(name));

/** True when a w x h texture of this format can be a complete colour attachment. */
function renderable(gl, internalFormat, format, type) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  // a texImage2D with an unsupported combination raises INVALID_* on some drivers: clear it so it is not reported later
  while (gl.getError() !== gl.NO_ERROR && !gl.isContextLost()) { /* drain */ }
  return ok;
}

/**
 * Best state format for reaction-diffusion on this context: 'rg32f' -> 'rg16f' -> 'rgba8' (packed).
 * @returns {{ id: 'rg32f'|'rg16f'|'rgba8', internalFormat: number, format: number, type: number, packed: boolean }}
 */
export function pickSimFormat(gl) {
  const hasFloat = !!ext(gl, 'EXT_color_buffer_float');
  if (hasFloat && renderable(gl, gl.RG32F, gl.RG, gl.FLOAT)) {
    return { id: 'rg32f', internalFormat: gl.RG32F, format: gl.RG, type: gl.FLOAT, packed: false };
  }
  const hasHalf = !!ext(gl, 'EXT_color_buffer_half_float') || hasFloat;
  if (hasHalf && renderable(gl, gl.RG16F, gl.RG, gl.HALF_FLOAT)) {
    return { id: 'rg16f', internalFormat: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT, packed: false };
  }
  return { id: 'rgba8', internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, packed: true };
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const QUAD_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// (U, V) codec: float textures keep the values, RGBA8 packs each one as 16-bit fixed point
export const GLSL_CODEC = (packed) => (packed ? `
vec2 dec(vec4 c) { vec4 b = floor(c * 255.0 + 0.5); return vec2(b.r * 256.0 + b.g, b.b * 256.0 + b.a) / 65535.0; }
vec4 enc(vec2 v) {
  vec2 x = floor(clamp(v, 0.0, 1.0) * 65535.0 + 0.5);
  vec2 hi = floor(x / 256.0);
  vec2 lo = x - hi * 256.0;
  return vec4(hi.x, lo.x, hi.y, lo.y) / 255.0;
}` : `
vec2 dec(vec4 c) { return c.rg; }
vec4 enc(vec2 v) { return vec4(clamp(v, 0.0, 1.0), 0.0, 1.0); }`);

// Gray-Scott, explicit Euler with dt = 1 and the 3x3 Laplacian of Karl Sims (centre -1, sides .2, corners .05);
// zero-flux borders (clamped reads). f and k are interpolated by the picture's luma: f = mix(fA, fB, t).
const RD_FS = (packed) => `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_state;
uniform highp sampler2D u_luma;
uniform vec2 u_f;      // fA, fB
uniform vec2 u_k;      // kA, kB
uniform vec2 u_D;      // Du, Dv
uniform float u_infl;  // image influence 0..1
out vec4 o;
${GLSL_CODEC(packed)}
ivec2 mx;
vec2 at(ivec2 p) { return dec(texelFetch(u_state, clamp(p, ivec2(0), mx), 0)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  mx = textureSize(u_state, 0) - 1;
  vec2 c = at(p);
  vec2 lap = -c
    + 0.2 * (at(p + ivec2(1, 0)) + at(p + ivec2(-1, 0)) + at(p + ivec2(0, 1)) + at(p + ivec2(0, -1)))
    + 0.05 * (at(p + ivec2(1, 1)) + at(p + ivec2(-1, 1)) + at(p + ivec2(1, -1)) + at(p + ivec2(-1, -1)));
  float t = mix(0.5, texelFetch(u_luma, p, 0).r, u_infl);
  float f = mix(u_f.x, u_f.y, t);
  float k = mix(u_k.x, u_k.y, t);
  float uvv = c.x * c.y * c.y;
  o = enc(c + vec2(u_D.x * lap.x - uvv + f * (1.0 - c.x), u_D.y * lap.y + uvv - (f + k) * c.y));
}`;

// Life-like automaton: R = alive, G = trail (1 while alive, then multiplied by u_decay each generation).
// imageLock: each generation a cell is re-seeded from the dithered picture with probability u_lock (integer hash
// of cell, generation and seed, so it is the same on every run).
const CA_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_state;
uniform highp sampler2D u_img;   // dithered picture, R > 0.5 = alive
uniform int u_birth;
uniform int u_survive;
uniform float u_lock;
uniform uint u_gen;
uniform uint u_seed;
uniform float u_decay;
out vec4 o;
ivec2 mx;
int alive(ivec2 q) {
  if (q.x < 0 || q.y < 0 || q.x > mx.x || q.y > mx.y) return 0;
  return texelFetch(u_state, q, 0).r > 0.5 ? 1 : 0;
}
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  mx = textureSize(u_state, 0) - 1;
  vec4 cur = texelFetch(u_state, p, 0);
  int n = alive(p + ivec2(-1, -1)) + alive(p + ivec2(0, -1)) + alive(p + ivec2(1, -1))
        + alive(p + ivec2(-1, 0)) + alive(p + ivec2(1, 0))
        + alive(p + ivec2(-1, 1)) + alive(p + ivec2(0, 1)) + alive(p + ivec2(1, 1));
  bool a = cur.r > 0.5;
  bool nx = a ? ((u_survive >> n) & 1) == 1 : ((u_birth >> n) & 1) == 1;
  if (u_lock > 0.0) {
    uint h = pcg(uint(p.x) ^ pcg(uint(p.y) ^ pcg(u_gen ^ pcg(u_seed))));
    if (float(h & 0xFFFFFFu) / 16777216.0 < u_lock) nx = texelFetch(u_img, p, 0).r > 0.5;
  }
  o = vec4(nx ? 1.0 : 0.0, nx ? 1.0 : cur.g * u_decay, 0.0, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`sim shader compile failed: ${log}`);
  }
  return sh;
}

/** Program + uniform locations (the gl.js helper, without the attribute table: these passes have no attributes). */
export function simProgram(gl, fs) {
  const prog = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, QUAD_VS);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`sim program link failed: ${log}`);
  }
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    u[info.name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u };
}

// ---------------------------------------------------------------------------
// Ping-pong state
// ---------------------------------------------------------------------------

function stateTexture(gl, w, h, fmt, data) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, w, h, 0, fmt.format, fmt.uploadType ?? fmt.type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function pingPong(gl, w, h, fmt) {
  const tex = [stateTexture(gl, w, h, fmt, null), stateTexture(gl, w, h, fmt, null)];
  const fbo = tex.map((t) => {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  let cur = 0;
  return {
    get texture() { return tex[cur]; },
    get fbo() { return fbo[cur]; },
    upload(data) {
      gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, fmt.format, fmt.uploadType ?? fmt.type, data);
    },
    /** Run `n` passes of `prog` (already in use), reading the current texture on unit 0 and writing the other one. */
    run(n, perStep) {
      gl.viewport(0, 0, w, h);
      for (let i = 0; i < n; i++) {
        perStep?.(i);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - cur]);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex[cur]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        cur = 1 - cur;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    dispose() {
      fbo.forEach((f) => gl.deleteFramebuffer(f));
      tex.forEach((t) => gl.deleteTexture(t));
    },
  };
}

/** An R8 texture from a 0..1 field or 0/1 mask (rows top-down, like every other texture here). */
export function fieldTexture(gl, w, h, values, prev = null) {
  const bytes = new Uint8Array(w * h);
  for (let i = 0; i < bytes.length; i++) {
    const v = values[i];
    bytes[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  const tex = prev || gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function resetGLState(gl) {
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.CULL_FACE);
  gl.colorMask(true, true, true, true);
}

/**
 * Gray-Scott reaction-diffusion on a w x h grid.
 * @param {WebGL2RenderingContext} gl
 * @param {object} [fmt] a format from pickSimFormat (probed when omitted)
 */
export function createReactionDiffusion(gl, w, h, fmt = pickSimFormat(gl)) {
  const format = { ...fmt, uploadType: fmt.packed ? gl.UNSIGNED_BYTE : gl.FLOAT };
  const P = simProgram(gl, RD_FS(format.packed));
  const vao = gl.createVertexArray();
  const pp = pingPong(gl, w, h, format);
  let luma = null;
  return {
    width: w,
    height: h,
    format: format.id,
    packed: format.packed,
    get texture() { return pp.texture; },
    get fbo() { return pp.fbo; },
    /** The picture that drives f / k (0..1 luma, top-down rows). */
    setLuma(values) { luma = fieldTexture(gl, w, h, values, luma); },
    /** Initial (U, V) pairs, Float32Array of 2·w·h. */
    upload(uv) {
      if (!format.packed) { pp.upload(uv); return; }
      const bytes = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 2; c++) {
          const v = Math.round(Math.min(1, Math.max(0, uv[i * 2 + c])) * 65535);
          bytes[i * 4 + c * 2] = v >> 8;
          bytes[i * 4 + c * 2 + 1] = v & 255;
        }
      }
      pp.upload(bytes);
    },
    /** `n` steps with { fA, fB, kA, kB, Du, Dv, influence }. */
    step(n, q) {
      if (n <= 0) return;
      if (!luma) luma = fieldTexture(gl, w, h, new Float32Array(w * h).fill(0.5));
      resetGLState(gl);
      gl.useProgram(P.prog);
      gl.bindVertexArray(vao);
      gl.uniform1i(P.u.u_state, 0);
      gl.uniform1i(P.u.u_luma, 1);
      gl.uniform2f(P.u.u_f, q.fA, q.fB);
      gl.uniform2f(P.u.u_k, q.kA, q.kB);
      gl.uniform2f(P.u.u_D, q.Du, q.Dv);
      gl.uniform1f(P.u.u_infl, q.influence);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, luma);
      pp.run(n);
      gl.bindVertexArray(null);
    },
    /** Current (U, V) as Float32Array of 2·w·h, rows top-down (texture row order). */
    read() {
      const out = new Float32Array(w * h * 2);
      gl.bindFramebuffer(gl.FRAMEBUFFER, pp.fbo);
      if (format.packed) {
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < w * h; i++) {
          out[i * 2] = (px[i * 4] * 256 + px[i * 4 + 1]) / 65535;
          out[i * 2 + 1] = (px[i * 4 + 2] * 256 + px[i * 4 + 3]) / 65535;
        }
      } else {
        const px = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
        for (let i = 0; i < w * h; i++) {
          out[i * 2] = px[i * 4];
          out[i * 2 + 1] = px[i * 4 + 1];
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    },
    dispose() {
      pp.dispose();
      if (luma) gl.deleteTexture(luma);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(P.prog);
    },
  };
}

/** Life-like automaton on a w x h grid (dead cells outside). */
export function createAutomaton(gl, w, h) {
  const fmt = { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  const P = simProgram(gl, CA_FS);
  const vao = gl.createVertexArray();
  const pp = pingPong(gl, w, h, fmt);
  let img = null;
  return {
    width: w,
    height: h,
    format: 'rgba8',
    get texture() { return pp.texture; },
    /** The dithered picture (0/1 mask) used by imageLock. */
    setImage(mask) { img = fieldTexture(gl, w, h, mask, img); },
    /** Alive cells (0/1 per cell, top-down rows); the trail starts at the alive state. */
    upload(cells) {
      const bytes = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = cells[i] ? 255 : 0;
        bytes[i * 4] = a;
        bytes[i * 4 + 1] = a;
        bytes[i * 4 + 3] = 255;
      }
      pp.upload(bytes);
    },
    /** `n` generations starting at absolute generation `gen0` with { bMask, sMask, lock, seed, decay }. */
    step(n, gen0, q) {
      if (n <= 0) return;
      if (!img) img = fieldTexture(gl, w, h, new Uint8Array(w * h));
      resetGLState(gl);
      gl.useProgram(P.prog);
      gl.bindVertexArray(vao);
      gl.uniform1i(P.u.u_state, 0);
      gl.uniform1i(P.u.u_img, 1);
      gl.uniform1i(P.u.u_birth, q.bMask);
      gl.uniform1i(P.u.u_survive, q.sMask);
      gl.uniform1f(P.u.u_lock, q.lock);
      gl.uniform1ui(P.u.u_seed, q.seed >>> 0);
      gl.uniform1f(P.u.u_decay, q.decay);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, img);
      pp.run(n, (i) => gl.uniform1ui(P.u.u_gen, (gen0 + i + 1) >>> 0));
      gl.bindVertexArray(null);
    },
    /** { alive: Uint8Array (0/1), trail: Float32Array 0..1 }, rows top-down. */
    read() {
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, pp.fbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const alive = new Uint8Array(w * h);
      const trail = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        alive[i] = px[i * 4] > 127 ? 1 : 0;
        trail[i] = px[i * 4 + 1] / 255;
      }
      return { alive, trail };
    },
    dispose() {
      pp.dispose();
      if (img) gl.deleteTexture(img);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(P.prog);
    },
  };
}

// ---------------------------------------------------------------------------
// Seeds (CPU, seeded PRNG)
// ---------------------------------------------------------------------------

/**
 * Initial Gray-Scott state: U = 1, V = 0 everywhere, plus small blobs (U = .5, V = .5 with a little noise).
 * @param {'edges'|'random'|'center'} type
 * @param {{ mag?: Float32Array }} [fields]  Sobel magnitude for 'edges'
 * @returns {Float32Array} 2·w·h (U, V)
 */
export function seedReactionDiffusion(w, h, type, seed, fields = {}) {
  const uv = new Float32Array(w * h * 2);
  for (let i = 0; i < w * h; i++) uv[i * 2] = 1;
  const r = rng(mixSeed(seed, 0x5eed));
  const blob = (cx, cy, rad) => {
    const R = Math.max(1, rad);
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(h - 1, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(w - 1, Math.ceil(cx + R)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
        const i = y * w + x;
        uv[i * 2] = 0.5 + (r() - 0.5) * 0.04;
        uv[i * 2 + 1] = 0.5 + (r() - 0.5) * 0.04;
      }
    }
  };
  const area = w * h;
  const rad = Math.max(1.5, Math.min(w, h) / 120);
  if (type === 'center') {
    const R = Math.min(w, h) * 0.07;
    blob(w / 2, h / 2, R);
    // a few satellites so the front is not perfectly round
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      blob(w / 2 + Math.cos(a) * R * 1.1, h / 2 + Math.sin(a) * R * 1.1, rad);
    }
  } else if (type === 'edges' && fields.mag) {
    const mag = fields.mag;
    let max = 0;
    for (let i = 0; i < area; i++) if (mag[i] > max) max = mag[i];
    const want = Math.max(8, Math.round(area / 260));
    let placed = 0;
    for (let tries = 0; tries < want * 40 && placed < want; tries++) {
      const x = Math.floor(r() * w);
      const y = Math.floor(r() * h);
      const m = max > 0 ? mag[y * w + x] / max : 0;
      if (m > 0.12 && r() < m) { blob(x, y, rad * 0.8); placed++; }
    }
    if (placed < want / 4) for (let i = placed; i < want / 4; i++) blob(r() * w, r() * h, rad); // flat picture: top up
  } else {
    const n = Math.max(6, Math.round(area / 900));
    for (let i = 0; i < n; i++) blob(r() * w, r() * h, rad * (0.7 + r() * 0.8));
  }
  return uv;
}

/**
 * Cellular-automaton seed and imageLock target: the picture dithered to 1 bit (alive = bright where the output is
 * light-on-dark, alive = dark otherwise). Random dithering uses the seed.
 */
export function ditherCells(luma, w, h, algorithm, seed, aliveIsBright = true) {
  const src = aliveIsBright ? luma : Float32Array.from(luma, (v) => 1 - v);
  const q = quantize(src, w, h, 2, algorithm, { serpentine: true, seed });
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = q[i] ? 1 : 0;
  return out;
}
