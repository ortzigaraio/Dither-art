// Studio controller: ties state, controls, viewer, pipeline, scheduler and exports together.
// main.js only boots the page and decides which view is visible.

import { t, tl, onLangChange } from './i18n/i18n.js';
import { createStore, decodeShareHash } from './state.js';
import { getMode, modeAvailable, MODES } from './modes/index.js';
import { createPipeline } from './engine/pipeline.js';
import { cropRect } from './engine/preprocess.js';
import { createScheduler } from './scheduler.js';
import { createViewer } from './ui/viewer.js';
import { createControls } from './ui/controls.js';
import { createModeList } from './ui/modeList.js';
import { createExportGroup } from './ui/exportPanel.js';
import { createInputGroup, describeSource } from './ui/inputPanel.js';
import { createTransport } from './ui/transport.js';
import { openExportDialog } from './ui/exportDialog.js';
import * as vx from './io/exportVideo.js';
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

const AI_CONSENT_KEY = 'horain.depthAI';
const hasAIConsent = () => { try { return localStorage.getItem(AI_CONSENT_KEY) === '1'; } catch { return false; } };
const saveAIConsent = () => { try { localStorage.setItem(AI_CONSENT_KEY, '1'); } catch { /* storage blocked: ask again next time */ } };

const isMobile = () => window.matchMedia('(max-width: 699px)').matches;

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
  let autoScale = 1;
  let slowFrames = 0;
  let exporting = false;
  let activeExport = null;   // { abort() } of the running video export
  let recorder = null;       // { rec, t0 } while the webcam is being recorded
  let resumeOnShow = false;  // playback to restart when the tab or the view comes back
  let exportSeq = 0;
  // GPU modes need WebGL2: a remembered or shared state may point at one this browser cannot run (PLAN.md 18.2)
  if (!modeAvailable(getMode(store.state.modeId))) {
    store.state.modeId = MODES[0].id;
    notices.push(() => toastWarn(t('err.noWebGL2')));
  }

  const mode = () => getMode(store.state.modeId);
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
  const pipeline = createPipeline({ onInvalidate: () => scheduler.markDirty(), onContextEvent });
  let exportPipeline = null;
  const getExportPipeline = () => exportPipeline || (exportPipeline = createPipeline());

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

    lastLogical = { w: result.width / result.outScale, h: result.height / result.outScale };
    viewer.present(result, {
      drawOriginal: (g, w, h) => {
        const crop = cropRect(store.state.global, source.width, source.height);
        g.save();
        if (store.state.global.flipX) { g.translate(w, 0); g.scale(-1, 1); }
        g.drawImage(source.frame(time), crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
        g.restore();
      },
    });
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
      exporting = false;
      viewer.setBusy(false);
    }
  }

  const exportBase = () => ({
    source, mode: mode(), params: paramsNow(), time: lastTime, quality: 'full', isExport: true, theme,
  });

  /** Render a full-quality export pass and return { result, state }. */
  async function renderExport(outScale = 1) {
    const pipe = getExportPipeline();
    const base = exportBase();
    const result = await pipe.render({ ...base, outScale });
    if (result.lost) throw new Error('WebGL context lost');
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
      const url = `${location.origin}${location.pathname}${hash}`;
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
  // The loop (and with it the video) sleeps while the tab is hidden (PLAN.md 18.2)
  document.addEventListener('visibilitychange', () => (document.hidden ? suspendPlayback() : resumePlayback()));

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
    const pipe = createPipeline();
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
        const r = await pipe.render({ source: target, mode: m, params, time, quality: 'full', isExport: true, outScale: scale, theme: th });
        if (r.lost) throw new Error('WebGL context lost');
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
      const probe = await renderExport(1);
      const aspect = probe.result.width / probe.result.height;
      const natural = Math.max(2, probe.result.height / (probe.result.outScale || 1));
      const caps = await vx.detectCapabilities(Math.round(natural * aspect), Math.round(natural));
      openExportDialog({
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
    openVideoDialog('live', async (settings, ctl, { caps }) => {
      const rec = await vx.createLiveRecorder({
        format: settings.format, fps: settings.effectiveFps, quality: settings.quality,
        outW: settings.outW, outH: settings.outH, bg: theme.bg,
      }, caps);
      recorder = { rec, t0: performance.now(), mode: mode() };
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
    },
    onAction: (param) => {
      if (param.action === 'depthAI') enableDepthAI();
      else if (Array.isArray(param.resets)) {
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
        toastError(t('depth.failed'));
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
  const camParams = () => store.state.modes[store.state.modeId];
  const setCam = (vals) => { for (const [k, v] of Object.entries(vals)) store.set(`modes.${store.state.modeId}.${k}`, v); };
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
    onSelect: (id) => store.setModeId(id),
  });
  modeList.setActive(store.state.modeId);

  let movedBefore = false;
  store.subscribe((path) => {
    pipeline.abortPending(); // parameters changed: a heavy job of the previous ones is stale
    if (path === 'modeId') {
      if (!modeAvailable(mode())) { store.setModeId(MODES[0].id); toastWarn(t('err.noWebGL2')); return; }
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
          next.onEnded = () => { toastWarn(t('cam.ended')); cancelRecording(); };
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
  };
}
