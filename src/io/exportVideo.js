// Video export (PLAN.md 9.2). Three jobs share one set of settings:
//   exportFromFile    a video file, rendered offline frame by frame with Mediabunny `Conversion` (keeps the audio)
//   exportTimeline    a still image + animated mode: frames at i/fps pushed into `CanvasSource` (no input file)
//   createLiveRecorder the webcam: preview frames are pushed as they are rendered
// Each one has a real-time MediaRecorder fallback for browsers without WebCodecs (or without a usable codec).
// Mediabunny is imported on demand: nothing is downloaded until the export dialog opens.
//
// FORMATS is the table to extend when GIF arrives (PLAN.md 16): a new row, and a branch in createSink().

import { LIMITS } from '../config.js';

const MEDIABUNNY_URL = '../../vendor/mediabunny/1.59.1/mediabunny.min.mjs';

export const FORMATS = {
  mp4: {
    ext: 'mp4',
    mime: 'video/mp4',
    codecs: ['avc', 'hevc'],
    audioCodecs: ['aac', 'opus'],
    recorderMimes: ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E'],
    make: (mb) => new mb.Mp4OutputFormat(),
  },
  webm: {
    ext: 'webm',
    mime: 'video/webm',
    codecs: ['vp9', 'vp8', 'av1'],
    audioCodecs: ['opus', 'vorbis'],
    recorderMimes: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
    make: (mb) => new mb.WebMOutputFormat(),
  },
};

/** Quality presets: Mediabunny constant, and rough bits per pixel (size estimates and MediaRecorder bitrates). */
export const QUALITIES = {
  low: { constant: 'QUALITY_LOW', bpp: 0.05 },
  medium: { constant: 'QUALITY_MEDIUM', bpp: 0.09 },
  high: { constant: 'QUALITY_HIGH', bpp: 0.15 },
  veryHigh: { constant: 'QUALITY_VERY_HIGH', bpp: 0.25 },
};

export class ExportCanceled extends Error {
  constructor() {
    super('export canceled');
    this.name = 'ExportCanceled';
  }
}

let mbPromise = null;
/** The vendored library, imported once and only when needed. */
export function loadMediabunny() {
  if (!mbPromise) {
    mbPromise = import(MEDIABUNNY_URL).catch((err) => {
      mbPromise = null;
      throw err;
    });
  }
  return mbPromise;
}

// ---- capabilities --------------------------------------------------------------------------------------------

export const hasWebCodecs = () => typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';

function recorderMime(format) {
  if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return FORMATS[format].recorderMimes.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

/**
 * What this browser can write. `codec[f]`: a WebCodecs encoder for format f (null = none), `recorder[f]`: a
 * MediaRecorder mime type (null = none), `available[f]`: either of them.
 */
export async function detectCapabilities(width = 1280, height = 720) {
  const caps = { webCodecs: hasWebCodecs(), codec: {}, audioCodec: {}, recorder: {}, available: {} };
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  if (caps.webCodecs) {
    try {
      const mb = await loadMediabunny();
      for (const [f, def] of Object.entries(FORMATS)) {
        caps.codec[f] = await mb.getFirstEncodableVideoCodec(def.codecs, { width: even(width), height: even(height) });
        caps.audioCodec[f] = await mb.getFirstEncodableAudioCodec(def.audioCodecs);
      }
    } catch (err) {
      console.warn('[dither] could not probe the encoders', err);
      caps.webCodecs = false;
    }
  }
  for (const f of Object.keys(FORMATS)) {
    caps.codec[f] ??= null;
    caps.recorder[f] = recorderMime(f);
    caps.available[f] = !!(caps.codec[f] || caps.recorder[f]);
  }
  return caps;
}

/** Read what only the container knows: audio present?, exact frame rate, duration. Never throws. */
export async function probeFile(file) {
  if (!hasWebCodecs()) return null;
  let input;
  try {
    const mb = await loadMediabunny();
    input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    let fps = null;
    if (video) {
      try { fps = (await video.computePacketStats(60)).averagePacketRate; } catch { /* keep null */ }
    }
    const duration = await input.computeDuration().catch(() => null);
    return { hasAudio: !!audio, fps: fps && Number.isFinite(fps) ? fps : null, duration };
  } catch {
    return null;
  } finally {
    try { input?.dispose(); } catch { /* ignore */ }
  }
}

// ---- sizes and estimates --------------------------------------------------------------------------------------

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Output size for a render of `aspect` (width / height) whose natural height is `naturalH`.
 * `heightChoice`: 480 | 720 | 1080 | 'original'. Always even, never above LIMITS.maxExportVideoW/H.
 */
export function outputSize(aspect, heightChoice, naturalH) {
  let h = heightChoice === 'original' ? naturalH : Number(heightChoice);
  h = Math.min(h, LIMITS.maxExportVideoH);
  let w = h * aspect;
  if (w > LIMITS.maxExportVideoW) {
    w = LIMITS.maxExportVideoW;
    h = w / aspect;
  }
  return { width: even(w), height: even(h) };
}

/** Rough size and warnings shown in the dialog (PLAN.md 18.2: confirm when > 2 min or > 1080p). */
export function estimateExport({ width, height, fps, quality, duration, includeAudio }) {
  const bpp = (QUALITIES[quality] || QUALITIES.medium).bpp;
  const bits = width * height * fps * bpp + (includeAudio ? 128000 : 0);
  return {
    bytes: Math.round((bits / 8) * duration),
    long: duration > LIMITS.videoWarnSeconds,
    large: height > 1080 || width > 1920,
  };
}

export { formatClock } from './clock.js';

// ---- helpers ------------------------------------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Draw `img` centred and scaled to fit inside the W x H canvas, on a solid background. */
export function drawFit(g, W, H, img, bg = '#000000') {
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const iw = img.width || img.videoWidth;
  const ih = img.height || img.videoHeight;
  if (!iw || !ih) return;
  const k = Math.min(W / iw, H / ih);
  const w = iw * k;
  const h = ih * k;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
let channel = null;
/** Let the browser handle clicks (the cancel button) between two heavy frames. */
function yieldToUi() {
  return new Promise((resolve) => {
    channel ||= new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
}
function makeYielder(everyMs = 30) {
  let last = performance.now();
  return async () => {
    if (performance.now() - last >= everyMs) {
      await yieldToUi();
      last = performance.now();
    }
  };
}

/** Resolves when the tab is visible again (at once if it is), or when `signal` aborts. */
function whenVisible(signal) {
  if (!document.hidden || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      document.removeEventListener('visibilitychange', check);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const check = () => { if (!document.hidden) done(); };
    document.addEventListener('visibilitychange', check);
    signal?.addEventListener('abort', done);
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new ExportCanceled();
}

function bitrateFor(job) {
  return Math.round(job.outW * job.outH * (job.fps || 30) * (QUALITIES[job.quality] || QUALITIES.medium).bpp);
}

// ---- sinks: where finished frames go ------------------------------------------------------------------------

/**
 * A sink owns a W x H canvas. Draw into `canvas`, then `add(t, dur)` (seconds). `finish()` returns the Blob.
 */
async function createMediabunnySink(job, caps) {
  const mb = await loadMediabunny();
  const def = FORMATS[job.format];
  const output = new mb.Output({ format: def.make(mb), target: new mb.BufferTarget() });
  const canvas = makeCanvas(job.outW, job.outH);
  const source = new mb.CanvasSource(canvas, {
    codec: caps.codec[job.format],
    quality: mb[(QUALITIES[job.quality] || QUALITIES.medium).constant],
  });
  output.addVideoTrack(source, { frameRate: job.fps });
  await output.start();
  return {
    route: 'mediabunny',
    canvas,
    add: (t, dur) => source.add(t, dur),
    async finish() {
      await output.finalize();
      const blob = new Blob([output.target.buffer], { type: def.mime });
      output.target.buffer = null;
      canvas.width = canvas.height = 1;
      return blob;
    },
    async cancel() {
      try { await output.cancel(); } catch { /* already finalized */ }
      canvas.width = canvas.height = 1;
    },
  };
}

function createRecorderSink(job, caps, extraTracks = []) {
  const mime = caps.recorder[job.format];
  const canvas = makeCanvas(job.outW, job.outH);
  const manual = typeof CanvasCaptureMediaStreamTrack !== 'undefined' && 'requestFrame' in CanvasCaptureMediaStreamTrack.prototype;
  const stream = canvas.captureStream(manual ? 0 : job.fps);
  const vtrack = stream.getVideoTracks()[0];
  for (const tr of extraTracks) stream.addTrack(tr);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(job) });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(250);
  const stopTracks = () => {
    stream.getTracks().forEach((tr) => tr.stop());
    canvas.width = canvas.height = 1;
  };
  return {
    route: 'recorder',
    canvas,
    recorderMime: mime,
    async add() {
      if (manual) vtrack.requestFrame();
    },
    /** Real time: leave a hidden stretch out of the file (MediaRecorder would otherwise freeze the last frame). */
    pause() { if (rec.state === 'recording') rec.pause(); },
    resume() { if (rec.state === 'paused') rec.resume(); },
    finish() {
      return new Promise((resolve) => {
        rec.onstop = () => {
          stopTracks();
          resolve(new Blob(chunks, { type: mime.split(';')[0] }));
        };
        if (rec.state !== 'inactive') rec.stop();
        else rec.onstop();
      });
    },
    async cancel() {
      rec.ondataavailable = null;
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      stopTracks();
    },
  };
}

// ---- job 1: a video file ---------------------------------------------------------------------------------------

/**
 * @param {object} job
 * @param {File} job.file
 * @param {'mp4'|'webm'} job.format
 * @param {number} job.fps          0 keeps the source frame rate
 * @param {string} job.quality      key of QUALITIES
 * @param {number} job.outW  @param {number} job.outH
 * @param {boolean} job.includeAudio
 * @param {{start:number,end:number}} job.trim  seconds
 * @param {string} job.bg           background behind the picture (transparent margins, letterbox)
 * @param {(time:number, paint:(g:CanvasRenderingContext2D,w:number,h:number)=>void) => Promise<CanvasImageSource>} job.render
 *        renders one frame; `paint` draws the input picture into the engine's working canvas
 * @param {(fraction:number, info:{remaining:number|null})=>void} [job.onProgress]
 * @param {AbortSignal} [job.signal]
 * @param {object} caps result of detectCapabilities()
 * @returns {Promise<{blob:Blob, ext:string, route:string, audioDropped:boolean, fellBack:boolean}>}
 */
export async function exportFromFile(job, caps) {
  throwIfAborted(job.signal);
  // the dialog never offers an empty range (start = end, a 0 s clip); refuse one from any other caller too
  const start = Number(job.trim?.start);
  const end = Number(job.trim?.end);
  if (!(start >= 0) || !(end - start >= 0.05)) throw new RangeError('empty trim range');
  let fellBack = !caps.codec[job.format]; // no WebCodecs encoder: the real-time recorder runs from the start
  if (caps.codec[job.format]) {
    try {
      const r = await conversionRoute(job, caps);
      return { ...r, fellBack };
    } catch (err) {
      if (err instanceof ExportCanceled || job.signal?.aborted) throw new ExportCanceled();
      console.warn('[dither] offline export failed, falling back to real-time recording', err);
      if (!caps.recorder[job.format]) throw err;
      fellBack = true;
    }
  }
  if (!caps.recorder[job.format]) throw new Error('no way to write this format');
  const r = await recorderFileRoute(job, caps);
  return { ...r, fellBack };
}

async function conversionRoute(job, caps) {
  const mb = await loadMediabunny();
  const def = FORMATS[job.format];
  const input = new mb.Input({ source: new mb.BlobSource(job.file), formats: mb.ALL_FORMATS });
  const output = new mb.Output({ format: def.make(mb), target: new mb.BufferTarget() });
  const canvas = makeCanvas(job.outW, job.outH);
  const g = canvas.getContext('2d');
  const yielder = makeYielder();
  let conversion = null;
  // Cancelling is a two-step affair. `conversion.cancel()` closes the encoder at once, but if it lands while
  // Mediabunny is inside `add()` for a sample (our `process` is awaited there, and with a target frame rate it is
  // called several times per decoded sample to pad the gaps), Mediabunny stores a fresh clone of that sample as its
  // "last frame" *after* the close has already released the previous one: nobody closes the clone, and the
  // finalizer later logs "A VideoSample was garbage collected without first being closed". So an abort first
  // *pauses* the conversion (`pauseSignal`): every remaining `process` call returns at once, the track pumps park at
  // their next checkpoint (outside `add()`), `execute()` resolves, and only then is the conversion cancelled.
  const pause = new AbortController();
  let framesOut = 0; // frames handed to the encoder; Mediabunny only reaches a pause checkpoint after the first one
  const onAbort = () => pause.abort();
  job.signal?.addEventListener('abort', onAbort);
  const started = performance.now();
  try {
    conversion = await mb.Conversion.init({
      input,
      output,
      trim: { start: job.trim.start, end: job.trim.end },
      video: {
        frameRate: job.fps || undefined,
        codec: caps.codec[job.format],
        quality: mb[(QUALITIES[job.quality] || QUALITIES.medium).constant],
        forceTranscode: true,
        processedWidth: job.outW,
        processedHeight: job.outH,
        process: async (sample) => {
          if (job.signal?.aborted) {
            // Skip the work. Before the first encoded frame Mediabunny never checks the pause request, so hand it
            // one (blank) frame to get there; it is thrown away with the rest.
            if (framesOut > 0) return null;
            framesOut++;
            return canvas;
          }
          await yielder();
          const result = await job.render(sample.timestamp, (ctx, w, h) => sample.draw(ctx, 0, 0, w, h));
          drawFit(g, job.outW, job.outH, result, job.bg);
          framesOut++;
          return canvas;
        },
      },
      audio: job.includeAudio ? {} : { discard: true },
    });
    throwIfAborted(job.signal); // cancelled while the tracks were being probed: nothing has started yet
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map((d) => `${d.track.type}:${d.reason}`).join(', ');
      throw new Error(`the conversion is not valid (${why})`);
    }
    const audioDropped = job.includeAudio && conversion.discardedTracks.some((d) => d.track.type === 'audio');
    conversion.onProgress = (p) => {
      const elapsed = (performance.now() - started) / 1000;
      job.onProgress?.(p, { remaining: p > 0.03 ? (elapsed / p) * (1 - p) : null });
    };
    await conversion.execute({ pauseSignal: pause.signal });
    if (job.signal?.aborted) {
      // paused (or finished just as the user cancelled): no sample is in flight any more, so this releases them all
      await conversion.cancel();
      throw new ExportCanceled();
    }
    const blob = new Blob([output.target.buffer], { type: def.mime });
    output.target.buffer = null;
    return { blob, ext: def.ext, route: 'mediabunny', audioDropped };
  } catch (err) {
    if (job.signal?.aborted || err?.name === 'ConversionCanceledError') {
      try { await output.cancel(); } catch { /* ignore */ }
      throw new ExportCanceled();
    }
    try { await output.cancel(); } catch { /* ignore */ }
    throw err;
  } finally {
    job.signal?.removeEventListener('abort', onAbort);
    try { input.dispose(); } catch { /* ignore */ }
    canvas.width = canvas.height = 1;
  }
}

/** Real-time fallback: play the file in a hidden <video> and record the rendered canvas with MediaRecorder. */
async function recorderFileRoute(job, caps) {
  const url = URL.createObjectURL(job.file);
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  let audioCtx = null;
  let audioTrack = null;
  let audioDropped = false;
  let sink = null;
  let onVisibility = null;
  try {
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('the video cannot be played')), { once: true });
    });
    if (job.includeAudio) {
      try {
        // Audio goes to a MediaStream, not to the speakers: the user does not hear the export
        audioCtx = new AudioContext();
        const dest = audioCtx.createMediaStreamDestination();
        audioCtx.createMediaElementSource(video).connect(dest);
        audioTrack = dest.stream.getAudioTracks()[0] || null;
      } catch {
        audioDropped = true;
      }
    } else {
      video.muted = true;
    }
    sink = createRecorderSink(job, caps, audioTrack ? [audioTrack] : []);
    const g = sink.canvas.getContext('2d');
    const work = { start: job.trim.start, end: Math.min(job.trim.end, Number.isFinite(video.duration) ? video.duration : job.trim.end) };
    const span = Math.max(0.1, work.end - work.start);
    video.currentTime = work.start;
    await new Promise((r) => { video.addEventListener('seeked', r, { once: true }); setTimeout(r, 1500); });
    const started = performance.now();
    let busy = false;
    let finished = false;
    // Real time only works while the tab is visible (hidden tabs get no video frame callbacks): pause the clip and
    // the recorder meanwhile, so no frames are skipped and the hidden stretch is not in the file
    let hiddenPause = false;
    onVisibility = () => {
      if (finished) return;
      if (document.hidden && !video.paused) {
        hiddenPause = true;
        video.pause();
        sink.pause();
      } else if (!document.hidden && hiddenPause) {
        hiddenPause = false;
        sink.resume();
        video.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const done = new Promise((resolve, reject) => {
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      const onFrame = async () => {
        if (finished) return;
        try {
          await frameStep();
        } catch (err) {
          finished = true;
          reject(err);
        }
      };
      const frameStep = async () => {
        const mt = video.currentTime;
        if (job.signal?.aborted) return finish();
        if (mt >= work.end - 0.001 || video.ended) return finish();
        if (!busy) {
          busy = true;
          try {
            const result = await job.render(Math.max(0, mt - work.start), (ctx, w, h) => ctx.drawImage(video, 0, 0, w, h));
            drawFit(g, job.outW, job.outH, result, job.bg);
            await sink.add();
          } finally {
            busy = false;
          }
          const p = Math.min(1, (mt - work.start) / span);
          const elapsed = (performance.now() - started) / 1000;
          job.onProgress?.(p, { remaining: p > 0.03 ? (elapsed / p) * (1 - p) : null });
        }
        arm();
      };
      const arm = () => {
        if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => { onFrame(); });
        else requestAnimationFrame(() => { onFrame(); });
      };
      video.addEventListener('ended', finish, { once: true });
      arm();
    });
    try {
      await video.play();
    } catch {
      // The browser refused to start with sound: record silently rather than failing
      video.muted = true;
      audioDropped = job.includeAudio;
      await video.play();
    }
    await done;
    video.pause();
    throwIfAborted(job.signal);
    const blob = await sink.finish();
    sink = null;
    return { blob, ext: FORMATS[job.format].ext, route: 'recorder', audioDropped };
  } catch (err) {
    if (job.signal?.aborted) throw new ExportCanceled();
    throw err;
  } finally {
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    if (sink) await sink.cancel();
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    try { audioCtx?.close(); } catch { /* ignore */ }
  }
}

// ---- job 2: a still image with an animated mode -----------------------------------------------------------------

/**
 * Frames at i / fps for `duration` seconds. `job.render(time, null)` renders one frame (the mode animates itself).
 * Offline with Mediabunny when possible; otherwise real time through MediaRecorder.
 */
export async function exportTimeline(job, caps) {
  throwIfAborted(job.signal);
  const frames = Math.max(1, Math.round(job.duration * job.fps));
  const yielder = makeYielder();
  let started = performance.now();
  const progress = (p) => {
    const elapsed = (performance.now() - started) / 1000;
    job.onProgress?.(p, { remaining: p > 0.03 ? (elapsed / p) * (1 - p) : null });
  };
  const offline = !!caps.codec[job.format];
  const sink = offline ? await createMediabunnySink(job, caps) : createRecorderSink(job, caps);
  const g = sink.canvas.getContext('2d');
  try {
    for (let i = 0; i < frames; i++) {
      throwIfAborted(job.signal);
      const t = i / job.fps;
      if (!offline && document.hidden) {
        // real time in a hidden tab: timers are throttled and the recorder would freeze a frame; wait instead
        sink.pause();
        const hiddenAt = performance.now();
        await whenVisible(job.signal);
        throwIfAborted(job.signal);
        started += performance.now() - hiddenAt;
        sink.resume();
      }
      if (!offline) await sleep(started + t * 1000 - performance.now()); // real time: wait for the frame's slot
      const result = await job.render(t, null);
      drawFit(g, job.outW, job.outH, result, job.bg);
      await sink.add(t, 1 / job.fps);
      progress((i + 1) / frames);
      await yielder();
    }
    throwIfAborted(job.signal);
    const blob = await sink.finish();
    return { blob, ext: FORMATS[job.format].ext, route: sink.route, audioDropped: false, fellBack: !offline };
  } catch (err) {
    await sink.cancel();
    if (job.signal?.aborted || err instanceof ExportCanceled) throw new ExportCanceled();
    throw err;
  }
}

// ---- job 3: webcam recording -------------------------------------------------------------------------------------

/**
 * Starts recording; `push(canvas, seconds)` takes a rendered frame (it is copied at once, so the canvas can be reused).
 * Returns { push, finish, cancel, route }.
 */
export async function createLiveRecorder(job, caps) {
  const sink = caps.codec[job.format] ? await createMediabunnySink(job, caps) : createRecorderSink(job, caps);
  const g = sink.canvas.getContext('2d');
  const minGap = (1 / job.fps) * 0.9;
  let lastT = -Infinity;
  let busy = false;
  let count = 0;
  let closed = false;
  return {
    route: sink.route,
    get frames() { return count; },
    /** @returns {boolean} whether the frame was taken */
    push(canvas, t) {
      if (closed || busy || t - lastT < minGap) return false;
      lastT = t;
      drawFit(g, job.outW, job.outH, canvas, job.bg);
      busy = true;
      count++;
      Promise.resolve(sink.add(t, 1 / job.fps)).catch((err) => console.warn('[dither] recording frame failed', err)).finally(() => { busy = false; });
      return true;
    },
    async finish() {
      closed = true;
      while (busy) await sleep(5);
      const blob = await sink.finish();
      return { blob, ext: FORMATS[job.format].ext, route: sink.route };
    },
    pause() { sink.pause?.(); },
    resume() { sink.resume?.(); },
    async cancel() {
      closed = true;
      // let the frame being encoded finish first: cancelling under an add() can strand its sample (see conversionRoute)
      while (busy) await sleep(5);
      await sink.cancel();
    },
  };
}
