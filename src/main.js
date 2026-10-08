// Entry point: global error handlers, i18n, theme, views, dropzone and source loading.

import { t, initI18n, onLangChange } from './i18n/i18n.js';
import { initHeader, setActiveNav } from './ui/header.js';
import { initDropzone } from './ui/dropzone.js';
import { toast, toastError, toastWarn } from './ui/toast.js';
import { createViewer } from './ui/viewer.js';
import { createInputGroup } from './ui/inputPanel.js';
import { validateFile, FileError } from './io/validate.js';
import { ImageSource, DemoSource } from './io/sources.js';

// ---------------------------------------------------------------------------
// Global error handlers (PLAN.md 18.2): never leave the page blank.
// ---------------------------------------------------------------------------
function installGlobalErrorHandlers() {
  const report = (err) => {
    console.error('[horain]', err);
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
  viewer: null,
  dropzone: null,
};

function setView(view) {
  app.view = view;
  document.body.dataset.view = view;
  $('#home').hidden = view !== 'home';
  $('#studio').hidden = view !== 'studio';
  document.body.classList.toggle('has-source', !!app.source);
  setActiveNav(view === 'studio' ? 'studio' : null);
  if (view === 'studio') requestAnimationFrame(() => app.viewer?.fit());
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

function renderInputPanel() {
  const host = $('#controls');
  host.textContent = '';
  if (app.source) host.appendChild(createInputGroup(app.source, { onChange: () => app.dropzone.openPicker() }));
}

function setSource(source) {
  const old = app.source;
  app.source = source;
  old?.dispose();
  renderInputPanel();
  app.viewer.showSource(source);
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
      toastWarn(t('err.videoSoon'));
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
    if (!(err instanceof FileError)) console.warn('[horain] could not open file:', err);
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
  const n = 1;
  $('#hero-sub').textContent = t(n === 1 ? 'hero.sub.one' : 'hero.sub', { n });
}

function boot() {
  initI18n();
  app.viewer = createViewer();
  initHeader({ onNavigate: navigate });
  app.dropzone = initDropzone({ onFile: openFile, onDemo: openDemo });
  updateHeroSub();
  onLangChange(() => {
    updateHeroSub();
    renderInputPanel();
  });
  setView('home');
  document.documentElement.dataset.ready = 'true';
}

boot();
