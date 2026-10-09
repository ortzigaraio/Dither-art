// Depth Anything V2 (small) in the browser with transformers.js (PLAN.md 5.5). Loaded only after the user confirms
// "Enhance with AI": this is the only place where code comes from a CDN (jsDelivr, pinned version), and the model
// weights come from Hugging Face. The user's picture never leaves the device: inference runs here.
//
// Protocol (module worker):
//   -> { type: 'load', libUrl? }                     libUrl: same-origin override of the library (tests, self-hosting)
//   <- { type: 'progress', progress: 0..1, loaded, total, file }   while downloading
//   <- { type: 'ready', device, dtype } | { type: 'error', message }
//   -> { type: 'run', jobId, width, height, rgba: ArrayBuffer }
//   <- { type: 'result', jobId, width, height, depth: ArrayBuffer (Float32, 0..1, near = 1) } | { type: 'error', jobId, message }
//   -> { type: 'cancel', jobId }   inference cannot be interrupted: the result of a cancelled job is dropped
//
// transformers.js 4.3.0 (checked against the npm package): pipeline(task, model, { device: 'webgpu'|'wasm',
// dtype: 'fp32'|'fp16'|'q8'|..., progress_callback }) and the depth-estimation result is
// { predicted_depth: Tensor (dims [H, W], float32, already interpolated to the input size), depth: RawImage (uint8) }.
// Depth Anything predicts relative inverse depth: larger = nearer, which is the convention of the app.

const LIB_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';
const MODEL = 'onnx-community/depth-anything-v2-small';

let lib = null;
let estimator = null;
let loading = null;
const cancelled = new Set();

function libFor(url) {
  if (!url) return LIB_URL;
  try {
    const u = new URL(url, self.location.href);
    if (u.origin === self.location.origin) return u.href; // only same-origin overrides
  } catch { /* fall through */ }
  throw new Error('library URL must be same-origin');
}

async function webgpuUsable() {
  try {
    if (!self.navigator?.gpu) return false;
    return !!(await self.navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function load(libUrl) {
  lib = await import(libFor(libUrl));
  if (lib.env) {
    lib.env.allowLocalModels = false; // models come from the hub (never from this site's paths)
  }
  const files = new Map();
  const progress_callback = (p) => {
    if (!p) return;
    if (p.status === 'progress_total' && Number.isFinite(p.progress)) {
      self.postMessage({ type: 'progress', progress: p.progress / 100, loaded: p.loaded || 0, total: p.total || 0, file: '' });
    } else if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      if (total > 0) self.postMessage({ type: 'progress', progress: loaded / total, loaded, total, file: String(p.file) });
    }
  };
  // WebGPU in fp16 when available (~50 MB), otherwise WASM with the 8-bit quantised weights (~27 MB)
  const attempts = (await webgpuUsable()) ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'wasm', dtype: 'q8' }] : [{ device: 'wasm', dtype: 'q8' }];
  let lastErr = null;
  for (const a of attempts) {
    try {
      estimator = await lib.pipeline('depth-estimation', MODEL, { ...a, progress_callback });
      return a;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('model could not be loaded');
}

/** predicted_depth (Tensor [H, W] or [1, H, W]) or the uint8 RawImage -> normalised Float32Array. */
function toField(out) {
  const res = Array.isArray(out) ? out[0] : out;
  const pd = res?.predicted_depth;
  let data;
  let w;
  let h;
  if (pd && pd.data && pd.dims) {
    const dims = pd.dims;
    h = dims[dims.length - 2];
    w = dims[dims.length - 1];
    data = pd.data;
  } else if (res?.depth?.data) {
    ({ width: w, height: h } = res.depth);
    data = res.depth.data;
  } else {
    throw new Error('unexpected depth-estimation output');
  }
  const n = w * h;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Number(data[i]);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo > 1e-12 ? hi - lo : 1;
  const field = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = Number(data[i]);
    field[i] = Number.isFinite(v) ? (v - lo) / span : 0;
  }
  return { field, w, h };
}

async function run({ jobId, width, height, rgba }) {
  const image = new lib.RawImage(new Uint8ClampedArray(rgba), width, height, 4);
  const out = await estimator(image);
  if (cancelled.delete(jobId)) return;
  const { field, w, h } = toField(out);
  self.postMessage({ type: 'result', jobId, width: w, height: h, depth: field.buffer }, [field.buffer]);
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    if (!loading) loading = load(m.libUrl);
    try {
      const a = await loading;
      self.postMessage({ type: 'ready', device: a.device, dtype: a.dtype });
    } catch (err) {
      loading = null;
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  } else if (m.type === 'run') {
    try {
      if (!estimator) throw new Error('model not loaded');
      await run(m);
    } catch (err) {
      if (!cancelled.delete(m.jobId)) self.postMessage({ type: 'error', jobId: m.jobId, message: String(err?.message || err) });
    }
  } else if (m.type === 'cancel') {
    if (cancelled.size > 256) cancelled.clear(); // ids of jobs that had already finished
    cancelled.add(m.jobId);
  }
};
