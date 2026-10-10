// Render pipeline (PLAN.md 5.1): source frame -> work canvas (W x H) -> preprocess -> analysis -> mode.render
// -> output surface (+ transparent frame). One pipeline instance owns its canvases and caches, so the studio,
// the hero demo and the exporter can each have their own.
//
// Output surfaces: Canvas2D by default. A canvas can only ever hold one kind of context, so modes that draw with
// WebGL2 declare `surface: 'gl'` and get a separate canvas (`ctx.out.gl`, also `ctx.gl`) that survives context loss:
// on `webglcontextlost` / `webglcontextrestored` the mode state is dropped and rebuilt by the next render.
// While the context is lost, render() resolves `{ lost: true }` (the caller keeps the last frame on screen).
// A GL mode can also draw its final picture on the 2D surface (`ctx.out2d`, e.g. GPU raymarching read back and drawn
// as glyphs) and return `{ surface: '2d' }` in its meta.

import { Analysis } from './analysis.js';
import { cropRect, preprocess, preprocessKey } from './preprocess.js';
import { depthField } from './depth.js';
import { isActive as postfxActive, applyPostFX } from './postfx.js';

const MAX_WORK_SIDE = 8192;
const MAX_WORK_PIXELS = 16e6;

// Live pipelines, for pipelineStats() (diagnostics and the memory tests). Weak: a forgotten pipeline is not kept alive.
const live = new Set();

/** Rough bytes held by a mode state: typed arrays, ImageData and canvases, a few levels deep. */
function stateBytes(root) {
  const seen = new Set();
  let bytes = 0;
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (ArrayBuffer.isView(v)) { bytes += v.byteLength; return; }
    if (v instanceof ArrayBuffer) { bytes += v.byteLength; return; }
    if (typeof ImageData !== 'undefined' && v instanceof ImageData) { bytes += v.data.byteLength; return; }
    if ((typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement)
      || (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas)) { bytes += v.width * v.height * 4; return; }
    if (depth > 5) return;
    if (v instanceof Map) { for (const x of v.values()) walk(x, depth + 1); return; }
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return; // GL contexts, DOM nodes...
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(root, 0);
  return bytes;
}

/**
 * Diagnostics: what every live pipeline holds (mode states, their bytes, surfaces). Used by the memory tests.
 * @returns {{label:string, modes:string[], stateBytes:number, surfaceBytes:number, analysisBytes:number, gl:boolean}[]}
 */
export function pipelineStats() {
  const out = [];
  for (const ref of live) {
    const p = ref.deref();
    if (!p) { live.delete(ref); continue; }
    out.push(p.stats());
  }
  return out;
}

function makeCanvas() {
  return document.createElement('canvas');
}

/**
 * @param {object} [o]
 * @param {() => void} [o.onInvalidate]  re-render request (fonts loaded, worker progress, AI depth arrived...)
 * @param {(event: 'lost'|'restored') => void} [o.onContextEvent]  WebGL context lost / restored (to tell the user)
 * @param {string} [o.label]  name shown by pipelineStats()
 */
export function createPipeline({ onInvalidate, onContextEvent, label = '' } = {}) {
  const ws = { canvas: makeCanvas(), ctx: null, scratch: [] };
  ws.ctx = ws.canvas.getContext('2d', { willReadFrequently: true });
  const analysis = new Analysis();
  const surface2d = makeCanvas();
  const framed = makeCanvas();
  const fxCanvas = makeCanvas(); // Post-FX result (PLAN.md 5.6)
  const out2d = { canvas: surface2d, ctx2d: surface2d.getContext('2d'), gl: null };
  let outGl = null; // created on first use by a 'gl' mode
  const states = new Map(); // modeId -> { mode, state }

  function glSurface() {
    if (outGl) return outGl;
    const canvas = makeCanvas();
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available');
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault(); // ask the browser to restore it
      onContextEvent?.('lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // GPU resources are gone: let every GL mode rebuild its state on the next render
      for (const [id, entry] of states) {
        if (entry.mode.surface === 'gl') {
          try { entry.mode.dispose?.(entry.state); } catch { /* resources already lost */ }
          states.delete(id);
        }
      }
      lastKey = '';
      onContextEvent?.('restored');
      onInvalidate?.();
    });
    outGl = { canvas, ctx2d: null, gl };
    return outGl;
  }

  let lastKey = '';
  let pending = null; // AbortController of the render in flight
  let lastPre = { imageData: null, usedFilterPath: 'none' };
  let frameCounter = 0;

  /** Dispose and forget a mode state (its buffers, canvases and GL objects). */
  function dropState(id) {
    const entry = states.get(id);
    if (!entry) return;
    states.delete(id);
    try { entry.mode.dispose?.(entry.state); } catch { /* resources already gone (context lost) */ }
  }

  function stateFor(mode, ctx) {
    // Only the mode being rendered keeps its state: switching modes releases the previous one's scratch buffers,
    // canvases and GL objects (with 25 modes they would otherwise add up to tens of MB per pipeline).
    for (const [id, entry] of states) if (id !== mode.id || entry.mode !== mode) dropState(id);
    let entry = states.get(mode.id);
    if (!entry) {
      entry = { mode, state: mode.init ? mode.init(ctx) : {} };
      if (!entry.state) entry.state = {};
      states.set(mode.id, entry);
    }
    return entry.state;
  }

  /** Fallback when a mode throws: show the original picture (PLAN.md 18.2). Always a 2D surface. */
  function drawFallback(frame, crop) {
    const k = Math.min(1, 1280 / Math.max(crop.sw, crop.sh));
    surface2d.width = Math.max(1, Math.round(crop.sw * k));
    surface2d.height = Math.max(1, Math.round(crop.sh * k));
    const g = out2d.ctx2d;
    g.clearRect(0, 0, surface2d.width, surface2d.height);
    try {
      g.drawImage(frame, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, surface2d.width, surface2d.height);
    } catch { /* nothing to show */ }
  }

  /**
   * @param {object} args
   * @param {object} args.source   a source from io/sources.js
   * @param {object} args.mode     a mode module (PLAN.md 6)
   * @param {object} args.params   { global, color, depth, postfx, mode }
   * @param {number} [args.time]   seconds
   * @param {'draft'|'full'} [args.quality]
   * @param {boolean} [args.isExport]
   * @param {number} [args.outScale]  output pixel multiplier (export 1x/2x/4x, retina preview)
   * @param {number} [args.autoScale] automatic quality factor (PLAN.md 18.2)
   * @param {{ink:string,bg:string}} args.theme  theme output colours
   */
  async function render(args) {
    const t0 = performance.now();
    const {
      source, mode, params, time = 0, dt = 0, quality = 'full', isExport = false,
      outScale = 1, autoScale = 1, theme,
    } = args;
    const g = params.global;
    const crop = cropRect(g, source.width, source.height);

    // Working resolution
    const qs = isExport || quality === 'full' ? 1 : (mode.draftScale ?? 0.5);
    const scale = Math.max(0.05, qs * (isExport ? 1 : autoScale));
    const isVideo = source.kind === 'video' || source.kind === 'webcam';
    const res = mode.resolution(params, crop.sw, crop.sh, { isExport, isVideo });
    let W = Math.max(1, Math.round(res.width * scale));
    let H = Math.max(1, Math.round(res.height * scale));
    W = Math.min(W, MAX_WORK_SIDE);
    H = Math.min(H, MAX_WORK_SIDE);
    if (W * H > MAX_WORK_PIXELS) {
      const k = Math.sqrt(MAX_WORK_PIXELS / (W * H));
      W = Math.max(1, Math.floor(W * k));
      H = Math.max(1, Math.floor(H * k));
    }

    const pre = mode.preOptions ? mode.preOptions(params, theme) : {};
    const matte = pre.matte ?? '#000000';
    const edgeBlend = pre.edgeBlend ?? 'light';

    const frame = source.frame(time);
    // A source may expose `frameId` (e.g. the decoded video frame number): it then decides when pixels changed
    const frameKey = source.frameId !== undefined ? source.frameId : (source.animated ? time.toFixed(5) : 0);
    const key = [
      source.version, frameKey, preprocessKey(g), `${W}x${H}`, matte, edgeBlend,
      `${crop.sx}|${crop.sy}|${crop.sw}|${crop.sh}`,
    ].join('#');

    if (key !== lastKey) {
      if (ws.canvas.width !== W || ws.canvas.height !== H) {
        ws.canvas.width = W;
        ws.canvas.height = H;
      }
      lastPre = preprocess(ws, frame, source.width, source.height, g, { matte, edgeBlend });
      analysis.reset(W, H, ws.canvas, lastPre.imageData ? lastPre.imageData.data : null);
      lastKey = key;
    }

    let out = out2d;
    let glError = null;
    if (mode.surface === 'gl') {
      try { out = glSurface(); } catch (err) { glError = err; }
      if (!glError && out.gl.isContextLost()) {
        return { lost: true, canvas: null, width: 0, height: 0, meta: {}, error: null, ms: performance.now() - t0 };
      }
    }

    // Heavy modes pass ctx.signal to the worker runner: abortPending() (a parameter changed) stops a stale job
    const abortCtl = new AbortController();
    pending = abortCtl;
    const ctx = {
      source: ws.canvas,
      width: W,
      height: H,
      srcWidth: source.width,
      srcHeight: source.height,
      get rgba() { return analysis.rgba(); },
      luma: () => analysis.luma(),
      sobel: () => analysis.sobel(),
      depth: (opts) => depthField({
        analysis, params: params.depth || {}, source, frameKey, isExport, isVideo, invalidate: () => onInvalidate?.(), opts,
      }),
      time,
      dt,
      frameIndex: frameCounter++,
      isVideo,
      isExport,
      signal: abortCtl.signal,
      quality: isExport ? 'full' : quality,
      params,
      theme,
      out,
      gl: out.gl,
      out2d, // GL modes may draw their final picture here and return { surface: '2d' }
      outScale,
      invalidate: () => onInvalidate?.(),
      // true when invalidate() re-renders (the studio preview): a mode may then show work in progress and finish later
      progressive: !!onInvalidate && !isExport,
    };

    let meta = {};
    let error = null;
    try {
      if (glError) throw glError;
      const state = stateFor(mode, ctx);
      const r = mode.render(ctx, state);
      meta = (r && typeof r.then === 'function' ? await r : r) || {};
    } catch (err) {
      if (err?.name === 'AbortError' && abortCtl.signal.aborted) {
        return { aborted: true, canvas: null, width: 0, height: 0, meta: {}, error: null, ms: performance.now() - t0 };
      }
      if (err?.name === 'AbortError') {
        // Not ours: the shared worker was restarted to stop another caller's job (heavy.js rejects every job in
        // flight on it). Nothing is wrong with this mode: report it as aborted and ask for a fresh render.
        onInvalidate?.();
        return { aborted: true, retry: true, canvas: null, width: 0, height: 0, meta: {}, error: null, ms: performance.now() - t0 };
      }
      error = err;
      console.error(`[dither] mode "${mode.id}" failed to render`, err);
      drawFallback(frame, crop);
    }

    // Transparent frame: a margin around the output (shown and exported)
    // a mode may render smaller than asked to respect size caps; the fallback picture is always 1x
    const effScale = error ? 1 : (meta.effectiveScale ?? outScale);
    const margin = Math.round((g.frame || 0) * effScale);
    let surface = error || meta.surface === '2d' ? surface2d : out.canvas;
    // Global Post-FX (5.6): raster only. Text/SVG exports read the mode state, so they never include it.
    let postfx = false;
    if (!error && postfxActive(params.postfx)) {
      postfx = applyPostFX(surface, fxCanvas, params.postfx, { time, scale: effScale });
      if (postfx) surface = fxCanvas;
    }
    let canvas = surface;
    if (margin > 0 && !error) {
      framed.width = surface.width + margin * 2;
      framed.height = surface.height + margin * 2;
      const fg = framed.getContext('2d');
      fg.clearRect(0, 0, framed.width, framed.height);
      fg.drawImage(surface, margin, margin);
      canvas = framed;
    }

    return {
      canvas,
      width: canvas.width,
      height: canvas.height,
      outScale: effScale,
      requestedScale: outScale,
      workWidth: W,
      workHeight: H,
      meta,
      error,
      transparent: !!meta.transparent || (margin > 0 && !error),
      ms: performance.now() - t0,
      filterPath: lastPre.usedFilterPath,
      postfx,
    };
  }

  const api = {
    render,
    /** Cancel the render in flight (its heavy jobs reject with AbortError and render() resolves `{ aborted: true }`). */
    abortPending() { pending?.abort(); },
    /** Drop cached preprocessing (e.g. after the source changed in place). */
    invalidate() { lastKey = ''; },
    /** Mode state, used by exports (toText/toSVG) after a render. */
    getState(modeId) { return states.get(modeId)?.state ?? null; },
    /** Diagnostics (see pipelineStats()). */
    stats() {
      let surfaceBytes = 0;
      for (const c of [ws.canvas, surface2d, framed, fxCanvas, outGl?.canvas, ...ws.scratch]) if (c) surfaceBytes += c.width * c.height * 4;
      let bytes = 0;
      for (const { state } of states.values()) bytes += stateBytes(state);
      return { label, modes: [...states.keys()], stateBytes: bytes, surfaceBytes, analysisBytes: analysis.bytes, gl: !!outGl };
    },
    dispose() {
      for (const id of [...states.keys()]) dropState(id);
      live.delete(selfRef);
      lastKey = '';
      analysis.release();
      lastPre = { imageData: null, usedFilterPath: 'none' };
      for (const c of ws.scratch) if (c) c.width = c.height = 0;
      ws.scratch.length = 0;
      ws.canvas.width = ws.canvas.height = 1;
      surface2d.width = surface2d.height = 1;
      framed.width = framed.height = 1;
      fxCanvas.width = fxCanvas.height = 1;
      if (outGl) {
        outGl.gl.getExtension('WEBGL_lose_context')?.loseContext();
        outGl.canvas.width = outGl.canvas.height = 1;
        outGl = null;
      }
    },
  };
  const selfRef = new WeakRef(api);
  live.add(selfRef);
  return api;
}
