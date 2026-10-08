// Toast notifications. Messages are always set with textContent (never HTML).

import { t } from '../i18n/i18n.js';

const MAX_TOASTS = 4;

export function toast(message, { type = 'info', timeout } = {}) {
  const host = document.getElementById('toasts');
  if (!host || !message) return null;

  // Collapse an identical visible message instead of stacking it
  for (const el of host.children) {
    if (el.dataset.msg === message) {
      el.classList.remove('is-leaving');
      el.getAnimations?.().forEach((a) => a.cancel());
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      return el;
    }
  }
  while (host.children.length >= MAX_TOASTS) host.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.dataset.msg = message;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', t('toast.close'));
  close.textContent = '×';

  el.append(msg, close);
  host.appendChild(el);

  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 260);
  };
  close.addEventListener('click', dismiss);
  const ms = timeout ?? (type === 'error' ? 8000 : 5000);
  if (ms > 0) timer = setTimeout(dismiss, ms);
  return el;
}

export const toastError = (m, o) => toast(m, { type: 'error', ...o });
export const toastWarn = (m, o) => toast(m, { type: 'warn', ...o });
