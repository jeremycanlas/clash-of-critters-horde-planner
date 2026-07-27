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
export function artHTML(t, { lazy = true } = {}) {
  const src = artOf(t);
  if (!src) return `<span class="token__fallback">${esc(t.name)}</span>`;
  return `<img src="${esc(src)}" alt="${esc(t.name)}"${lazy ? ' loading="lazy" decoding="async"' : ''}>`;
}

/**
 * One source of truth for the version, used by the page footer and stamped on
 * the share card — so a posted picture says which build drew it, which matters
 * while the attack-range data is still being filled in.
 */
export const APP_VERSION = '1.1.0';
export const APP_AUTHOR = 'jacc6475';

/**
 * Drawn on the field frame, because a screenshot of the grid is how these get
 * passed around and the picture should carry the way back here. Without the
 * scheme and trailing slash: it has to fit on one line beside "Your base" on a
 * 320px phone, and nobody types "https://" anyway.
 */
export const SITE_URL = 'jeremycanlas.github.io/clash-of-critters-horde-planner';

export { typeIcon, roleIcon };

// ---------------------------------------------------------------- toast

let toastTimer;
export function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-shown'), 2600);
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
