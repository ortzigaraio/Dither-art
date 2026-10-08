// Viewer (Phase 0 version: shows the source unprocessed, fitted to the viewport).
// Phase 1 replaces this with the full viewer (zoom/pan/split/stats).

export function createViewer() {
  const viewport = document.getElementById('viewer-viewport');
  const world = document.getElementById('viewer-world');
  const canvas = document.getElementById('viewer-canvas');
  const ctx = canvas.getContext('2d');
  let size = { w: 0, h: 0 };

  function fit() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!size.w || !vw || !vh) return;
    const k = Math.min((vw - 48) / size.w, (vh - 48) / size.h, 1);
    const s = Math.max(0.05, k);
    world.style.transform = `translate(${(vw - size.w * s) / 2}px, ${(vh - size.h * s) / 2}px) scale(${s})`;
  }

  new ResizeObserver(fit).observe(viewport);

  return {
    showSource(source) {
      size = { w: source.width, h: source.height };
      canvas.width = size.w;
      canvas.height = size.h;
      canvas.style.width = `${size.w}px`;
      canvas.style.height = `${size.h}px`;
      world.style.width = `${size.w}px`;
      world.style.height = `${size.h}px`;
      ctx.clearRect(0, 0, size.w, size.h);
      ctx.drawImage(source.frame(0), 0, 0, size.w, size.h);
      fit();
    },
    fit,
  };
}
