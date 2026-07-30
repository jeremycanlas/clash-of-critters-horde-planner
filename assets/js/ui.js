/** Small shared rendering helpers. */

import { typeIcon, roleIcon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** True when the user asked for glitter art and this Tatari has any. */
export const glitterOn = { value: false };

export function artOf(t) {
  return (glitterOn.value && t.glitterImage) || t.image || null;
}

/**
 * Sprite, or the name split across lines when the wiki has no art yet
 * (a handful of unreleased Tatari).
 */
/**
 * `priority` maps to fetchpriority.
 *
 * The roster is 218 thumbnails and the browser will happily have all of them in
 * flight at once, which leaves the dozen sprites actually on screen — the
 * field, the benches, the co-op lines — waiting behind art nobody has scrolled
 * to. Those load eagerly and high; the roster asks last.
 */
export function artHTML(t, { lazy = true, priority = null } = {}) {
  const src = artOf(t);
  if (!src) return `<span class="token__fallback">${esc(t.name)}</span>`;
  const attrs = [
    lazy ? 'loading="lazy" decoding="async"' : '',
    priority ? `fetchpriority="${priority}"` : '',
  ].filter(Boolean).join(' ');
  return `<img src="${esc(src)}" alt="${esc(t.name)}"${attrs ? ` ${attrs}` : ''}>`;
}

/**
 * One source of truth for the version, used by the page footer and stamped on
 * the share card — so a posted picture says which build drew it, which matters
 * while the attack-range data is still being filled in.
 */
export const APP_VERSION = '1.3.0';
export const APP_AUTHOR = 'jacc6475';

/*
 * There is deliberately no SITE_URL any more. It used to be drawn on the field
 * frame and in the card's footer, on the theory that a screenshot should carry
 * the way back here. Sharing dropped sharply once it appeared: a watermarked
 * grid reads as an advert for a tool rather than as someone's team, and people
 * stopped posting. The credit line stays; the address does not.
 */

export { typeIcon, roleIcon };

// ---------------------------------------------------------------- toast

let toastTimer;
/**
 * `action` is an optional `{label, fn}` - an Undo, mostly. A toast carrying one
 * accepts the pointer and stays up longer, because "press this before it goes"
 * is only fair if there is time to press it.
 */
export function toast(message, kind = 'info', action = null) {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__act';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      el.classList.remove('is-shown');
      action.fn();
    });
    el.append(btn);
  }
  el.classList.toggle('has-act', !!action);
  el.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-shown'), action ? 6000 : 2600);
}

// ---------------------------------------------------------------- files

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadJSON(filename, data) {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)],
    { type: 'application/json;charset=utf-8' }));
}

/**
 * The async clipboard needs a focused document and a permission the browser may
 * refuse, so a copy that matters falls back to the old selection trick before
 * giving up and telling the user where to find the text.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.append(field);
  field.select();
  field.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  field.remove();
  return ok;
}

export function readJSONFile(input) {
  return new Promise((resolve, reject) => {
    const file = input.files?.[0];
    if (!file) return reject(new Error('No file chosen'));
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(reader.result)); }
      catch { reject(new Error(`${file.name} is not valid JSON`)); }
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
    input.value = '';
  });
}

// ---------------------------------------------------------------- drag scroll

/** Distance from a viewport edge at which a drag starts scrolling the page. */
const SCROLL_EDGE = 90;
/** Scroll speed in px per frame when the pointer is right at the edge. */
const SCROLL_MAX = 22;

/**
 * Scroll speed for a drag at `clientY`: negative near the top, positive near the
 * bottom, 0 in the middle. Ramps linearly from 0 at the threshold to SCROLL_MAX
 * at the edge, so a slow approach nudges and a hard press at the edge flies.
 */
export function dragScrollVelocity(clientY, viewportHeight,
  edge = SCROLL_EDGE, max = SCROLL_MAX) {
  const ramp = (distance) => Math.ceil(((edge - Math.max(0, distance)) / edge) * max);
  const fromBottom = viewportHeight - clientY;
  if (clientY < edge) return -ramp(clientY);
  if (fromBottom < edge) return ramp(fromBottom);
  return 0;
}

export function slugFilename(name, fallback, extension = 'json') {
  const base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base || fallback}.${extension}`;
}
