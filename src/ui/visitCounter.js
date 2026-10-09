// Public visit counter in the footer (PLAN.md 17). The backend is worker/counter/ (Cloudflare Worker + D1).
// - config.counterUrl empty -> nothing is shown and no request is made.
// - One visit = one browser per UTC day: if localStorage['horain.visit'] is not today -> POST /hit (and remember
//   today), otherwise GET /count. Global Privacy Control -> GET /count only (shown, never counted).
// - fetch with a 4 s timeout, credentials 'omit', cache 'no-store'. Any failure hides the counter silently.
// - Odometer: 6 zero-padded digits that roll from 0 to the value when the footer comes into view (no animation
//   with prefers-reduced-motion), "today: n" below, and an aria-label with the total.

import { t, onLangChange } from '../i18n/i18n.js';
import { config } from '../config.js';

const VISIT_KEY = 'horain.visit';
const TIMEOUT_MS = 4000;
const DIGITS = 6;

const todayUTC = () => new Date().toISOString().slice(0, 10);

function readVisit() {
  try { return localStorage.getItem(VISIT_KEY); } catch { return null; }
}
function writeVisit(day) {
  try { localStorage.setItem(VISIT_KEY, day); } catch { /* storage blocked: we may count this browser again tomorrow */ }
}

/** The endpoint for a route, or null when the counter URL is missing or not http(s). */
function endpoint(base, route) {
  if (typeof base !== 'string' || !base.trim()) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/${route}`;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

const validCount = (n) => Number.isSafeInteger(n) && n >= 0;

/** Ask the Worker. Resolves { total, today } or null (never throws, never logs an error). */
export async function fetchCount({ url = config.counterUrl, fetchImpl = globalThis.fetch, now = todayUTC } = {}) {
  const gpc = navigator.globalPrivacyControl === true;
  const day = now();
  const count = !gpc && readVisit() !== day;
  const target = endpoint(url, count ? 'hit' : 'count');
  if (!target || typeof fetchImpl !== 'function') return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(target, {
      method: count ? 'POST' : 'GET',
      credentials: 'omit',
      cache: 'no-store',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const total = Number(body?.total);
    const today = Number(body?.today);
    if (!validCount(total) || !validCount(today)) return null;
    if (count) writeVisit(day);
    return { total, today };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build the odometer inside `host` (#visit-counter). Stays hidden unless the Worker answers.
 * @param {HTMLElement} host
 * @param {object} [o] { url } to override config.counterUrl (tests)
 */
export async function initVisitCounter(host, o = {}) {
  if (!host) return null;
  host.hidden = true;
  const url = o.url ?? config.counterUrl;
  if (!url) return null; // no Worker yet: no counter and no request (PLAN.md 17)
  const data = await fetchCount({ url });
  if (!data) return null;

  host.textContent = '';
  host.setAttribute('role', 'group');
  const label = el('span', 'vc-label label');
  const odo = el('span', 'vc-odo');
  odo.setAttribute('aria-hidden', 'true');
  const value = Math.min(data.total, 10 ** DIGITS - 1);
  const text = String(value).padStart(DIGITS, '0');
  const wheels = [];
  for (const ch of text) {
    const cell = el('span', 'vc-digit');
    const strip = el('span', 'vc-strip');
    for (let d = 0; d <= 9; d++) strip.appendChild(el('span', null, String(d)));
    cell.appendChild(strip);
    odo.appendChild(cell);
    wheels.push({ strip, digit: Number(ch) });
  }
  const today = el('span', 'vc-today mono');
  host.append(label, odo, today);

  const relabel = () => {
    label.textContent = t('counter.label');
    today.textContent = t('counter.today', { n: data.today });
    host.setAttribute('aria-label', t('counter.aria', { n: data.total, today: data.today }));
  };
  relabel();
  onLangChange(relabel);

  const roll = () => {
    for (const w of wheels) w.strip.style.transform = `translateY(${-w.digit * 10}%)`;
    host.dataset.rolled = 'true';
  };
  host.hidden = false;
  if (reducedMotion() || !('IntersectionObserver' in window)) {
    host.classList.add('vc-still');
    roll();
  } else {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        requestAnimationFrame(roll);
      }
    });
    io.observe(host);
  }
  host.dataset.total = String(data.total);
  return data;
}
