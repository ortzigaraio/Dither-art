// Test double of src/workers/depth.worker.js (same protocol, no network). Behaviour from the query string:
//   ?fail=load   loading fails       ?fail=run   inference fails       ?delay=ms   delay of each progress step
// The "depth" it returns is a left-to-right ramp (raw values 10..40, the client normalises them), which is easy to tell
// apart from brightness.
const q = new URLSearchParams(self.location.search);
const fail = q.get('fail') || '';
const delay = Number(q.get('delay') || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
let runs = 0;

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      self.postMessage({ type: 'progress', progress: p, loaded: p * 27e6, total: 27e6, file: 'onnx/model_quantized.onnx' });
      await sleep(delay);
    }
    if (fail === 'load') { self.postMessage({ type: 'error', message: 'mock: network unreachable' }); return; }
    ready = true;
    self.postMessage({ type: 'ready', device: 'mock', dtype: 'q8' });
  } else if (m.type === 'run') {
    runs++;
    if (!ready || fail === 'run') { self.postMessage({ type: 'error', jobId: m.jobId, message: 'mock: inference failed' }); return; }
    const w = m.width;
    const h = m.height;
    const d = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = 10 + 30 * (x / Math.max(1, w - 1));
    await sleep(5);
    self.postMessage({ type: 'result', jobId: m.jobId, width: w, height: h, depth: d.buffer, runs }, [d.buffer]);
  }
};
