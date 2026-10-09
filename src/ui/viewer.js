// Viewer (PLAN.md 4.6): output canvas with zoom (10%..800%) and pan, before/after split, fullscreen,
// stats line, quality/error chips and the busy overlay.

import { t } from '../i18n/i18n.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const FIT_PADDING = 32;

export function createViewer({ onZoomChange } = {}) {
  const root = document.getElementById('viewer');
  const viewport = document.getElementById('viewer-viewport');
  const world = document.getElementById('viewer-world');
  const canvas = document.getElementById('viewer-canvas');
  const original = document.getElementById('viewer-original');
  const handle = document.getElementById('split-handle');
  const zoomLabel = document.getElementById('vw-zoom');
  const statsEl = document.getElementById('viewer-stats');
  const chipAuto = document.getElementById('chip-auto');
  const chipError = document.getElementById('chip-error');
  const busy = document.getElementById('viewer-busy');
  const busyText = document.getElementById('busy-text');
  const btnFit = document.getElementById('vw-fit');
  const btn1to1 = document.getElementById('vw-1to1');
  const btnSplit = document.getElementById('vw-split');
  const btnFull = document.getElementById('vw-full');
  const btnCamera = document.getElementById('vw-camera');

  const ctx = canvas.getContext('2d');
  const octx = original.getContext('2d');

  // View state: world is `logical` CSS px at zoom 1, positioned by (tx, ty) and scaled by `zoom`
  const view = { zoom: 1, tx: 0, ty: 0, fit: true };
  let logical = { w: 0, h: 0 };
  let split = 50;
  let splitOn = false;
  let renderCount = 0;
  let drawOriginal = null;
  let visible = true;
  // 3D modes: drag = orbit, Shift + drag = pan, wheel = camera distance, while the camera toggle is on (PLAN.md 4.6)
  let cameraHandler = null; // { orbit(dx, dy), pan(dx, dy, viewportHeight), dolly(deltaY) }
  let cameraOn = true;
  const cameraActive = () => !!cameraHandler && cameraOn;

  // ---- transform ------------------------------------------------------------
  function apply() {
    world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`;
    world.style.setProperty('--zoom', String(view.zoom));
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
    onZoomChange?.(view.zoom);
  }

  function fitZoom() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!logical.w || !vw || !vh) return 1;
    const k = Math.min((vw - FIT_PADDING * 2) / logical.w, (vh - FIT_PADDING * 2) / logical.h);
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
  }

  function center() {
    view.tx = (viewport.clientWidth - logical.w * view.zoom) / 2;
    view.ty = (viewport.clientHeight - logical.h * view.zoom) / 2;
  }

  function fit() {
    view.fit = true;
    view.zoom = fitZoom();
    center();
    apply();
  }

  function setZoom(z, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2, keepFit = false) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    // Keep the point under (cx, cy) fixed
    const wx = (cx - view.tx) / view.zoom;
    const wy = (cy - view.ty) / view.zoom;
    view.zoom = next;
    view.tx = cx - wx * next;
    view.ty = cy - wy * next;
    view.fit = keepFit;
    apply();
  }

  function oneToOne() {
    setZoom(1);
    center();
    apply();
  }

  new ResizeObserver(() => {
    if (view.fit) fit();
  }).observe(viewport);

  // ---- pan / zoom gestures -----------------------------------------------------
  const pointers = new Map();
  let pinchStart = null;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.target === handle || handle.contains(e.target)) return;
    viewport.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (cameraActive()) { viewport.classList.add('is-orbiting'); return; }
    if (pointers.size === 1) viewport.classList.add('is-panning');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
    }
  });
  viewport.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (cameraActive()) {
      if (pointers.size === 1 && (dx || dy)) {
        if (e.shiftKey) cameraHandler.pan(dx, dy, viewport.clientHeight);
        else cameraHandler.orbit(dx, dy);
      }
      return;
    }
    if (pointers.size === 1) {
      view.tx += dx;
      view.ty += dy;
      view.fit = false;
      apply();
    } else if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const rect = viewport.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - rect.left;
      const my = (a.y + b.y) / 2 - rect.top;
      setZoom(pinchStart.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist), mx, my);
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) viewport.classList.remove('is-panning', 'is-orbiting');
  };
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (cameraActive()) {
      cameraHandler.dolly(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    setZoom(view.zoom * k, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  viewport.addEventListener('dblclick', (e) => {
    if (e.target === handle || cameraActive()) return;
    fit();
  });

  viewport.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') { setZoom(view.zoom * 1.25); e.preventDefault(); }
    else if (e.key === '-' || e.key === '_') { setZoom(view.zoom / 1.25); e.preventDefault(); }
    else if (e.key === '0') { fit(); e.preventDefault(); }
    else if (e.key.startsWith('Arrow')) {
      const step = 40;
      if (e.key === 'ArrowLeft') view.tx += step;
      if (e.key === 'ArrowRight') view.tx -= step;
      if (e.key === 'ArrowUp') view.ty += step;
      if (e.key === 'ArrowDown') view.ty -= step;
      view.fit = false;
      apply();
      e.preventDefault();
    }
  });

  // ---- split (before / after) ------------------------------------------------------
  function applySplit() {
    world.style.setProperty('--split', `${split}%`);
    handle.setAttribute('aria-valuenow', String(Math.round(split)));
  }
  function setSplit(on) {
    splitOn = on;
    root.classList.toggle('is-split', on);
    handle.hidden = !on;
    btnSplit.setAttribute('aria-pressed', String(on));
    if (on) { applySplit(); redrawOriginal(); }
  }
  function redrawOriginal() {
    if (!splitOn || !drawOriginal || !logical.w) return;
    original.width = canvas.width;
    original.height = canvas.height;
    original.style.width = canvas.style.width;
    original.style.height = canvas.style.height;
    octx.clearRect(0, 0, original.width, original.height);
    drawOriginal(octx, original.width, original.height);
  }

  let draggingSplit = false;
  handle.addEventListener('pointerdown', (e) => {
    draggingSplit = true;
    handle.setPointerCapture(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!draggingSplit) return;
    const rect = world.getBoundingClientRect();
    split = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
    applySplit();
  });
  const endSplit = () => { draggingSplit = false; };
  handle.addEventListener('pointerup', endSplit);
  handle.addEventListener('pointercancel', endSplit);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') split = Math.max(0, split - 2);
    else if (e.key === 'ArrowRight') split = Math.min(100, split + 2);
    else return;
    applySplit();
    e.preventDefault();
  });

  // ---- toolbar ----------------------------------------------------------------------
  btnFit.addEventListener('click', fit);
  btn1to1.addEventListener('click', oneToOne);
  btnSplit.addEventListener('click', () => setSplit(!splitOn));
  function syncCameraButton() {
    btnCamera.hidden = !cameraHandler;
    btnCamera.setAttribute('aria-pressed', String(cameraOn));
    root.classList.toggle('is-camera', cameraActive());
  }
  btnCamera.addEventListener('click', () => {
    cameraOn = !cameraOn;
    syncCameraButton();
  });
  btnFull.addEventListener('click', () => toggleFullscreen());
  btnFull.hidden = !root.requestFullscreen;

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else root.requestFullscreen?.().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    if (view.fit) requestAnimationFrame(fit);
  });

  // Pause rendering while the viewer is off screen
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; }).observe(viewport);
  }

  return {
    /** Draw a pipeline result. `result.outScale` converts bitmap pixels to logical (CSS) pixels. */
    present(result, { drawOriginal: draw } = {}) {
      const k = result.outScale || 1;
      const lw = Math.max(1, Math.round(result.width / k));
      const lh = Math.max(1, Math.round(result.height / k));
      const resized = canvas.width !== result.width || canvas.height !== result.height;
      if (resized) {
        canvas.width = result.width;
        canvas.height = result.height;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(result.canvas, 0, 0);
      canvas.style.width = `${lw}px`;
      canvas.style.height = `${lh}px`;
      world.style.width = `${lw}px`;
      world.style.height = `${lh}px`;
      world.classList.toggle('is-transparent', !!result.transparent);
      const sizeChanged = lw !== logical.w || lh !== logical.h;
      logical = { w: lw, h: lh };
      drawOriginal = draw || null;
      if (splitOn) redrawOriginal();
      if (sizeChanged) {
        if (view.fit) fit();
        else apply();
      }
      renderCount++;
      canvas.dataset.frame = String(renderCount);
      canvas.dataset.cols = String(result.meta?.cols ?? result.workWidth);
      canvas.dataset.rows = String(result.meta?.rows ?? result.workHeight);
      canvas.dataset.outScale = String(k);
      canvas.dataset.depth = result.meta?.depthSource || ''; // 3D modes: which depth source drew this frame
      // simulations: simulated seconds since the seed (what a PNG export reproduces)
      canvas.dataset.simTime = Number.isFinite(result.meta?.exportTime) ? result.meta.exportTime.toFixed(3) : '';
    },

    /** `res` = "160×72" text, plus fps (0 hides it) and render milliseconds. */
    setStats({ res, fps = 0, ms }) {
      const parts = [res];
      if (fps > 0) parts.push(`${Math.round(fps)} fps`);
      if (ms != null) parts.push(`${Math.max(1, Math.round(ms))} ms`);
      statsEl.textContent = parts.join(' · ');
    },

    setChips({ auto = false, error = false }) {
      chipAuto.hidden = !auto;
      chipError.hidden = !error;
    },

    setBusy(on, text = '') {
      busy.hidden = !on;
      busyText.textContent = on ? (text || t('viewer.rendering')) : '';
    },

    /** New source: forget the manual zoom and fit again. */
    reset() {
      view.fit = true;
      logical = { w: 0, h: 0 };
    },

    /** 3D modes: route drag / Shift-drag / wheel to the camera (null = normal zoom and pan). */
    setCameraHandler(h) {
      cameraHandler = h || null;
      syncCameraButton();
    },
    /** Camera interaction on/off (the toolbar toggle); viewer zoom and pan work when it is off. */
    setCameraMode(on) {
      cameraOn = !!on;
      syncCameraButton();
    },
    get cameraActive() { return cameraActive(); },

    fit,
    setZoom,
    setSplit,
    toggleSplit: () => setSplit(!splitOn),
    toggleFullscreen,
    get zoom() { return view.zoom; },
    get splitOn() { return splitOn; },
    get visible() { return visible && viewport.clientWidth > 0; },
    canvas,
    viewport,
  };
}
