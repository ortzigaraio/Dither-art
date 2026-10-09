// Main-thread client of heavy.worker.js: run(task, payload, { onProgress, signal, watchdogMs, onWatchdog }).
//
// - Every call gets an increasing jobId. Results of cancelled jobs are never delivered.
// - Cancelling (AbortSignal, cancel() of the watchdog hook) rejects the promise at once with an AbortError and tells
//   the worker; if the worker does not acknowledge within `graceMs` (a task that never yields) it is terminated and
//   respawned, so a runaway job can always be stopped.
// - Watchdog (PLAN.md 18.2): a job still running after LIMITS.workerWatchdogMs calls the watchdog hook, which offers
//   the user a way to cancel. The job keeps running until cancelled.
// - Without Worker support (or when the worker cannot start) the same tasks run on the main thread, in cooperative
//   chunks, with the same cancellation semantics.

import { TASKS, CancelledError } from './heavyTasks.js';
import { LIMITS } from '../config.js';

const WORKER_URL = new URL('../workers/heavy.worker.js', import.meta.url);
const GRACE_MS = 400;

let worker = null;
let workerFailed = false;
let forceMain = false;
let nextJobId = 1;
let spawned = 0;
let terminated = 0;
const jobs = new Map(); // jobId -> job
let watchdogHandler = null;
const activityListeners = new Set();

const abortError = (msg = 'cancelled') => {
  const e = new Error(msg);
  e.name = 'AbortError';
  return e;
};
export const isAbort = (err) => err?.name === 'AbortError';

function emitActivity() {
  if (!activityListeners.size) return;
  let active = 0;
  let progress = 0;
  let task = '';
  for (const j of jobs.values()) {
    if (j.settled) continue;
    active++;
    progress = Math.max(progress, j.progress);
    task = j.task;
  }
  activityListeners.forEach((fn) => fn({ active, progress, task }));
}

function settle(job, fn, value) {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.watchdogTimer);
  if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
  fn(value);
  emitActivity();
}

function dropJob(job) {
  clearTimeout(job.graceTimer);
  jobs.delete(job.id);
  emitActivity();
}

function spawnWorker() {
  if (forceMain || workerFailed || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(WORKER_URL, { type: 'module' });
    spawned++;
  } catch {
    workerFailed = true;
    return null;
  }
  const mine = worker;
  mine.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'ready') return;
    const job = jobs.get(m.jobId);
    if (!job) return;
    if (m.type === 'progress') {
      job.progress = m.value;
      if (!job.settled) job.onProgress?.(m.value);
      emitActivity();
    } else if (m.type === 'done') {
      settle(job, job.resolve, m.result);
      dropJob(job);
    } else if (m.type === 'error') {
      settle(job, job.reject, new Error(m.message));
      dropJob(job);
    } else if (m.type === 'cancelled') {
      settle(job, job.reject, abortError());
      dropJob(job);
    }
  };
  mine.onerror = (ev) => {
    // The worker script itself failed (blocked, syntax error): fall back to the main thread for good
    ev.preventDefault?.();
    if (worker !== mine) return;
    workerFailed = true;
    killWorker(new Error('worker failed to start'));
  };
  return mine;
}

/** Terminate the worker; every job that was running on it fails with `reason`. */
function killWorker(reason) {
  if (worker) {
    worker.terminate();
    worker = null;
    terminated++;
  }
  for (const job of [...jobs.values()]) {
    if (job.local) continue;
    settle(job, job.reject, reason);
    dropJob(job);
  }
}

function fireWatchdog(job) {
  if (job.settled) return;
  job.watchdogFired = true;
  const info = {
    jobId: job.id,
    task: job.task,
    elapsedMs: performance.now() - job.startedAt,
    cancel: () => cancelJob(job),
  };
  const handler = job.onWatchdog || watchdogHandler;
  try { handler?.(info); } catch (err) { console.warn('[dither] watchdog handler failed', err); }
}

function cancelJob(job) {
  if (job.settled) return;
  settle(job, job.reject, abortError());
  if (job.local) {
    job.localCancelled = true;
    jobs.delete(job.id);
    emitActivity();
    return;
  }
  worker?.postMessage({ type: 'cancel', jobId: job.id });
  // Keep the entry until the worker acknowledges; if it never does, the task is not yielding: kill the worker
  clearTimeout(job.graceTimer);
  job.graceTimer = setTimeout(() => {
    if (jobs.has(job.id)) killWorker(abortError('worker restarted'));
  }, GRACE_MS);
}

async function runLocal(job, payload) {
  const ctl = {
    progress(p) { job.progress = p; if (!job.settled) job.onProgress?.(p); emitActivity(); },
    check() { if (job.localCancelled) throw new CancelledError(); },
    async yield() { await new Promise((r) => setTimeout(r, 0)); if (job.localCancelled) throw new CancelledError(); },
  };
  try {
    const fn = TASKS[job.task];
    if (typeof fn !== 'function') throw new Error(`unknown task "${job.task}"`);
    const result = await fn(payload, ctl);
    if (job.localCancelled) return;
    settle(job, job.resolve, result);
  } catch (err) {
    if (job.localCancelled || err instanceof CancelledError) return;
    settle(job, job.reject, err);
  } finally {
    jobs.delete(job.id);
    emitActivity();
  }
}

/**
 * @param {string} task      name in TASKS (engine/heavyTasks.js)
 * @param {object} payload   structured-cloneable input
 * @param {object} [opts]
 * @param {(p:number)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {Transferable[]} [opts.transfer]  buffers moved to the worker instead of copied
 * @param {boolean} [opts.latestOnly]       a newer job of the same task cancels this one
 * @param {number} [opts.watchdogMs]        defaults to LIMITS.workerWatchdogMs (30 s)
 * @param {(info:{jobId:number,task:string,elapsedMs:number,cancel:()=>void})=>void} [opts.onWatchdog]
 * @param {boolean} [opts.local]            run on the main thread
 */
export function run(task, payload, opts = {}) {
  const { onProgress, signal, transfer = [], latestOnly = false, watchdogMs = LIMITS.workerWatchdogMs, onWatchdog, local = false } = opts;
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const job = {
      id: nextJobId++, task, resolve, reject, onProgress, onWatchdog, signal,
      progress: 0, settled: false, watchdogFired: false, startedAt: performance.now(),
      local: false, localCancelled: false,
    };
    jobs.set(job.id, job);
    if (signal) {
      job.onAbort = () => cancelJob(job);
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    if (watchdogMs > 0) job.watchdogTimer = setTimeout(() => fireWatchdog(job), watchdogMs);

    const w = local ? null : spawnWorker();
    if (w) {
      try {
        w.postMessage({ type: 'start', jobId: job.id, task, payload, latestOnly }, transfer);
      } catch (err) {
        settle(job, reject, err);
        dropJob(job);
        return;
      }
    } else {
      job.local = true;
      runLocal(job, payload);
    }
    emitActivity();
  });
}

/** Cancel every running job (used when the studio drops its source). */
export function cancelAll() {
  for (const job of [...jobs.values()]) cancelJob(job);
}

/** Hook called when a job exceeds the watchdog time; the studio uses it to offer a Cancel button. */
export function setWatchdogHandler(fn) { watchdogHandler = fn; }

/** Subscribe to { active, progress, task } changes (for a progress overlay). Returns an unsubscribe function. */
export function onActivity(fn) {
  activityListeners.add(fn);
  return () => activityListeners.delete(fn);
}

/** Force the main-thread path (tests, or browsers where the worker cannot start). */
export function setForceMain(on) { forceMain = !!on; }

/** Diagnostics for tests. */
export function stats() {
  return {
    hasWorker: !!worker, spawned, terminated, running: [...jobs.values()].filter((j) => !j.settled).length,
    pending: jobs.size, workerFailed,
  };
}
