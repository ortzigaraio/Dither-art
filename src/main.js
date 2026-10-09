// Entry point: global error handlers, i18n, theme, views, dropzone and source loading.

import { t, initI18n, onLangChange } from './i18n/i18n.js';
import { initHeader, setActiveNav } from './ui/header.js';
import { initDropzone } from './ui/dropzone.js';
import { toast, toastError, toastWarn } from './ui/toast.js';
import { createHome } from './ui/hero.js';
import { createStudio } from './studio.js';
import { initVisitCounter } from './ui/visitCounter.js';
import { MODES } from './modes/index.js';
import { LIMITS } from './config.js';
import { blueNoise } from './engine/dither.js';
import { validateFile, FileError } from './io/validate.js';
import { ImageSource, VideoSource, WebcamSource, DemoSource } from './io/sources.js';

// ---------------------------------------------------------------------------
// Global error handlers (PLAN.md 18.2): never leave the page blank.
// ---------------------------------------------------------------------------
function installGlobalErrorHandlers() {
  const report = (err) => {
    console.error('[dither]', err);
    toastError(t('err.unexpected'));
  };
  window.addEventListener('error', (ev) => {
    // Benign browser notice, not a bug in the app
    if (typeof ev.message === 'string' && ev.message.startsWith('ResizeObserver loop')) return;
    if (!ev.error && !ev.message) return;
    report(ev.error || ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => report(ev.reason));
}
installGlobalErrorHandlers();

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

const app = {
  source: null,
  view: 'home',
  studio: null,
  home: null,
  dropzone: null,
};

function setView(view) {
  app.view = view;
  document.body.dataset.view = view;
  $('#home').hidden = view !== 'home';
  $('#studio').hidden = view !== 'studio';
  document.body.classList.toggle('has-source', !!app.source);
  setActiveNav(view === 'studio' ? 'studio' : null);
  app.studio?.setActive(view === 'studio');
  app.home?.setActive(view === 'home');
}

function scrollToHash(id) {
  const el = document.getElementById(id);
  if (!el || el.hidden) return;
  el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function navigate(target) {
  if (target === 'studio') {
    if (app.source) {
      setView('studio');
    } else {
      setView('home');
      const zone = $('#dropzone');
      zone.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('#dz-pick').focus({ preventScroll: true });
    }
    return;
  }
  if (app.view !== 'home') setView('home');
  requestAnimationFrame(() => scrollToHash(target));
}

function setSource(source) {
  app.source = source;
  app.studio.setSource(source); // the studio disposes the previous source
  setView('studio');
}

function fileErrorMessage(err) {
  if (err instanceof FileError) return t(`err.${err.code}`, err.vars);
  return t('err.decode');
}

let loadToken = 0;
async function openFile(file) {
  const token = ++loadToken;
  try {
    const info = await validateFile(file);
    if (info.kind === 'video') {
      if (info.warnings.includes('bigVideo')) toast(t('info.bigVideo'));
      const video = await VideoSource.fromFile(file, info);
      if (token !== loadToken) {
        video.dispose();
        return;
      }
      if (Number.isFinite(video.duration) && video.duration > LIMITS.videoWarnSeconds) {
        toastWarn(t('info.longVideo', { min: Math.round(LIMITS.videoWarnSeconds / 60) }));
      }
      setSource(video);
      video.play();
      return;
    }
    const source = await ImageSource.fromFile(file, info);
    if (token !== loadToken) {
      source.dispose();
      return;
    }
    if (info.warnings.includes('gifFirstFrame')) toast(t('info.gifFirstFrame'));
    if (source.downscaled) toast(t('info.downscaled', { px: Math.max(source.width, source.height) }));
    setSource(source);
  } catch (err) {
    if (!(err instanceof FileError)) console.warn('[dither] could not open file:', err);
    toastError(fileErrorMessage(err));
  }
}

async function openCamera() {
  const token = ++loadToken;
  try {
    const cam = await WebcamSource.open();
    if (token !== loadToken) {
      cam.dispose();
      return;
    }
    setSource(cam);
  } catch (err) {
    if (!(err instanceof FileError)) console.warn('[dither] camera failed', err);
    toastError(fileErrorMessage(err));
  }
}

async function openDemo() {
  const token = ++loadToken;
  const source = await DemoSource.create({ animated: false });
  if (token !== loadToken) {
    source.dispose();
    return;
  }
  setSource(source);
}

function updateHeroSub() {
  const n = MODES.length;
  $('#hero-sub').textContent = t(n === 1 ? 'hero.sub.one' : 'hero.sub', { n });
}

async function openMode(modeId) {
  app.studio.store.setModeId(modeId);
  if (app.source) setView('studio');
  else await openDemo();
}

function boot() {
  initI18n();
  app.studio = createStudio({ onChangeFile: () => app.dropzone.openPicker() });
  app.home = createHome({ onOpenMode: openMode });
  initHeader({ onNavigate: navigate });
  app.dropzone = initDropzone({ onFile: openFile, onDemo: openDemo });
  // No getUserMedia (old browser, insecure origin): no camera button (PLAN.md 18.2)
  if (navigator.mediaDevices?.getUserMedia) {
    app.dropzone.addAction({ id: 'camera', labelKey: 'dz.camera', run: openCamera });
  }
  updateHeroSub();
  onLangChange(updateHeroSub);
  app.studio.mount();
  setView('home');
  app.home.init().catch((err) => console.warn('[dither] home init failed', err));
  document.documentElement.dataset.ready = 'true';
  // Visit counter (PLAN.md 17): hidden without a Worker URL; any failure keeps it hidden, silently
  initVisitCounter(document.getElementById('visit-counter')).catch(() => {});
  // Build the 64x64 blue-noise table (about 60 ms) while the browser is idle instead of on first use
  (window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(() => blueNoise(), { timeout: 4000 });
}

boot();
