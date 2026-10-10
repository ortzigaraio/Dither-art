// mm:ss for durations (transport, input panel, export dialog). Kept apart from exportVideo.js so the boot path
// does not need the video export code.
export function formatClock(seconds) {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
