// Classic (non-module) script that runs before first paint so the saved theme/language
// are applied without a flash. External file because the CSP forbids inline scripts.
(function () {
  var tones = { horain: 'dark', claro: 'light', amber: 'dark', crt: 'dark', paper: 'light', cad: 'dark' };
  var root = document.documentElement;
  var theme = null;
  var lang = null;
  try {
    theme = localStorage.getItem('horain.theme');
    lang = localStorage.getItem('horain.lang');
  } catch (e) { /* storage blocked: fall through to defaults */ }
  if (!theme || !tones[theme]) {
    theme = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'claro' : 'horain';
  }
  if (lang !== 'es' && lang !== 'en') {
    lang = (navigator.language || 'en').toLowerCase().indexOf('es') === 0 ? 'es' : 'en';
  }
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-tone', tones[theme]);
  root.setAttribute('lang', lang);

  // Safety net (PLAN.md 18.2): say so when the app really failed to start, instead of leaving a page that looks
  // alive but does nothing. A real failure (a module that fails to load or throws while loading) shows the notice
  // at once, with the reason; a merely slow start (first visit on a slow connection) only after 20 s. If the app
  // starts after all, the notice goes away.
  var notice = null;
  var firstError = '';
  function ready() { return root.getAttribute('data-ready') === 'true'; }
  function showNotice() {
    if (notice || ready() || !document.body) return;
    notice = document.createElement('p');
    notice.className = 'noscript';
    notice.setAttribute('role', 'alert');
    notice.textContent = (lang === 'es'
      ? 'Dither no ha podido arrancar. Recarga la página o usa una versión reciente de tu navegador.'
      : 'Dither could not start. Reload the page or use an up-to-date browser.')
      + (firstError ? ' (' + firstError + ')' : '');
    document.body.insertBefore(notice, document.body.firstChild);
  }
  function onError(e) {
    if (ready()) return;
    var t = e && e.target;
    if (t && t.tagName === 'SCRIPT') {
      firstError = firstError || ('load failed: ' + String(t.src || '').split('/').slice(-2).join('/'));
    } else if (e && e.message) {
      firstError = firstError || String(e.message).slice(0, 160);
    } else {
      return;
    }
    // a failed module never sets data-ready: give the rest of the graph a moment, then explain
    setTimeout(showNotice, 1500);
  }
  window.addEventListener('error', onError, true);
  setTimeout(showNotice, 20000);
  if (window.MutationObserver) {
    new MutationObserver(function () {
      if (!ready()) return;
      window.removeEventListener('error', onError, true);
      if (notice && notice.parentNode) notice.parentNode.removeChild(notice);
      notice = null;
    }).observe(root, { attributes: true, attributeFilter: ['data-ready'] });
  }
})();
