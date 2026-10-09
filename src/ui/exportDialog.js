// Video export / webcam recording dialog (PLAN.md 9.2). Built with DOM calls and textContent only.
// It collects the settings, then shows progress with a cancel button while the job runs.

import { t } from '../i18n/i18n.js';
import { LIMITS } from '../config.js';
import { formatBytes } from '../io/validate.js';
import { QUALITIES, outputSize, estimateExport, formatClock, probeFile } from '../io/exportVideo.js';

let last = { format: '', fps: '', quality: 'high', height: '720', audio: true }; // remembered between openings

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * @param {object} o
 * @param {'file'|'timeline'|'live'} o.kind   video file, still image + animated mode, or webcam recording
 * @param {object} o.source
 * @param {number} o.aspect           width / height of the rendered picture
 * @param {number} o.naturalHeight    height of the picture at scale 1 (the "original" size)
 * @param {object} o.caps             result of detectCapabilities()
 * @param {(settings:object, ctl:object)=>Promise<void>} o.onStart  runs the job; ctl = { signal, progress(p, remaining), close() }
 * @param {()=>void} [o.onClose]
 * @returns {{ close:()=>void, el:HTMLDialogElement }}
 */
export function openExportDialog({ kind, source, aspect, naturalHeight, caps, onStart, onClose }) {
  const dlg = el('dialog', 'dialog');
  dlg.id = 'export-dialog';
  dlg.dataset.kind = kind;
  dlg.setAttribute('aria-labelledby', 'vx-title');

  const form = el('div', 'dlg-body');
  const title = el('h2', 'dlg-title display', t(kind === 'live' ? 'vx.titleRecord' : 'vx.title'));
  title.id = 'vx-title';
  form.appendChild(title);

  const rows = el('div', 'dlg-rows');
  form.appendChild(rows);

  let rowSeq = 0;
  const field = (labelKey, control, { id, input = control } = {}) => {
    const row = el('div', 'ctl dlg-row');
    const lab = el('label', 'ctl-label', t(labelKey));
    const cid = id || `vx-f${rowSeq++}`;
    input.id = cid;
    lab.htmlFor = cid;
    row.append(lab, control);
    rows.appendChild(row);
    return row;
  };
  const select = (opts) => {
    const wrap = el('div', 'select-wrap');
    const sel = el('select', 'select');
    for (const [value, text, disabled] of opts) {
      const o = el('option', null, text);
      o.value = value;
      if (disabled) o.disabled = true;
      sel.appendChild(o);
    }
    wrap.appendChild(sel);
    return { wrap, sel };
  };
  const numberInput = (min, max, step, value) => {
    const i = el('input', 'input');
    i.type = 'number';
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.value = String(value);
    i.inputMode = 'decimal';
    return i;
  };

  // ---- format --------------------------------------------------------------------------------
  const fmt = select([
    ['mp4', t('vx.format.mp4'), !caps.available.mp4],
    ['webm', t('vx.format.webm'), !caps.available.webm],
  ]);
  const wanted = last.format && caps.available[last.format] ? last.format : (caps.available.mp4 ? 'mp4' : 'webm');
  fmt.sel.value = wanted;
  const fmtRow = field('vx.format', fmt.wrap, { id: 'vx-format', input: fmt.sel });
  const fmtHint = el('p', 'note dlg-hint');
  fmtHint.id = 'vx-format-hint';
  fmtRow.appendChild(fmtHint);

  // ---- frame rate ----------------------------------------------------------------------------
  const fpsOptions = [];
  if (kind === 'file') fpsOptions.push(['0', t('vx.fps.original')]);
  for (const f of [24, 30, 60]) fpsOptions.push([String(f), `${f}`]);
  const fps = select(fpsOptions);
  fps.sel.value = [...fps.sel.options].some((o) => o.value === last.fps) ? last.fps : (kind === 'file' ? '0' : '30');
  field('vx.fps', fps.wrap, { id: 'vx-fps', input: fps.sel });

  // ---- quality -------------------------------------------------------------------------------
  const quality = select(Object.keys(QUALITIES).map((q) => [q, t(`vx.quality.${q}`)]));
  quality.sel.value = last.quality in QUALITIES ? last.quality : 'high';
  field('vx.quality', quality.wrap, { id: 'vx-quality', input: quality.sel });

  // ---- output height ---------------------------------------------------------------------------
  const height = select([['480', '480p'], ['720', '720p'], ['1080', '1080p'], ['original', t('vx.height.original')]]);
  height.sel.value = [...height.sel.options].some((o) => o.value === last.height) ? last.height : '720';
  field('vx.height', height.wrap, { id: 'vx-height', input: height.sel });

  // ---- audio, trim, duration -------------------------------------------------------------------
  let audioSwitch = null;
  let startIn = null;
  let endIn = null;
  let durIn = null;
  let fileDuration = Number.isFinite(source.duration) ? source.duration : 0;
  if (kind === 'file') {
    audioSwitch = el('input', 'switch');
    audioSwitch.type = 'checkbox';
    audioSwitch.checked = last.audio;
    const aRow = field('vx.audio', audioSwitch, { id: 'vx-audio' });
    aRow.classList.add('ctl-toggle');
    const aHint = el('p', 'note dlg-hint');
    aHint.id = 'vx-audio-hint';
    aRow.appendChild(aHint);

    const trimRow = el('div', 'dlg-pair');
    startIn = numberInput(0, Math.max(0, fileDuration), 0.1, 0);
    endIn = numberInput(0, Math.max(0, fileDuration), 0.1, +fileDuration.toFixed(2));
    const mk = (labelKey, input, id) => {
      const wrap = el('div', 'ctl');
      const lab = el('label', 'ctl-label', t(labelKey));
      input.id = id;
      lab.htmlFor = id;
      wrap.append(lab, input);
      return wrap;
    };
    trimRow.append(mk('vx.trimStart', startIn, 'vx-start'), mk('vx.trimEnd', endIn, 'vx-end'));
    rows.appendChild(trimRow);

    // The container knows more than the <video> element: audio present?, exact frame rate
    probeFile(source.file).then((info) => {
      if (!info || !dlg.isConnected) return;
      if (info.hasAudio === false) {
        audioSwitch.checked = false;
        audioSwitch.disabled = true;
        aHint.textContent = t('vx.audio.none');
      }
      if (info.fps) {
        source.fpsExact = info.fps;
        fps.sel.options[0].textContent = t('vx.fps.originalN', { fps: Math.round(info.fps * 100) / 100 });
      }
      if (info.duration && !fileDuration) {
        fileDuration = info.duration;
        endIn.value = fileDuration.toFixed(2);
      }
      refresh();
    });
  } else if (kind === 'timeline') {
    durIn = numberInput(1, 60, 1, 5);
    field('vx.duration', durIn, { id: 'vx-duration' });
  }

  // ---- summary and warnings ----------------------------------------------------------------------
  const summary = el('p', 'dlg-summary mono');
  summary.id = 'vx-summary';
  summary.setAttribute('aria-live', 'polite');
  const warns = el('ul', 'dlg-warns');
  warns.id = 'vx-warn';
  form.append(summary, warns);

  const actions = el('div', 'dlg-actions');
  const cancelBtn = el('button', 'btn btn-ghost btn-sm', t('vx.cancel'));
  cancelBtn.type = 'button';
  cancelBtn.id = 'vx-cancel';
  const goBtn = el('button', 'btn btn-primary btn-sm', t(kind === 'live' ? 'vx.startRecording' : 'vx.export'));
  goBtn.type = 'button';
  goBtn.id = 'vx-go';
  actions.append(cancelBtn, goBtn);
  form.appendChild(actions);

  // ---- progress view -----------------------------------------------------------------------------
  const progressView = el('div', 'dlg-progress');
  progressView.hidden = true;
  const pTitle = el('h2', 'dlg-title display', t('vx.exporting'));
  const bar = el('div', 'bar');
  bar.id = 'vx-progress';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  bar.setAttribute('aria-label', t('vx.exporting'));
  const fill = el('div', 'bar-fill');
  bar.appendChild(fill);
  const pText = el('p', 'dlg-summary mono', '0%');
  pText.id = 'vx-progress-text';
  const pCancel = el('button', 'btn btn-ghost btn-sm', t('vx.cancelExport'));
  pCancel.type = 'button';
  pCancel.id = 'vx-cancel-export';
  progressView.append(pTitle, bar, pText, pCancel);

  dlg.append(form, progressView);
  document.body.appendChild(dlg);

  // ---- logic -----------------------------------------------------------------------------------
  const controller = new AbortController();
  let running = false;
  let closed = false;

  const current = () => {
    const format = fmt.sel.value;
    const fpsValue = Number(fps.sel.value);
    const size = outputSize(aspect, height.sel.value, naturalHeight);
    const srcFps = source.fpsExact || source.fps || 30;
    let start = 0;
    let end = fileDuration;
    if (kind === 'file') {
      start = Math.max(0, Number(startIn.value) || 0);
      end = Math.min(fileDuration || Infinity, Number(endIn.value) || 0);
    }
    // An untouched end means "to the last frame" (the box shows the duration rounded to 1/100 s)
    const trimEnd = kind === 'file' && fileDuration && end >= fileDuration - 0.011 ? Infinity : end;
    const duration = kind === 'file' ? Math.max(0, end - start)
      : kind === 'timeline' ? Math.min(60, Math.max(1, Number(durIn.value) || 1)) : 0;
    return {
      format,
      fps: fpsValue,
      effectiveFps: fpsValue || srcFps,
      quality: quality.sel.value,
      heightChoice: height.sel.value,
      outW: size.width,
      outH: size.height,
      includeAudio: !!audioSwitch && audioSwitch.checked && !audioSwitch.disabled,
      trim: { start, end: trimEnd },
      duration,
      valid: kind !== 'file' || (end - start >= 0.1 && start >= 0),
    };
  };

  function refresh() {
    const s = current();
    const est = estimateExport({ width: s.outW, height: s.outH, fps: s.effectiveFps, quality: s.quality, duration: s.duration, includeAudio: s.includeAudio });
    const parts = [`${s.outW}×${s.outH}`, `${Math.round(s.effectiveFps * 100) / 100} fps`];
    if (s.duration > 0) parts.push(formatClock(s.duration), t('vx.estSize', { size: formatBytes(Math.max(1, est.bytes)) }));
    summary.textContent = parts.join(' · ');

    warns.textContent = '';
    const warn = (id, text) => {
      const li = el('li', 'dlg-warn', text);
      li.dataset.warn = id;
      warns.appendChild(li);
    };
    if (est.long) warn('long', t('vx.warn.long', { min: Math.round(LIMITS.videoWarnSeconds / 60) }));
    if (est.large) warn('large', t('vx.warn.large'));
    if (!s.valid) warn('trim', t('vx.warn.trim'));
    const route = caps.codec[s.format] ? 'offline' : 'realtime';
    if (route === 'realtime' && caps.available[s.format]) warn('realtime', t(kind === 'live' ? 'vx.warn.realtimeLive' : 'vx.warn.realtime'));

    fmtHint.textContent = !caps.available.mp4 ? t('vx.format.noMp4') : '';
    fmtHint.hidden = !fmtHint.textContent;
    goBtn.disabled = !s.valid || !caps.available[s.format];
  }
  for (const c of [fmt.sel, fps.sel, quality.sel, height.sel, audioSwitch, startIn, endIn, durIn]) {
    c?.addEventListener('input', refresh);
    c?.addEventListener('change', refresh);
  }
  refresh();

  function close() {
    if (closed) return;
    closed = true;
    if (running) controller.abort();
    if (dlg.open) dlg.close();
    dlg.remove();
    onClose?.();
  }

  function cancelRun() {
    controller.abort();
    pCancel.disabled = true;
    pText.textContent = t('vx.canceling');
  }

  cancelBtn.addEventListener('click', close);
  pCancel.addEventListener('click', cancelRun);
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc: stop the job when one runs, otherwise just close
    if (running) cancelRun();
    else close();
  });

  goBtn.addEventListener('click', async () => {
    const s = current();
    if (!s.valid || running) return;
    last = { format: s.format, fps: String(s.fps), quality: s.quality, height: s.heightChoice, audio: audioSwitch ? audioSwitch.checked : last.audio };
    running = true;
    if (kind !== 'live') {
      form.hidden = true;
      progressView.hidden = false;
    }
    const ctl = {
      signal: controller.signal,
      progress(p, remaining) {
        const pct = Math.min(100, Math.max(0, Math.round(p * 100)));
        fill.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
        pText.textContent = remaining != null ? t('vx.progress', { pct, left: formatClock(remaining) }) : `${pct}%`;
      },
      close,
    };
    try {
      await onStart(s, ctl);
    } finally {
      running = false;
      close();
    }
  });

  dlg.showModal();
  goBtn.focus();
  return { close, el: dlg };
}
