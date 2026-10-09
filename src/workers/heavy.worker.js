// Generic job runner for CPU-heavy work (PLAN.md 1.6, 12 phase 3). Module worker: siblings are imported by
// relative path because workers do not see an import map.
//
// Protocol (main -> worker):  { type: 'start', jobId, task, payload, latestOnly }  |  { type: 'cancel', jobId }
//          (worker -> main):  { type: 'ready' } | { type: 'progress', jobId, value, partial? } | { type: 'done', jobId, result }
//                             | { type: 'error', jobId, message } | { type: 'cancelled', jobId }
//
// Cancellation is cooperative: tasks call ctl.yield(), which lets queued messages (a cancel, or a newer job with
// `latestOnly`) arrive. A cancelled job never posts a result; it posts 'cancelled' instead.
// A task may attach an intermediate result to a progress message (ctl.progress(value, partial)), e.g. the points of
// every Lloyd iteration of the Voronoi stippling, so the viewer can animate the relaxation.

import { TASKS, CancelledError } from '../engine/heavyTasks.js';

const jobs = new Map(); // jobId -> { task, cancelled }

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

function transferablesOf(result) {
  const out = [];
  const seen = new Set();
  const visit = (v) => {
    if (!v || typeof v !== 'object') return;
    if (ArrayBuffer.isView(v)) {
      if (!seen.has(v.buffer)) { seen.add(v.buffer); out.push(v.buffer); }
      return;
    }
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (Object.getPrototypeOf(v) === Object.prototype) Object.values(v).forEach(visit);
  };
  visit(result);
  return out;
}

async function runJob(jobId, task, payload) {
  const job = jobs.get(jobId);
  const fn = TASKS[task];
  try {
    if (typeof fn !== 'function') throw new Error(`unknown task "${task}"`);
    const ctl = {
      progress(value, partial) {
        if (job.cancelled) return;
        if (partial === undefined) postMessage({ type: 'progress', jobId, value });
        else postMessage({ type: 'progress', jobId, value, partial }, transferablesOf(partial));
      },
      check() { if (job.cancelled) throw new CancelledError(); },
      async yield() { await nextTurn(); if (job.cancelled) throw new CancelledError(); },
    };
    const result = await fn(payload, ctl);
    if (job.cancelled) throw new CancelledError();
    postMessage({ type: 'done', jobId, result }, transferablesOf(result));
  } catch (err) {
    if (err instanceof CancelledError || job?.cancelled) postMessage({ type: 'cancelled', jobId });
    else postMessage({ type: 'error', jobId, message: String(err?.message || err) });
  } finally {
    jobs.delete(jobId);
  }
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'start') {
    if (m.latestOnly) {
      // A newer job of the same kind makes older ones pointless
      for (const [id, j] of jobs) if (j.task === m.task && id < m.jobId) j.cancelled = true;
    }
    jobs.set(m.jobId, { task: m.task, cancelled: false });
    runJob(m.jobId, m.task, m.payload);
  } else if (m.type === 'cancel') {
    const j = jobs.get(m.jobId);
    if (j) j.cancelled = true;
  }
};

postMessage({ type: 'ready' });
