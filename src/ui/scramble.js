// "Scramble" micro-interaction (PLAN.md 4.2): text resolves from random characters in <= 300 ms.

const GLYPHS = '#%@*+=-:.<>/\\|[]{}01';

export function scramble(el, finalText, ms = 280) {
  if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (el) el.textContent = finalText;
    return;
  }
  const chars = Array.from(finalText);
  const start = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - start) / ms);
    const settled = Math.floor(k * chars.length);
    el.textContent = chars
      .map((c, i) => (i < settled || c === ' ' ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]))
      .join('');
    if (k < 1) requestAnimationFrame(tick);
    else el.textContent = finalText;
  };
  requestAnimationFrame(tick);
}
