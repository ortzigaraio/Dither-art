// Render pipeline (PLAN.md 5.1): source frame -> work canvas (W x H) -> preprocess -> analysis -> mode.render
// -> output surface (+ transparent frame). One pipeline instance owns its canvases and caches, so the studio,
// the hero demo and the exporter can each have their own.
//
// Output surfaces: Canvas2D by default. A canvas can only ever hold one kind of context, so modes that draw with
// WebGL2 declare `surface: 'gl'` and get a separate canvas (`ctx.out.gl`, also `ctx.gl`) that survives context loss:
// on `webglcontextlost` / `webglcontextrestored` the mode state is dropped and rebuilt by the next render.

import { Analysis } from './analysis.js';
import { cropRect, preprocess, preprocessKey } from './preprocess.js';

const MAX_WORK_SIDE = 8192;
const MAX_WORK_PIXELS = 16e6;

function makeCanvas() {
  return document.createElement('canvas');
}

export function createPipeline({ onInvalidate } = {}) {
  const ws = { canvas: makeCanvas(), ctx: null, scratch: [] };
  ws.ctx = ws.canvas.getContext('2d', { willReadFrequently: true });
  const analysis = new Analysis();
  const surface2d = makeCanvas();
  const framed = makeCanvas();
  const out2d = { canvas: surface2d, ctx2d: surface2d.getContext('2d'), gl: null };
  let outGl = null; // created on first use by a 'gl' mode
  const states = new Map(); // modeId -> { mode, state }

  function glSurface() {
    if (outGl) return outGl;
    const canvas = makeCanvas();
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available');
    canvas.addEventListener('webglcontextlost', (ev) => ev.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => {
      // GPU resources are gone: let every GL mode rebuild its state on the next render
      for (const [id, entry] of states) {
        if (entry.mode.surface === 'gl') {
          try { entry.mode.dispose?.(entry.state); } catch { /* resources already lost */ }
          states.delete(id);
        }
      }
      lastKey = '';
      onInvalidate?.();
    });
    outGl = { canvas, ctx2d: null, gl };
    return outGl;
  }

  let lastKey = '';
  let lastPre = { imageData: null, usedFilterPath: 'none' };
  let frameCounter = 0;

  function stateFor(mode, ctx) {
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
    const res = mode.resolution(params, crop.sw, crop.sh);
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
    }

    const ctx = {
      source: ws.canvas,
      width: W,
      height: H,
      srcWidth: source.width,
      srcHeight: source.height,
      get rgba() { return analysis.rgba(); },
      luma: () => analysis.luma(),
      sobel: () => analysis.sobel(),
      depth: (opts) => analysis.depth({ invert: !!params.depth?.invert, smooth: params.depth?.smooth ?? 0, ...opts }),
      time,
      dt,
      frameIndex: frameCounter++,
      isVideo: source.kind === 'video' || source.kind === 'webcam',
      isExport,
      quality: isExport ? 'full' : quality,
      params,
      theme,
      out,
      gl: out.gl,
      outScale,
      invalidate: () => onInvalidate?.(),
    };

    let meta = {};
    let error = null;
    try {
      if (glError) throw glError;
      const state = stateFor(mode, ctx);
      const r = mode.render(ctx, state);
      meta = (r && typeof r.then === 'function' ? await r : r) || {};
    } catch (err) {
      error = err;
      console.error(`[horain] mode "${mode.id}" failed to render`, err);
      drawFallback(frame, crop);
    }

    // Transparent frame: a margin around the output (shown and exported)
    // a mode may render smaller than asked to respect size caps; the fallback picture is always 1x
    const effScale = error ? 1 : (meta.effectiveScale ?? outScale);
    const margin = Math.round((g.frame || 0) * effScale);
    const surface = error ? surface2d : out.canvas;
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
    };
  }

  return {
    render,
    /** Drop cached preprocessing (e.g. after the source changed in place). */
    invalidate() { lastKey = ''; },
    /** Mode state, used by exports (toText/toSVG) after a render. */
    getState(modeId) { return states.get(modeId)?.state ?? null; },
    dispose() {
      for (const { mode, state } of states.values()) {
        try { mode.dispose?.(state); } catch { /* ignore */ }
      }
      states.clear();
      lastKey = '';
      ws.canvas.width = ws.canvas.height = 1;
      surface2d.width = surface2d.height = 1;
      framed.width = framed.height = 1;
      if (outGl) {
        outGl.gl.getExtension('WEBGL_lose_context')?.loseContext();
        outGl.canvas.width = outGl.canvas.height = 1;
        outGl = null;
      }
    },
  };
}
