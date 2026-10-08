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
})();
