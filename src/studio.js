// Studio controller: ties state, controls, viewer, pipeline, scheduler and exports together.
// main.js only boots the page and decides which view is visible.

import { t, tl, onLangChange } from './i18n/i18n.js';
import { createStore, decodeShareHash } from './state.js';
import { getMode } from './modes/index.js';
import { createPipeline } from './engine/pipeline.js';
import { cropRect } from './engine/preprocess.js';
import { createScheduler } from './scheduler.js';
import { createViewer } from './ui/viewer.js';
import { createControls } from './ui/controls.js';
import { createModeList } from './ui/modeList.js';
import { createExportGroup } from './ui/exportPanel.js';
import { createInputGroup } from './ui/inputPanel.js';
import { themeOutputColors, onThemeChange } from './ui/header.js';
import { scramble } from './ui/scramble.js';
import { toast, toastError, toastWarn } from './ui/toast.js';
import { exportName, downloadBlob } from './io/download.js';
import { canvasToBlob, fitExportScale, shrinkToLimit, copyImageBlob, copyText } from './io/exportImage.js';
import { LIMITS } from './config.js';

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
  const pipeline = createPipeline({ onInvalidate: () => scheduler.markDirty() });
  let exportPipeline = null;
  const getExportPipeline = () => exportPipeline || (exportPipeline = createPipeline());

  const viewer = createViewer({ onZoomChange: onZoom });

  async function renderFrame(nowSec) {
    if (!source) return;
    const m = mode();
    const animated = !!(source.animated || m.animated);
    const time = animated ? nowSec : 0;
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
    isAnimated: () => active && !!source && !!(source.animated || mode().animated),
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
      console.warn('[horain] export failed', err);
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
      const text = m.toText(state, format, opts);
      const ext = format === 'ansi' ? 'ansi.txt' : format;
      const type = format === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
      const name = downloadBlob(new Blob([text], { type }), exportName(m.id, ext));
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

    share: async () => {
      const hash = store.shareHash();
      try { history.replaceState(null, '', hash); } catch { /* sandboxed frame */ }
      const url = `${location.origin}${location.pathname}${hash}`;
      if (await copyText(url)) toast(t('export.shareCopied'));
      else toastWarn(t('export.shareFailed'));
    },
  };

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
      export: () => createExportGroup(mode(), actions),
    },
  });

  const modeList = createModeList({
    listEl: document.getElementById('mode-list'),
    selectEl: document.getElementById('mode-select'),
    onSelect: (id) => store.setModeId(id),
  });
  modeList.setActive(store.state.modeId);

  store.subscribe((path) => {
    if (path === 'modeId') {
      autoScale = 1;
      slowFrames = 0;
      modeList.setActive(store.state.modeId);
      controls.rebuild();
      scramble(document.querySelector('[data-group="mode"] .group-title'), t('studio.group.mode', { mode: tl(mode().name) }));
    } else if (path === 'replace' || path.startsWith('reset.')) {
      modeList.setActive(store.state.modeId);
      if (path === 'replace') controls.rebuild();
      else controls.refresh(true);
    } else {
      controls.refresh();
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
      source = next;
      old?.dispose();
      pipeline.invalidate();
      viewer.reset();
      previewScale = Math.round(dpr());
      lastLogical = { w: 0, h: 0 };
      autoScale = 1;
      slowFrames = 0;
      controls.rebuild();
      scheduler.markDirty();
    },

    /** The studio only renders while its view is on screen. */
    setActive(on) {
      active = on;
      if (on) {
        controls.refresh();
        viewer.fit();
        scheduler.markDirty();
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
