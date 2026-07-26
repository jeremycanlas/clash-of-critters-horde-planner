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

export function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

export function slugFilename(name, fallback) {
  const base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base || fallback}.json`;
}
