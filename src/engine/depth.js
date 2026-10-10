// Depth (PLAN.md 5.5): brightness-as-depth by default (luma, optional blur and invert), and an optional AI source,
// Depth Anything V2 small running in src/workers/depth.worker.js, loaded only after the user asks for it.
//
// Conventions: a depth field is a Float32Array of the work size (W x H), 0..1, where 1 = near / high.
//
// Caching: the result is cached per analysed frame (the pipeline's Analysis is reset whenever the source frame, the
// preprocessing or the work size changes) and per depth setting. AI results are also kept in a small LRU keyed by
// (source version, frame, size), so the export pipeline reuses what the preview computed for a still picture.
//
// AI scheduling: a still picture in the preview renders with brightness until the model answers, then re-renders
// (ctx.invalidate). A video preview runs the model at most every `everyN` frames and blends from the previous AI
// field to the newest one over the following frames. Exports always wait for the model on every frame.
//
// Everything that touches the network is injectable for tests (configureDepthAI): the worker URL and the library URL
// the worker imports (both must be same-origin; the worker's default library is the pinned jsDelivr build).

import { boxBlur } from './analysis.js';
import { LIMITS } from '../config.js';

export const AI_SIZE_LABEL = '≈27–50 MB';

export const DEPTH_PARAMS = [
  {
    id: 'source', type: 'select', default: 'brightness',
    options: [
      { value: 'brightness', label: { es: 'Brillo', en: 'Brightness' } },
      { value: 'ai', label: { es: 'IA (Depth Anything V2)', en: 'AI (Depth Anything V2)' } },
    ],
    label: { es: 'Fuente de profundidad', en: 'Depth source' },
    help: {
      es: 'Brillo: lo claro está cerca. IA: un modelo estima la profundidad real de la escena (se descarga una vez, bajo demanda).',
      en: 'Brightness: light areas are near. AI: a model estimates the real depth of the scene (downloaded once, on demand).',
    },
  },
  {
    id: 'enhance', type: 'button', action: 'depthAI',
    label: { es: `Mejorar con IA (${AI_SIZE_LABEL})`, en: `Enhance with AI (${AI_SIZE_LABEL})` },
    showIf: (p) => p.source !== 'ai',
  },
  {
    id: 'invert', type: 'toggle', default: false,
    label: { es: 'Invertir profundidad', en: 'Invert depth' },
  },
  {
    id: 'smooth', type: 'range', min: 0, max: 10, step: 1, default: 0, unit: 'px',
    label: { es: 'Suavizado', en: 'Smoothing' },
    help: { es: 'Desenfoca la profundidad para suavizar el relieve.', en: 'Blurs the depth to smooth the relief.' },
  },
  {
    id: 'everyN', type: 'range', min: 1, max: 30, step: 1, default: 6,
    label: { es: 'IA cada N fotogramas (video)', en: 'AI every N frames (video)' },
    help: {
      es: 'En la vista previa de un video la IA se ejecuta cada N fotogramas y se mezcla entre medias. La exportación la ejecuta en cada fotograma (más lenta).',
      en: 'In a video preview the AI runs every N frames and blends in between. Exports run it on every frame (slower).',
    },
    showIf: (p) => p.source === 'ai',
  },
];

const clampN = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

/** Depth settings with defaults (the pipeline may get `{}` from callers that do not use depth). */
export function depthSettings(p = {}) {
  return {
    source: p.source === 'ai' ? 'ai' : 'brightness',
    invert: !!p.invert,
    smooth: Math.round(clampN(p.smooth, 0, 10, 0)),
    everyN: Math.round(clampN(p.everyN, 1, 30, 6)),
  };
}

// ---------------------------------------------------------------------------
// AI worker client
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_URL = new URL('../workers/depth.worker.js', import.meta.url).href;
const cfg = { workerUrl: DEFAULT_WORKER_URL, libUrl: null, stallMs: LIMITS.depthStallMs, timeoutMs: LIMITS.depthLoadMs };

const ai = {
  status: 'idle', // idle | loading | ready | failed
  worker: null,
  load: null,
  progress: 0,
  device: '',
  error: '',
  seq: 0,
  jobs: new Map(), // jobId -> { resolve, reject }
  listeners: new Set(),
  stamp: 0, // bumps whenever a new AI field arrives (invalidates per-frame caches)
};

function sameOrigin(url) {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Inject the worker URL and/or the library URL the worker imports (tests, self-hosting). Same-origin only.
 * Resets a loaded or failed model so the next request starts over with the new configuration.
 */
export function configureDepthAI({ workerUrl, libUrl, stallMs, timeoutMs } = {}) {
  if (workerUrl !== undefined) cfg.workerUrl = workerUrl === null ? DEFAULT_WORKER_URL : (sameOrigin(workerUrl) || cfg.workerUrl);
  if (libUrl !== undefined) cfg.libUrl = libUrl === null ? null : sameOrigin(libUrl);
  const ms = (v, fallback) => (v === null ? fallback : Number.isFinite(v) && v > 0 ? v : undefined);
  if (stallMs !== undefined) cfg.stallMs = ms(stallMs, LIMITS.depthStallMs) ?? cfg.stallMs;
  if (timeoutMs !== undefined) cfg.timeoutMs = ms(timeoutMs, LIMITS.depthLoadMs) ?? cfg.timeoutMs;
  resetDepthAI();
}

const emit = () => ai.listeners.forEach((fn) => { try { fn(aiInfo()); } catch { /* listener errors are not ours */ } });
const aiInfo = () => ({ status: ai.status, progress: ai.progress, device: ai.device, error: ai.error });

export const depthAIStatus = () => ai.status;
export const depthAIInfo = aiInfo;
export function onDepthAI(fn) {
  ai.listeners.add(fn);
  return () => ai.listeners.delete(fn);
}

/** Drop the worker and every cached AI field (the next request loads again). */
export function resetDepthAI() {
  ai.worker?.terminate();
  ai.worker = null;
  ai.load = null;
  ai.status = 'idle';
  ai.progress = 0;
  ai.device = '';
  ai.error = '';
  for (const j of ai.jobs.values()) j.reject(new Error('depth worker reset'));
  ai.jobs.clear();
  aiCache.clear();
  inflight.clear();
  tracks.clear();
  ai.stamp++;
  emit();
}

function onWorkerMessage(e) {
  const m = e.data || {};
  if (m.type === 'progress') {
    ai.progress = clampN(m.progress, 0, 1, 0);
    emit();
  } else if (m.type === 'result' || (m.type === 'error' && m.jobId != null)) {
    const job = ai.jobs.get(m.jobId);
    if (!job) return; // cancelled
    ai.jobs.delete(m.jobId);
    if (m.type === 'result') job.resolve({ depth: new Float32Array(m.depth), width: m.width, height: m.height });
    else job.reject(new Error(m.message || 'depth inference failed'));
  }
}

/**
 * Load the model (idempotent). Resolves when ready; rejects (status 'failed') when the worker, the library or the
 * model cannot be loaded. Progress (0..1) is reported through onDepthAI listeners and `onProgress`.
 */
export function loadDepthAI({ onProgress } = {}) {
  if (ai.status === 'ready') return Promise.resolve(aiInfo());
  if (ai.load) {
    if (onProgress) {
      const off = onDepthAI((i) => onProgress(i.progress));
      ai.load.finally(off).catch(() => {});
    }
    return ai.load;
  }
  ai.status = 'loading';
  ai.progress = 0;
  ai.error = '';
  emit();
  const off = onProgress ? onDepthAI((i) => onProgress(i.progress)) : null;
  ai.load = new Promise((resolve, reject) => {
    let worker;
    // Time limits (PENDIENTE: a stalled CDN or Hugging Face download must not leave the studio waiting forever):
    // no progress for cfg.stallMs, or cfg.timeoutMs in total, gives up with 'timeout' (the caller falls back to
    // brightness).
    let stallTimer = 0;
    const totalTimer = setTimeout(() => fail('timeout'), cfg.timeoutMs);
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => fail('timeout'), cfg.stallMs);
    };
    const stopTimers = () => { clearTimeout(stallTimer); clearTimeout(totalTimer); };
    const fail = (msg) => {
      stopTimers();
      if (ai.worker !== worker && ai.status !== 'loading') return; // already settled or reset
      worker?.terminate();
      if (ai.worker === worker) ai.worker = null;
      ai.status = 'failed';
      ai.error = String(msg || 'failed');
      ai.load = null;
      emit();
      reject(new Error(ai.error));
    };
    try {
      worker = new Worker(cfg.workerUrl, { type: 'module', name: 'dither-depth' });
    } catch (err) {
      fail(err?.message || 'worker could not start');
      return;
    }
    ai.worker = worker;
    armStall();
    worker.addEventListener('error', (ev) => { ev.preventDefault?.(); if (ai.status === 'loading') fail(ev.message || 'worker error'); });
    worker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (ai.status === 'loading' && m.type === 'progress') armStall(); // still downloading
      if (ai.status === 'loading' && m.type === 'ready') {
        stopTimers();
        ai.status = 'ready';
        ai.progress = 1;
        ai.device = String(m.device || '');
        emit();
        resolve(aiInfo());
      } else if (ai.status === 'loading' && m.type === 'error' && m.jobId == null) {
        fail(m.message);
      } else {
        onWorkerMessage(e);
      }
    });
    const msg = { type: 'load' };
    if (cfg.libUrl) msg.libUrl = cfg.libUrl;
    worker.postMessage(msg);
  });
  ai.load.finally(() => off?.()).catch(() => {});
  return ai.load;
}

/** Run the model on an RGBA picture. Resolves { depth: Float32Array 0..1 (near = 1), width, height }. */
export function estimateDepthAI(rgba, width, height, { signal } = {}) {
  if (ai.status !== 'ready' || !ai.worker) return Promise.reject(new Error('depth model not loaded'));
  const jobId = ++ai.seq;
  const copy = new Uint8ClampedArray(rgba); // the caller keeps its buffer
  return new Promise((resolve, reject) => {
    ai.jobs.set(jobId, { resolve, reject });
    if (signal) {
      const abort = () => {
        if (!ai.jobs.has(jobId)) return;
        ai.jobs.delete(jobId);
        ai.worker?.postMessage({ type: 'cancel', jobId });
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
    }
    ai.worker.postMessage({ type: 'run', jobId, width, height, rgba: copy.buffer }, [copy.buffer]);
  });
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** Bilinear resample of a w x h field to W x H. */
export function resampleField(src, w, h, W, H) {
  if (w === W && h === H) return src;
  const out = new Float32Array(W * H);
  const kx = w / W;
  const ky = h / H;
  for (let y = 0; y < H; y++) {
    let fy = (y + 0.5) * ky - 0.5;
    fy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
    const y0 = fy | 0;
    const y1 = y0 + 1 < h ? y0 + 1 : y0;
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      let fx = (x + 0.5) * kx - 0.5;
      fx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
      const x0 = fx | 0;
      const x1 = x0 + 1 < w ? x0 + 1 : x0;
      const tx = fx - x0;
      const a = src[y0 * w + x0] + (src[y0 * w + x1] - src[y0 * w + x0]) * tx;
      const b = src[y1 * w + x0] + (src[y1 * w + x1] - src[y1 * w + x0]) * tx;
      out[y * W + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** Min-max normalise a raw model output to 0..1 (in place when `into` is the source). */
export function normalizeField(src, into = new Float32Array(src.length)) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo > 1e-12 ? hi - lo : 1;
  for (let i = 0; i < src.length; i++) into[i] = Number.isFinite(src[i]) ? (src[i] - lo) / span : 0;
  return into;
}

const aiCache = new Map(); // `${version}|${frame}|${W}x${H}` -> Float32Array (W x H)
const inflight = new Map(); // same key -> Promise
const tracks = new Map(); // source version -> { frames, lastRun, prev, cur, arrivedFrame, busy }
const AI_CACHE_MAX = 6;
const stats = { aiRuns: 0, brightnessBuilds: 0 };
/** Counters for tests and diagnostics. */
export const depthStats = () => ({ ...stats, aiStamp: ai.stamp });

function remember(key, field) {
  aiCache.delete(key);
  aiCache.set(key, field);
  while (aiCache.size > AI_CACHE_MAX) aiCache.delete(aiCache.keys().next().value);
}

async function inferInto(key, analysis) {
  const W = analysis.width;
  const H = analysis.height;
  const rgba = analysis.rgba();
  stats.aiRuns++;
  const r = await estimateDepthAI(rgba, W, H);
  const field = resampleField(normalizeField(r.depth, r.depth), r.width, r.height, W, H);
  remember(key, field);
  ai.stamp++;
  return field;
}

function startInference(key, analysis, onDone) {
  if (inflight.has(key)) return inflight.get(key);
  const p = inferInto(key, analysis)
    .then((f) => { onDone?.(f); return f; })
    .catch(() => null) // the brightness field stays in use
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The AI field for this frame, or null when it is not available (yet). */
async function aiField({ analysis, source, frameKey, isExport, isVideo, everyN, invalidate }) {
  if (ai.status !== 'ready') return null;
  const W = analysis.width;
  const H = analysis.height;
  const version = source?.version ?? 0;
  const key = `${version}|${frameKey}|${W}x${H}`;
  const hit = aiCache.get(key);
  if (hit) return hit;
  if (isExport) return inferInto(key, analysis).catch(() => null);

  if (!isVideo) {
    startInference(key, analysis, () => invalidate?.());
    return null;
  }

  // video preview: the model runs every `everyN` frames; in between, blend from the previous field to the newest
  let tr = tracks.get(version);
  if (!tr) {
    if (tracks.size > 4) tracks.clear();
    tr = { frames: 0, lastRun: -Infinity, prev: null, cur: null, arrivedFrame: 0, lastKey: '' };
    tracks.set(version, tr);
  }
  if (tr.lastKey !== String(frameKey)) { tr.lastKey = String(frameKey); tr.frames++; }
  if (tr.frames - tr.lastRun >= everyN && !inflight.size) {
    tr.lastRun = tr.frames;
    startInference(key, analysis, (f) => {
      tr.prev = tr.cur;
      tr.cur = { field: f, w: W, h: H };
      tr.arrivedFrame = tr.frames;
      invalidate?.();
    });
  }
  if (!tr.cur) return null;
  const cur = resampleField(tr.cur.field, tr.cur.w, tr.cur.h, W, H);
  if (!tr.prev) return cur;
  const k = Math.min(1, (tr.frames - tr.arrivedFrame + 1) / everyN);
  if (k >= 1) return cur;
  const prev = resampleField(tr.prev.field, tr.prev.w, tr.prev.h, W, H);
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = prev[i] + (cur[i] - prev[i]) * k;
  return out;
}

/**
 * Depth field of the analysed frame (W x H, 0..1, near = 1), cached per frame and setting.
 * @param {object} a
 * @param {import('./analysis.js').Analysis} a.analysis
 * @param {object} a.params      the depth group values (may be {})
 * @param {object} [a.source]    the pipeline source (version, kind)
 * @param {string|number} [a.frameKey]
 * @param {boolean} [a.isExport]
 * @param {boolean} [a.isVideo]
 * @param {() => void} [a.invalidate]  re-render request (the preview's)
 * @param {object} [a.opts]      overrides of the settings ({ invert, smooth, source })
 */
export async function depthField({ analysis, params, source, frameKey = 0, isExport = false, isVideo = false, invalidate, opts = {} }) {
  const p = depthSettings({ ...params, ...opts });
  let base = null;
  let from = 'brightness';
  if (p.source === 'ai') {
    base = await aiField({ analysis, source, frameKey, isExport, isVideo, everyN: p.everyN, invalidate });
    if (base) from = 'ai';
  }
  const key = `${from}|${from === 'ai' ? ai.stamp : 0}|${p.invert}|${p.smooth}`;
  if (analysis._depthKey === key && analysis._depth) return analysis._depth;
  if (!base) { base = analysis.luma(); stats.brightnessBuilds++; }
  const W = analysis.width;
  const H = analysis.height;
  let d = p.smooth > 0 ? boxBlur(base, W, H, p.smooth) : Float32Array.from(base);
  if (p.invert) for (let i = 0; i < d.length; i++) d[i] = 1 - d[i];
  d.source = from; // which source produced this field (for tests and the stats line)
  analysis._depth = d;
  analysis._depthKey = key;
  return d;
}
