// Studio controller: ties state, controls, viewer, pipeline, scheduler and exports together.
// main.js only boots the page and decides which view is visible.

import { t, tl, onLangChange } from './i18n/i18n.js';
import { createStore, decodeShareHash, sanitizeState } from './state.js';
import { getLoadedMode, loadMode, modeAvailable, MODE_META, DEFAULT_MODE_ID } from './modes/registry.js';
import { createPipeline } from './engine/pipeline.js';
import { cropRect } from './engine/preprocess.js';
import { createScheduler } from './scheduler.js';
import { createViewer } from './ui/viewer.js';
import { createControls } from './ui/controls.js';
import { createModeList } from './ui/modeList.js';
import { createExportGroup } from './ui/exportPanel.js';
import { createInputGroup, describeSource } from './ui/inputPanel.js';
import { createPresetsGroup } from './ui/presets.js';
import { stateWithPreset, surprise as surpriseParams } from './presets.js';
import { createTransport } from './ui/transport.js';
import { WebcamSource } from './io/sources.js';
import { themeOutputColors, onThemeChange } from './ui/header.js';
import { scramble } from './ui/scramble.js';
import { toast, toastError, toastWarn } from './ui/toast.js';
import { exportName, downloadBlob } from './io/download.js';
import { canvasToBlob, fitExportScale, shrinkToLimit, copyImageBlob, copyText } from './io/exportImage.js';
import { LIMITS } from './config.js';
import * as heavy from './engine/heavy.js';
import { loadDepthAI, depthAIStatus } from './engine/depth.js';
import { orbitBy, panBy, dollyBy } from './engine/camera.js';
import { confirmDepthDownload } from './ui/depthDialog.js';
import { initShortcuts, openShortcutsHelp } from './ui/shortcuts.js';

const AI_CONSENT_KEY = 'horain.depthAI';
const hasAIConsent = () => { try { return localStorage.getItem(AI_CONSENT_KEY) === '1'; } catch { return false; } };
const saveAIConsent = () => { try { localStorage.setItem(AI_CONSENT_KEY, '1'); } catch { /* storage blocked: ask again next time */ } };

const isMobile = () => window.matchMedia('(max-width: 699px)').matches;

// Video export code (encoder setup, dialog) loads the first time a video export or a recording is prepared.
let videoKit = null;
let vx = null; // io/exportVideo.js once loaded
const loadVideoKit = () => (videoKit ||= Promise.all([import('./io/exportVideo.js'), import('./ui/exportDialog.js')])
  .then(([videoModule, dialogModule]) => {
    vx = videoModule;
    return { vx: videoModule, openExportDialog: dialogModule.openExportDialog };
  })
  .catch((err) => { videoKit = null; throw err; }));

/**
 * @param {{ onChangeFile: () => void }} hooks
 */
export function createStudio({ onChangeFile }) {
  const store = createStore();
  const notices = [];
  if (location.hash.startsWith('#s=')) {
    const shared = decodeShareHash(location.hash);
    if (shared) store.replace(shared);
    else {
      notices.push(() => toastWarn(t('info.stateIgnored')));
      store.load();
    }
  } else {
    store.load();
  }

  let source = null;
  let active = false;
  let dragging = false;
  let theme = themeOutputColors();
  let lastTime = 0;
  let lastExportTime = null; // meta.exportTime of the last preview frame, if the mode reports one
  let autoScale = 1;
  let slowFrames = 0;
  let exporting = false;
  let activeExport = null;   // { abort() } of the running video export
  let recorder = null;       // { rec, t0 } while the webcam is being recorded
  let resumeOnShow = false;  // playback to restart when the tab or the view comes back
  let exportSeq = 0;
  // GPU modes need WebGL2: a remembered or shared state may point at one this browser cannot run (PLAN.md 18.2)
  if (!modeAvailable(getLoadedMode(store.state.modeId))) {
    store.state.modeId = DEFAULT_MODE_ID;
    notices.push(() => toastWarn(t('err.noWebGL2')));
  }

  // the store only ever points at a loaded mode (setModeId refuses others; selectMode loads first)
  const mode = () => getLoadedMode(store.state.modeId);

  // Switch mode, loading its code on demand. The last choice wins: a slower load that finishes after a newer
  // choice is dropped, so a stale mode never replaces the one the user picked last.
  let modeReq = 0;
  async function selectMode(id) {
    const req = ++modeReq;
    let m;
    try {
      m = await loadMode(id);
    } catch (err) {
      if (req === modeReq) {
        console.warn('[dither] could not load mode', id, err);
        toastError(t('err.modeLoad'));
      }
      return false;
    }
    if (req !== modeReq) return false;
    if (!modeAvailable(m)) { toastWarn(t('err.noWebGL2')); return false; }
    return store.setModeId(id);
  }
  const paramsNow = () => {
    const s = store.state;
    return { global: s.global, color: s.color, depth: s.depth, postfx: s.postfx, mode: s.modes[s.modeId] };
  };
  const dpr = () => Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const MAX_PREVIEW_SIDE = 4096;

  // The preview is rendered at the resolution the current zoom needs, so text stays sharp when zooming in.
  let scaleTimer = 0;
  let previewScale = 1;
  let lastLogical = { w: 0, h: 0 };
  function wantedScale() {
    let k = Math.min(4, Math.max(1, Math.ceil(viewer.zoom * dpr() - 0.01)));
    if (lastLogical.w) k = Math.min(k, Math.max(1, Math.floor(MAX_PREVIEW_SIDE / Math.max(lastLogical.w, lastLogical.h))));
    return k;
  }
  function onZoom() {
    clearTimeout(scaleTimer);
    scaleTimer = setTimeout(() => {
      const k = wantedScale();
      if (k !== previewScale) { previewScale = k; scheduler.markDirty(); }
    }, 160);
  }

  // ---- engine ------------------------------------------------------------------------------
  const onContextEvent = (ev) => {
    if (ev === 'lost') toastWarn(t('gl.lost'));
    else toast(t('gl.restored'));
  };
  const pipeline = createPipeline({ onInvalidate: () => scheduler.markDirty(), onContextEvent, label: 'preview' });
  let exportPipeline = null;
  const getExportPipeline = () => exportPipeline || (exportPipeline = createPipeline({ label: 'export' }));
  /** An export pass can hold an 8192 px canvas and its buffers: give them back as soon as the export is done. */
  const releaseExportPipeline = () => {
    exportPipeline?.dispose();
    exportPipeline = null;
  };

  const viewer = createViewer({ onZoomChange: onZoom });

  // ---- heavy worker jobs: progress overlay after 250 ms, and the 30 s watchdog (PLAN.md 18.2) ----------
  let heavyTimer = 0;
  let heavyShown = false;
  heavy.onActivity(({ active, progress }) => {
    if (active) {
      const label = () => t('heavy.progress', { pct: Math.round(progress * 100) });
      if (heavyShown) { if (!exporting) viewer.setBusy(true, label()); } else if (!heavyTimer) {
        heavyTimer = setTimeout(() => {
          heavyTimer = 0;
          heavyShown = true;
          if (!exporting) viewer.setBusy(true, label());
        }, 250);
      }
    } else {
      clearTimeout(heavyTimer);
      heavyTimer = 0;
      if (heavyShown) { heavyShown = false; if (!exporting) viewer.setBusy(false); }
    }
  });
  heavy.setWatchdogHandler(({ cancel }) => {
    toastWarn(t('heavy.slow', { s: LIMITS.workerWatchdogMs / 1000 }), { timeout: 0, action: { label: t('heavy.cancel'), onClick: cancel } });
  });

  /** A mode moves always (`animated`) or only with some settings (`animatedWhen(modeParams)`, e.g. Glitch "animate"). */
  const modeMoves = (m, modeParams = store.state.modes[m.id]) => !!(m.animated || m.animatedWhen?.(modeParams || {}));

  async function renderFrame(nowSec) {
    if (!source) return;
    const src = source;
    const m = mode();
    const animated = !!(source.animated || modeMoves(m));
    // A video file is rendered at its own clock, so animated modes follow the picture; everything else uses the loop clock
    const time = source.kind === 'video' ? source.shownTime : animated ? nowSec : 0;
    lastTime = time;
    const result = await pipeline.render({
      source,
      mode: m,
      params: paramsNow(),
      time,
      quality: dragging ? 'draft' : 'full',
      outScale: previewScale,
      autoScale,
      theme,
    });
    if (result.aborted) return; // a parameter changed while a heavy job ran: the loop renders again (dirty)
    if (result.lost) return; // WebGL context lost: keep the last frame until it is restored (the pipeline re-renders)
    // The source or the mode changed while this frame was rendering (async modes, worker jobs): it is stale. Drawing
    // it would show (and record) the old picture with the new source's "original"; the change already asked for a
    // fresh render.
    if (src !== source || m !== mode()) return;

    // a mode whose picture depends on its own clock (a simulation started at RESET) tells exports which time to render
    lastExportTime = Number.isFinite(result.meta?.exportTime) ? result.meta.exportTime : null;
    lastLogical = { w: result.width / result.outScale, h: result.height / result.outScale };
    document.getElementById('viewer-canvas').dataset.mode = m.id; // which mode drew the picture on screen (diagnostics and tests)
    viewer.present(result, {
      drawOriginal: (g, w, h) => {
        const crop = cropRect(store.state.global, source.width, source.height);
        g.save();
        if (store.state.global.flipX) { g.translate(w, 0); g.scale(-1, 1); }
        g.drawImage(source.frame(time), crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
        g.restore();
      },
    });
    // source time of the picture on screen (the transport clock can already show the next decoded frame)
    document.getElementById('viewer-canvas').dataset.srcTime = time.toFixed(3);
    if (recorder && !result.error) recorder.rec.push(result.canvas, (performance.now() - recorder.t0) / 1000);
    viewer.setStats({
      res: `${result.meta?.cols ?? result.workWidth}×${result.meta?.rows ?? result.workHeight}`,
      fps: animated ? scheduler.fps : 0,
      ms: result.ms,
    });

    // Automatic quality (PLAN.md 18.2): >200 ms for 5 frames in a row lowers the working resolution
    if (result.ms > LIMITS.slowRenderMs && !result.error) {
      slowFrames++;
      if (slowFrames >= LIMITS.slowRenderFrames && autoScale > 0.26) {
        autoScale = Math.max(0.25, autoScale * 0.7);
        slowFrames = 0;
        scheduler.markDirty();
      }
    } else {
      slowFrames = 0;
    }
    viewer.setChips({ auto: autoScale < 1, error: !!result.error });
    document.body.dataset.rendered = String(Number(document.body.dataset.rendered || 0) + 1);
  }

  const scheduler = createScheduler({
    render: renderFrame,
    isAnimated: () => active && !!source && !!(source.animated || modeMoves(mode())),
    isActive: () => active && viewer.visible,
    maxFps: isMobile() ? LIMITS.mobileMaxFps : 0,
  });

  // ---- exports -----------------------------------------------------------------------------
  async function withExport(label, fn) {
    if (exporting || !source) {
      if (!source) toast(t('export.nothing'), { type: 'warn' });
      return;
    }
    exporting = true;
    viewer.setBusy(true, label);
    try {
      await fn();
    } catch (err) {
      console.warn('[dither] export failed', err);
      toastError(t('export.failed'));
    } finally {
      releaseExportPipeline();
      exporting = false;
      viewer.setBusy(false);
    }
  }

  const exportBase = () => ({
    source, mode: mode(), params: paramsNow(), time: lastExportTime ?? lastTime, quality: 'full', isExport: true, theme,
  });

  /** Render a full-quality export pass and return { result, state }. */
  async function renderExport(outScale = 1) {
    const pipe = getExportPipeline();
    const base = exportBase();
    let result = await pipe.render({ ...base, outScale });
    // the shared worker was restarted under this job by another caller: render again
    for (let i = 0; i < 2 && result.retry; i++) result = await pipe.render({ ...base, outScale });
    if (result.lost) throw new Error('WebGL context lost');
    if (result.aborted) throw new Error('render interrupted');
    if (result.error) throw result.error;
    return { result, state: pipe.getState(base.mode.id), mode: base.mode };
  }

  async function pngBlob(scale) {
    const probe = await renderExport(1);
    let fit = fitExportScale(probe.result.width, probe.result.height, scale);
    let out = fit.scale === 1 ? probe : await renderExport(fit.scale);
    let clamped = fit.clamped;
    // Cell sizes are rounded per scale, so the estimate can overshoot slightly: verify and shrink
    for (let i = 0; i < 4; i++) {
      const longest = Math.max(out.result.width, out.result.height);
      if (longest <= LIMITS.maxExportImageSide) break;
      clamped = true;
      out = await renderExport(shrinkToLimit(fit.scale, longest));
      fit = { scale: fit.scale * 0.9 };
    }
    if (Math.max(out.result.width, out.result.height) > LIMITS.maxExportImageSide) throw new Error('export too large');
    if (out.result.outScale < scale * 0.999) clamped = true; // the mode itself rendered smaller than requested
    if (clamped) toast(t('export.scaleClamped', { px: Math.max(out.result.width, out.result.height) }), { type: 'warn' });
    return canvasToBlob(out.result.canvas, 'image/png');
  }

  // ---- presets, "Surprise me" and share links (PLAN.md 10) -----------------------------------------
  function shareUrl() {
    return `${location.origin}${location.pathname}${store.shareHash()}`;
  }
  async function applyPreset(preset, modeId = store.state.modeId) {
    const req = ++modeReq; // a preset is a mode choice as well
    try {
      await loadMode(modeId);
    } catch {
      if (req === modeReq) toastError(t('presets.err.invalid'));
      return false;
    }
    if (req !== modeReq) return false;
    const next = stateWithPreset(store.state, modeId, preset);
    if (!next) { toastError(t('presets.err.invalid')); return false; }
    if (!modeAvailable(getLoadedMode(next.modeId))) { toastWarn(t('err.noWebGL2')); return false; }
    store.replace(next);
    toast(t('presets.applied', { name: typeof preset.name === 'string' ? preset.name : tl(preset.name) }));
    return true;
  }
  function surpriseMe() {
    const m = mode();
    const next = JSON.parse(JSON.stringify(store.state));
    next.modes[m.id] = surpriseParams(m, store.state.modes[m.id]);
    store.replace(sanitizeState(next));
  }

  const actions = {
    png: (scale) => withExport(t('viewer.rendering'), async () => {
      const blob = await pngBlob(scale);
      const name = downloadBlob(blob, exportName(mode().id, 'png'));
      toast(t('export.saved', { name }));
    }),

    text: (format, opts = {}) => withExport(t('viewer.rendering'), async () => {
      const { state, mode: m } = await renderExport(1);
      if (!m.exports?.includes(format)) throw new Error(`${m.id} does not export ${format}`);
      let blob;
      let ext = format;
      if (format === 'ans') {
        blob = new Blob([m.toBinary(state, 'ans')], { type: 'application/octet-stream' });
      } else if (format === 'svg') {
        blob = new Blob([m.toSVG(state, opts)], { type: 'image/svg+xml;charset=utf-8' });
      } else if (format === 'json') {
        blob = new Blob([m.toJSON(state)], { type: 'application/json;charset=utf-8' });
      } else if (format === 'ply') {
        blob = new Blob([m.toPLY(state)], { type: 'application/octet-stream' });
      } else {
        ext = format === 'ansi' ? 'ansi.txt' : format;
        const type = format === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
        blob = new Blob([m.toText(state, format, opts)], { type });
      }
      const name = downloadBlob(blob, exportName(m.id, ext));
      toast(t('export.saved', { name }));
    }),

    copyText: () => withExport(t('viewer.rendering'), async () => {
      const { state, mode: m } = await renderExport(1);
      const text = m.toText(state, 'txt');
      if (await copyText(text)) {
        toast(t('export.copied'));
      } else {
        downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), exportName(m.id, 'txt'));
        toastWarn(t('export.copyFailed'));
      }
    }),

    copyImage: () => withExport(t('viewer.rendering'), async () => {
      const blob = await pngBlob(1);
      if (await copyImageBlob(blob)) {
        toast(t('export.copied'));
      } else {
        downloadBlob(blob, exportName(mode().id, 'png'));
        toastWarn(t('export.copyFailed'));
      }
    }),

    video: () => startVideoExport(),

    share: async () => {
      const hash = store.shareHash();
      try { history.replaceState(null, '', hash); } catch { /* sandboxed frame */ }
      const url = shareUrl();
      if (await copyText(url)) toast(t('export.shareCopied'));
      else toastWarn(t('export.shareFailed'));
    },
  };


  // ---- video export and webcam recording (PLAN.md 9.2) ---------------------------------------------
  const playsAsVideo = (src) => !!src && (src.kind === 'video' || src.kind === 'webcam');
  const videoJobKind = () => (source?.kind === 'video' ? 'file' : source?.kind === 'webcam' ? 'live' : 'timeline');
  /** Pictures export as video only when something moves: the mode or the source itself is animated. */
  const canExportVideo = () => !!source && mode().exports?.includes('video')
    && (source.kind === 'video' || !!(modeMoves(mode()) || source.animated));

  function suspendPlayback() {
    if (source?.kind === 'video' && !source.paused) {
      resumeOnShow = true;
      source.pause();
    }
  }
  function resumePlayback() {
    if (resumeOnShow && source?.kind === 'video') source.play();
    resumeOnShow = false;
  }
  // The loop (and with it the video) sleeps while the tab is hidden (PLAN.md 18.2). A webcam recording pauses too:
  // no preview frames are rendered meanwhile, so the hidden time is cut out instead of freezing the last frame.
  function onVisibility() {
    if (document.hidden) {
      suspendPlayback();
      if (recorder && recorder.hiddenAt == null) { recorder.hiddenAt = performance.now(); recorder.rec.pause?.(); }
    } else {
      resumePlayback();
      if (recorder && recorder.hiddenAt != null) {
        recorder.t0 += performance.now() - recorder.hiddenAt;
        recorder.hiddenAt = null;
        recorder.rec.resume?.();
      }
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  /** A canvas the engine can treat as a source: the exporter paints each decoded frame into it. */
  function makeFrameSource(from) {
    const k = Math.min(1, 1920 / Math.max(from.width, from.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(from.width * k));
    canvas.height = Math.max(1, Math.round(from.height * k));
    return {
      id: 'export-frames', kind: 'video', name: from.name, width: canvas.width, height: canvas.height,
      version: -(++exportSeq), animated: false, frameId: 0, canvas, ctx: canvas.getContext('2d'),
      frame: () => canvas,
      dispose() { canvas.width = canvas.height = 1; },
    };
  }

  /** Frame renderer for the exporter: its own pipeline, always full quality, with parameters frozen at the start. */
  function makeVideoRenderer(settings, natural) {
    const pipe = createPipeline({ label: 'video-export' });
    const m = mode();
    const params = structuredClone(paramsNow());
    const th = { ...theme };
    const frameSrc = source.kind === 'video' ? makeFrameSource(source) : null;
    const target = frameSrc || source;
    const scale = settings.outH / natural;
    return {
      bg: th.bg,
      frameSrc,
      async render(time, paint) {
        if (paint && frameSrc) {
          paint(frameSrc.ctx, frameSrc.canvas.width, frameSrc.canvas.height);
          frameSrc.frameId++;
        }
        const args = { source: target, mode: m, params, time, quality: 'full', isExport: true, outScale: scale, theme: th };
        let r = await pipe.render(args);
        for (let i = 0; i < 2 && r.retry; i++) r = await pipe.render(args); // worker restarted by another caller
        if (r.lost) throw new Error('WebGL context lost');
        if (r.aborted) throw new Error('render interrupted');
        if (r.error) throw r.error;
        return r.canvas;
      },
      dispose() {
        pipe.dispose();
        frameSrc?.dispose();
      },
    };
  }

  async function openVideoDialog(kind, onStart) {
    if (exporting || recorder) { toast(t('export.busy'), { type: 'warn' }); return; }
    exporting = true; // blocks other exports while the dialog is open
    let dialogOpen = false;
    try {
      const [probe, kit] = await Promise.all([renderExport(1), loadVideoKit()]);
      const aspect = probe.result.width / probe.result.height;
      const natural = Math.max(2, probe.result.height / (probe.result.outScale || 1));
      releaseExportPipeline(); // the job renders with its own pipeline
      const caps = await kit.vx.detectCapabilities(Math.round(natural * aspect), Math.round(natural));
      kit.openExportDialog({
        kind, source, aspect, naturalHeight: natural, caps,
        onStart: (settings, ctl) => onStart(settings, ctl, { natural, caps }),
        onClose: () => { exporting = false; },
      });
      dialogOpen = true;
    } catch (err) {
      console.warn('[dither] could not prepare the video export', err);
      toastError(t('export.failed'));
    } finally {
      if (!dialogOpen) exporting = false;
    }
  }

  function startVideoExport() {
    if (!canExportVideo()) { toast(t('export.nothing'), { type: 'warn' }); return; }
    const kind = videoJobKind();
    if (kind === 'live') { toggleRecording(); return; }
    if (mode().uses.includes('depth') && store.state.depth.source === 'ai') toastWarn(t('depth.slowExport'));
    openVideoDialog(kind, async (settings, ctl, { natural, caps }) => {
      const ac = new AbortController();
      ctl.signal.addEventListener('abort', () => ac.abort());
      activeExport = ac;
      const renderer = makeVideoRenderer(settings, natural);
      const m = mode();
      try {
        const job = {
          format: settings.format, fps: settings.effectiveFps, quality: settings.quality,
          outW: settings.outW, outH: settings.outH, bg: renderer.bg, render: renderer.render,
          signal: ac.signal, onProgress: (p, info) => ctl.progress(p, info.remaining),
        };
        let res;
        if (kind === 'file') {
          res = await vx.exportFromFile({
            ...job, fps: settings.fps, file: source.file, includeAudio: settings.includeAudio, trim: settings.trim,
          }, caps);
        } else {
          res = await vx.exportTimeline({ ...job, duration: settings.duration }, caps);
        }
        const name = downloadBlob(res.blob, exportName(m.id, res.ext));
        toast(t('export.saved', { name }));
        if (res.fellBack) toastWarn(t('export.fellBack'));
        if (res.audioDropped) toastWarn(t('export.audioDropped'));
      } catch (err) {
        if (err instanceof vx.ExportCanceled) toast(t('export.canceled'));
        else {
          console.warn('[dither] video export failed', err);
          toastError(t('export.failed'));
        }
      } finally {
        activeExport = null;
        renderer.dispose();
      }
    });
  }

  function toggleRecording() {
    if (recorder) { stopRecording(); return; }
    if (source?.kind !== 'webcam') return;
    const cam = source;
    openVideoDialog('live', async (settings, ctl, { caps }) => {
      let rec;
      try {
        rec = await vx.createLiveRecorder({
          format: settings.format, fps: settings.effectiveFps, quality: settings.quality,
          outW: settings.outW, outH: settings.outH, bg: theme.bg,
        }, caps);
      } catch (err) {
        // e.g. the encoder or MediaRecorder refused the settings: say so instead of an unhandled rejection
        console.warn('[dither] could not start recording', err);
        toastError(t('export.failed'));
        return;
      }
      if (source !== cam) { await rec.cancel(); ctl.close(); return; } // the camera went away meanwhile
      recorder = { rec, t0: performance.now(), mode: mode(), hiddenAt: null };
      exporting = false;
      transport.setRecording(true);
      scheduler.markDirty();
      ctl.close();
    });
  }

  async function stopRecording() {
    const r = recorder;
    if (!r) return;
    recorder = null;
    transport.setRecording(false);
    exporting = true;
    viewer.setBusy(true, t('vx.saving'));
    try {
      const res = await r.rec.finish();
      if (!res.blob.size) throw new Error('empty recording');
      const name = downloadBlob(res.blob, exportName(r.mode.id, res.ext));
      toast(t('export.saved', { name }));
    } catch (err) {
      console.warn('[dither] recording failed', err);
      toastError(t('export.failed'));
    } finally {
      exporting = false;
      viewer.setBusy(false);
    }
  }

  function cancelRecording() {
    const r = recorder;
    if (!r) return;
    recorder = null;
    transport.setRecording(false);
    r.rec.cancel();
  }

  async function switchCamera(id) {
    if (source?.kind !== 'webcam' || !id || id === source.deviceId) return;
    try {
      await source.useDevice(id);
      pipeline.invalidate();
      scheduler.markDirty();
    } catch (err) {
      console.warn('[dither] could not switch camera', err);
      toastError(t('err.cameraBusy'));
      transport.setCameras(await WebcamSource.listCameras());
    }
  }

  function refreshInputInfo() {
    const node = document.getElementById('src-dims');
    if (!node || !source) return;
    const text = describeSource(source);
    if (node.textContent !== text) node.textContent = text;
  }

  const transport = createTransport({
    host: document.getElementById('transport'),
    onRecordToggle: toggleRecording,
    onCameraChange: switchCamera,
  });

  /** Every new decoded picture: render it (the scheduler coalesces) and keep the clock and info in step. */
  function onSourceFrame() {
    scheduler.markDirty();
    transport.tick();
    refreshInputInfo();
  }

  // ---- controls and mode list ----------------------------------------------------------------
  const controls = createControls({
    host: document.getElementById('controls'),
    panel: document.getElementById('studio-panel'),
    tabsHost: document.getElementById('sheet-tabs'),
    store,
    getMode: mode,
    getTheme: () => theme,
    onDragging: (on) => {
      dragging = on;
      if (!on) scheduler.markDirty(); // back to full quality
    },
    extra: {
      input: () => (source ? createInputGroup(source, { onChange: onChangeFile }) : null),
      export: () => createExportGroup(mode(), actions, { video: canExportVideo() }),
      presets: () => createPresetsGroup({
        mode: mode(), store, apply: applyPreset, surprise: surpriseMe, shareUrl, share: actions.share,
      }).el,
    },
    onAction: (param) => {
      if (param.action === 'depthAI') enableDepthAI();
      else if (param.action && typeof mode().onAction === 'function') {
        // a mode-specific action (e.g. restart a simulation): the mode updates its preview state
        mode().onAction(param.action, pipeline.getState(mode().id));
        scheduler.markDirty();
      } else if (Array.isArray(param.resets)) {
        // e.g. "Reset camera": restore these params of the current mode to their defaults
        const m = mode();
        for (const id of param.resets) {
          const def = m.params.find((x) => x.id === id);
          if (def) store.set(`modes.${m.id}.${id}`, def.default);
        }
      }
    },
  });

  // ---- AI depth (PLAN.md 5.5): confirmation the first time, download progress, toast + brightness on failure ----
  let aiRequest = null;
  function enableDepthAI() {
    if (aiRequest) return aiRequest;
    aiRequest = (async () => {
      if (depthAIStatus() !== 'ready') {
        if (!hasAIConsent()) {
          const ok = await confirmDepthDownload();
          if (!ok) { store.set('depth.source', 'brightness'); return false; }
          saveAIConsent();
        }
      }
      store.set('depth.source', 'ai');
      if (depthAIStatus() === 'ready') { scheduler.markDirty(); return true; }
      const label = (p) => t('depth.loading', { pct: Math.round(p * 100) });
      viewer.setBusy(true, label(0));
      try {
        await loadDepthAI({ onProgress: (p) => { if (!exporting) viewer.setBusy(true, label(p)); } });
        toast(t('depth.ready'));
        scheduler.markDirty();
        return true;
      } catch (err) {
        console.warn('[dither] AI depth unavailable', err);
        toastError(t(err?.message === 'timeout' ? 'depth.timeout' : 'depth.failed'));
        store.set('depth.source', 'brightness');
        return false;
      } finally {
        if (!exporting) viewer.setBusy(false);
      }
    })().finally(() => { aiRequest = null; });
    return aiRequest;
  }
  /** A remembered / shared state can ask for AI depth: load it (asking first) when a depth mode is on screen. */
  function syncDepthAI() {
    if (!active || !source) return;
    if (mode().uses.includes('depth') && store.state.depth.source === 'ai' && depthAIStatus() !== 'ready') enableDepthAI();
  }

  // ---- 3D camera gestures (PLAN.md 4.6): drag = orbit, Shift + drag = pan, wheel = distance ----
  // The store keeps the camera at the precision of each slider (1° for yaw / pitch); gestures move a float copy, so
  // slow drags of a pixel at a time still add up. The copy follows the store whenever the store changed elsewhere.
  const camFloat = {};
  const camParams = () => {
    const p = store.state.modes[store.state.modeId];
    const out = {};
    for (const k of ['yaw', 'pitch', 'distance', 'panX', 'panY']) {
      const f = camFloat[k];
      out[k] = f && f.mode === store.state.modeId && f.stored === p[k] ? f.value : p[k];
    }
    return out;
  };
  const setCam = (vals) => {
    for (const [k, v] of Object.entries(vals)) {
      store.set(`modes.${store.state.modeId}.${k}`, v);
      camFloat[k] = { mode: store.state.modeId, value: v, stored: store.state.modes[store.state.modeId][k] };
    }
  };
  const cameraHandler = {
    orbit: (dx, dy) => setCam(orbitBy(camParams(), dx, dy)),
    pan: (dx, dy, size) => setCam(panBy(camParams(), dx, dy, size)),
    dolly: (dy) => setCam(dollyBy(camParams(), dy)),
  };
  const syncCamera = () => viewer.setCameraHandler(mode().camera ? cameraHandler : null);
  syncCamera();

  const modeList = createModeList({
    listEl: document.getElementById('mode-list'),
    selectEl: document.getElementById('mode-select'),
    onSelect: (id) => { selectMode(id); },
  });
  modeList.setActive(store.state.modeId);

  let movedBefore = false;
  store.subscribe((path) => {
    pipeline.abortPending(); // parameters changed: a heavy job of the previous ones is stale
    if (path === 'modeId') {
      if (!modeAvailable(mode())) { store.setModeId(DEFAULT_MODE_ID); toastWarn(t('err.noWebGL2')); return; }
      autoScale = 1;
      slowFrames = 0;
      syncCamera();
      syncDepthAI();
      modeList.setActive(store.state.modeId);
      controls.rebuild();
      scramble(document.querySelector('[data-group="mode"] .group-title'), t('studio.group.mode', { mode: tl(mode().name) }));
    } else if (path === 'depth.source') {
      controls.refresh();
      syncDepthAI();
    } else if (path === 'replace' || path.startsWith('reset.')) {
      if (path === 'replace') { syncCamera(); syncDepthAI(); }
      modeList.setActive(store.state.modeId);
      if (path === 'replace') controls.rebuild();
      else controls.refresh(true);
    } else {
      controls.refresh();
    }
    // "animate" style toggles change whether the still picture can be exported as video and whether the loop runs
    const moves = modeMoves(mode());
    if (moves !== movedBefore) {
      movedBefore = moves;
      if (path !== 'modeId' && path !== 'replace') controls.rebuildExport();
      scheduler.poke();
    }
    scheduler.markDirty();
  });

  onThemeChange(() => {
    theme = themeOutputColors();
    controls.refresh();
    scheduler.markDirty();
  });

  onLangChange(() => {
    modeList.rebuild();
    controls.rebuild();
  });

  // ---- keyboard shortcuts (PLAN.md 4.7) ----------------------------------------------------------------
  function cycleMode(dir) {
    const list = MODE_META.filter((m) => modeAvailable(m));
    const i = list.findIndex((m) => m.id === store.state.modeId);
    const next = list[(i + dir + list.length) % list.length];
    selectMode(next.id);
    document.querySelector(`#mode-list [data-mode-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  initShortcuts({
    inStudio: () => active && !!source,
    cycleMode,
    resetMode: () => { store.resetGroup('mode'); toast(t('keys.didReset', { mode: tl(mode().name) })); },
    exportImage: () => actions.png(1),
    copy: () => (mode().exports?.includes('txt') ? actions.copyText() : actions.copyImage()),
    fullscreen: () => viewer.toggleFullscreen(),
    split: () => viewer.toggleSplit(),
    surprise: () => surpriseMe(),
  });
  document.getElementById('vw-keys')?.addEventListener('click', () => openShortcutsHelp());

  scheduler.start();

  return {
    store,
    viewer,
    get source() { return source; },

    setSource(next) {
      const old = source;
      activeExport?.abort(); // an export of the old file has nothing left to read
      cancelRecording();
      resumeOnShow = false;
      source = next;
      old?.dispose();
      if (playsAsVideo(next)) {
        next.onFrame = onSourceFrame;
        if (next.kind === 'webcam') {
          // unplugged (or taken by another app) mid-recording: keep what was recorded so far instead of losing it
          next.onEnded = () => { toastWarn(t('cam.ended')); if (recorder) stopRecording(); };
          WebcamSource.listCameras().then((list) => { if (source === next) transport.setCameras(list); });
        }
      }
      transport.setSource(next);
      pipeline.invalidate();
      viewer.reset();
      previewScale = Math.round(dpr());
      lastLogical = { w: 0, h: 0 };
      autoScale = 1;
      slowFrames = 0;
      controls.rebuild();
      scheduler.markDirty();
      syncDepthAI();
    },

    /** The studio only renders while its view is on screen. */
    setActive(on) {
      active = on;
      if (!on) suspendPlayback();
      else resumePlayback();
      if (on) {
        controls.refresh();
        scheduler.markDirty(); // the viewer refits by itself when it was in "fit" mode and its box changed
        syncDepthAI();
      }
      scheduler.poke();
    },

    mount() {
      controls.rebuild();
      notices.splice(0).forEach((fn) => fn());
    },

    actions,
    scheduler,
    applyPreset,
    selectMode,
    surprise: surpriseMe,
  };
}
