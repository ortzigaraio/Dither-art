// Small 3D math kit (PLAN.md 7 3D): vec3 helpers, column-major mat4 (the layout WebGL expects), perspective and
// orthographic projections, lookAt, point projection to screen pixels and the orbit camera shared by the 3D modes.
// No DOM: the same code runs on the CPU (SVG visibility, PLY, tests) and feeds the shaders.

export const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// vec3
// ---------------------------------------------------------------------------

export const vec3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

// ---------------------------------------------------------------------------
// mat4 (column-major: element (row r, column c) lives at m[c * 4 + r])
// ---------------------------------------------------------------------------

export function identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** out = a * b (apply b first, then a). */
export function multiply(a, b, out = new Float32Array(16)) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
    }
  }
  for (let i = 0; i < 16; i++) out[i] = r[i];
  return out;
}

/** OpenGL-style perspective: fovy in radians, maps eye-space z in [-near, -far] to NDC [-1, 1]. */
export function perspective(fovy, aspect, near, far, out = new Float32Array(16)) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function ortho(left, right, bottom, top, near, far, out = new Float32Array(16)) {
  out.fill(0);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = -2 / (far - near);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = -(far + near) / (far - near);
  out[15] = 1;
  return out;
}

/** View matrix looking from `eye` at `center` (right-handed, the camera looks down its -z). */
export function lookAt(eye, center, up = [0, 1, 0], out = new Float32Array(16)) {
  let z = vec3.sub(eye, center);
  if (vec3.length(z) < 1e-12) z = [0, 0, 1];
  z = vec3.normalize(z);
  let x = vec3.cross(up, z);
  if (vec3.length(x) < 1e-9) x = vec3.cross([0, 0, z[1] > 0 ? -1 : 1], z); // looking straight up/down
  x = vec3.normalize(x);
  const y = vec3.cross(z, x);
  out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
  out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
  out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
  out[12] = -vec3.dot(x, eye);
  out[13] = -vec3.dot(y, eye);
  out[14] = -vec3.dot(z, eye);
  out[15] = 1;
  return out;
}

/** General 4x4 inverse (cofactors). Returns null when singular. */
export function invert(m, out = new Float32Array(16)) {
  const a = m;
  const b00 = a[0] * a[5] - a[1] * a[4];
  const b01 = a[0] * a[6] - a[2] * a[4];
  const b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5];
  const b04 = a[1] * a[7] - a[3] * a[5];
  const b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12];
  const b07 = a[8] * a[14] - a[10] * a[12];
  const b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13];
  const b10 = a[9] * a[15] - a[11] * a[13];
  const b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
  out[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  out[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
  out[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  out[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
  out[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  out[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
  out[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  out[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
  out[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  out[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
  out[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  out[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
  out[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  out[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
  out[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return out;
}

/** m * [x, y, z, 1] -> [x, y, z, w] (clip space for a view-projection matrix). */
export function transform4(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/**
 * Project a world point to screen pixels of a W x H viewport (y down, like canvas and SVG).
 * Returns { x, y, z (NDC depth -1..1), w, inFront }.
 */
export function project(viewProj, p, W, H) {
  const c = transform4(viewProj, p[0], p[1], p[2]);
  const inFront = c[3] > 1e-9;
  const iw = inFront ? 1 / c[3] : 0;
  return {
    x: (c[0] * iw * 0.5 + 0.5) * W,
    y: (0.5 - c[1] * iw * 0.5) * H,
    z: c[2] * iw,
    w: c[3],
    inFront,
  };
}

// ---------------------------------------------------------------------------
// Orbit camera
// ---------------------------------------------------------------------------

export const PITCH_LIMIT = 89;

/**
 * Orbit camera from the shared camera parameters (yaw, pitch, distance, fov, autoRotate, panX, panY).
 * yaw = 0 puts the eye on +z looking towards -z; pitch > 0 raises the eye; auto-rotation adds autoRotate deg/s of
 * yaw at `time` (the frame time, so video exports are deterministic). The orthographic variants frame the same
 * height as the perspective view at the target distance.
 *
 * @param {object} p   { yaw, pitch, distance, fov, autoRotate?, panX?, panY? } in degrees and world units
 * @param {object} [o]
 * @param {number} [o.time=0]
 * @param {number} [o.aspect=1]   viewport width / height
 * @param {'perspective'|'ortho'} [o.projection='perspective']
 * @param {number[]} [o.target=[0,0,0]]
 * @param {number} [o.near] [o.far]
 */
export function orbitCamera(p, o = {}) {
  const time = o.time || 0;
  const aspect = o.aspect || 1;
  const yawDeg = (p.yaw || 0) + (p.autoRotate || 0) * time;
  const pitchDeg = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p.pitch || 0));
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const dist = Math.max(0.05, p.distance || 3);
  const fov = Math.max(5, Math.min(120, p.fov || 45)) * DEG;
  const base = o.target || [0, 0, 0];

  const fwd = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)]; // target -> eye
  const right = vec3.normalize(vec3.cross([0, 1, 0], fwd));
  const up = vec3.cross(fwd, right);
  // pan moves the target in the camera plane (screen right / up), proportionally to the framed size
  const panK = dist * Math.tan(fov / 2);
  const target = vec3.add(base, vec3.add(vec3.scale(right, (p.panX || 0) * panK), vec3.scale(up, (p.panY || 0) * panK)));
  const eye = vec3.add(target, vec3.scale(fwd, dist));

  const view = lookAt(eye, target, [0, 1, 0]);
  const near = o.near ?? Math.max(0.01, dist * 0.02);
  const far = o.far ?? dist + 20;
  let proj;
  if (o.projection === 'ortho') {
    const h = dist * Math.tan(fov / 2);
    proj = ortho(-h * aspect, h * aspect, -h, h, o.near ?? -50, o.far ?? 50 + dist);
  } else {
    proj = perspective(fov, aspect, near, far);
  }
  const viewProj = multiply(proj, view);
  return { eye, target, view, proj, viewProj, yaw: yawDeg, pitch: pitchDeg, distance: dist, fov: fov / DEG, right, up, forward: vec3.scale(fwd, -1) };
}

/** Clamp camera parameters the way the interaction does (pitch within ±89°, distance within [min, max]). */
export function clampCamera(p, { minDistance = 0.5, maxDistance = 20 } = {}) {
  return {
    ...p,
    pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p.pitch)),
    distance: Math.max(minDistance, Math.min(maxDistance, p.distance)),
  };
}
