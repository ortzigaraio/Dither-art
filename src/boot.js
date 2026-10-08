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

  // Safety net: if the app has not started after a few seconds (blocked script, very old browser, a bug at load time)
  // say so instead of leaving a page that looks alive but does nothing.
  setTimeout(function () {
    if (root.getAttribute('data-ready') === 'true' || !document.body) return;
    var box = document.createElement('p');
    box.className = 'noscript';
    box.setAttribute('role', 'alert');
    box.textContent = lang === 'es'
      ? 'Dither no ha podido arrancar. Recarga la página o usa una versión reciente de tu navegador.'
      : 'Dither could not start. Reload the page or use an up-to-date browser.';
    document.body.insertBefore(box, document.body.firstChild);
  }, 6000);
})();
