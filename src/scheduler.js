// Render scheduler (PLAN.md 5.7): renders only when something changed ("dirty"), when the source or the
// mode is animated, and never while the tab is hidden or the viewer is off screen. One frame in flight at a time.

export function createScheduler({ render, isAnimated = () => false, isActive = () => true, maxFps = 0 }) {
  let dirty = true;
  let raf = 0;
  let inflight = false;
  let lastRun = 0;
  let fps = 0;
  let stopped = true;

  function schedule() {
    if (stopped || raf) return;
    raf = requestAnimationFrame(frame);
  }

  async function frame(now) {
    raf = 0;
    if (stopped) return;
    if (document.hidden || !isActive() || inflight) {
      // Keep polling while there is pending work so we resume as soon as we can
      if (dirty || isAnimated()) schedule();
      return;
    }
    const animated = isAnimated();
    if (!dirty && !animated) return;
    if (!dirty && animated && maxFps > 0 && now - lastRun < 1000 / maxFps - 1) {
      schedule();
      return;
    }
    dirty = false;
    inflight = true;
    const started = now;
    try {
      await render(now / 1000);
    } catch (err) {
      console.error('[horain] render loop error', err);
    } finally {
      inflight = false;
      if (lastRun) {
        const dt = started - lastRun;
        if (dt > 0) fps = fps ? fps * 0.8 + (1000 / dt) * 0.2 : 1000 / dt;
      }
      lastRun = started;
      if (dirty || isAnimated()) schedule();
    }
  }

  const onVisibility = () => { if (!document.hidden) schedule(); };

  return {
    markDirty() {
      dirty = true;
      schedule();
    },
    start() {
      if (!stopped) return;
      stopped = false;
      document.addEventListener('visibilitychange', onVisibility);
      schedule();
    },
    stop() {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    /** Wake the loop after isActive()/isAnimated() changed. */
    poke() { schedule(); },
    /** Smoothed frames per second while animating (0 when idle). */
    get fps() {
      return performance.now() - lastRun < 1500 ? fps : 0;
    },
  };
}
