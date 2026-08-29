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
 * A 1x1 transparent GIF. It stands in for a sprite that has not loaded yet, so
 * the card shows its tinted box rather than a broken-image icon while custom
 * lazy-loading waits to swap the real art in.
 */
export const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * `priority` maps to fetchpriority.
 *
 * The roster is 218 thumbnails and the browser will happily have all of them in
 * flight at once, which leaves the dozen sprites actually on screen (the
 * field, the benches, the co-op lines) waiting behind art nobody has scrolled
 * to. Those load eagerly and high; the roster asks last.
 *
 * `observe` is custom lazy-loading for the scrolling roster: the image ships
 * with the blank pixel above and the real src in data-src, for an
 * IntersectionObserver to swap in once the card scrolls into view. It replaces
 * `loading="lazy"`, which loads fine but -- inside a scroll container, in Chrome
 * -- routinely fails to paint until a scroll forces a repaint, leaving the
 * roster full of blank squares. Setting src on an already-visible image paints
 * it the ordinary way, so that bug never arises.
 */
export function artHTML(t, { lazy = true, priority = null, observe = false } = {}) {
  const src = artOf(t);
  if (!src) return `<span class="token__fallback">${esc(t.name)}</span>`;
  const attrs = [
    priority ? `fetchpriority="${priority}"` : '',
    observe ? 'decoding="async"' : (lazy ? 'loading="lazy" decoding="async"' : ''),
  ].filter(Boolean).join(' ');
  if (observe) {
    return `<img class="lazyart" src="${BLANK_PIXEL}" data-src="${esc(src)}" alt="${esc(t.name)}"${
      attrs ? ` ${attrs}` : ''}>`;
  }
  return `<img src="${esc(src)}" alt="${esc(t.name)}"${attrs ? ` ${attrs}` : ''}>`;
}

/**
 * One source of truth for the version, used by the page footer and stamped on
 * the share card — so a posted picture says which build drew it, which matters
 * while the attack-range data is still being filled in.
 */
export const APP_VERSION = '1.8.7';
export const APP_AUTHOR = 'jacc6475';

/*
 * There is deliberately no SITE_URL any more. It used to be drawn on the field
 * frame and in the card's footer, on the theory that a screenshot should carry
 * the way back here. Sharing dropped sharply once it appeared: a watermarked
 * grid reads as an advert for a tool rather than as someone's team, and people
 * stopped posting. The credit line stays; the address does not.
 */

export { typeIcon, roleIcon };

// ---------------------------------------------------------------- dialogs

/**
 * Closing a dialog on its backdrop, without closing it by accident.
 *
 * Every sheet in this project used to do it the obvious way — close when a click
 * reports the dialog element itself as its target, since anything visible inside
 * is a child of it. That is right until a dialog holds text somebody wants to
 * select, and then it is quietly wrong: a `click` is dispatched to the nearest
 * common ancestor of where the pointer went *down* and where it came *up*, so
 * dragging across the session link and releasing a few pixels past the edge of
 * the sheet names the dialog as the target and shuts it mid-selection. The Share
 * sheet's name box and the submit notes had the same flaw and nobody had tried
 * to select them.
 *
 * So the press has to land on the backdrop as well as the release. `pointerdown`
 * rather than `mousedown` because a touch that begins on a control and slides
 * off should not count either.
 *
 * ## Where the backdrop actually is
 *
 * "The target is the dialog" is the usual test for a backdrop click and it is
 * not precise enough, because it is true of two different places. The backdrop
 * reports the dialog, and so does the dialog's own padding — the band of empty
 * space between its border and its contents. Pressing beside a heading is
 * therefore indistinguishable from pressing outside the sheet, which made
 * `padding` a quarter-inch border of "close me" around every dialog in the app.
 *
 * So the question is asked geometrically instead: is the pointer outside the
 * dialog's box? That is the thing "backdrop" actually means, and padding is
 * inside it.
 *
 * `[data-close]` anywhere inside still closes, which is how the action rows do
 * it, and Escape is left to the browser.
 *
 * `dismiss` is for the one sheet that has more to do than shut — the gallery's
 * peek puts the address back as it goes.
 */
export function dismissOnBackdrop(dlg, dismiss = null) {
  if (!dlg) return;

  const outside = (e) => {
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right
        || e.clientY < r.top || e.clientY > r.bottom;
  };

  let pressedOutside = false;
  dlg.addEventListener('pointerdown', (e) => { pressedOutside = outside(e); });
  dlg.addEventListener('click', (e) => {
    // `detail` is 0 for the click a keyboard makes, which carries no coordinates
    // — every one of them would otherwise read as a press at (0, 0), outside the
    // dialog, and Enter on a focused control would dismiss the sheet.
    const backdrop = pressedOutside && e.detail > 0 && outside(e);
    pressedOutside = false;
    if (backdrop || e.target.closest('[data-close]')) (dismiss ?? (() => dlg.close()))();
  });
}

// ---------------------------------------------------------------- toast

let toastTimer;
/**
 * `action` is an optional `{label, fn}` - an Undo, mostly. A toast carrying one
 * accepts the pointer and stays up longer, because "press this before it goes"
 * is only fair if there is time to press it.
 */
export function toast(message, kind = 'info', action = null) {
  const el = $('#toast');
  // textContent replaces the words but not an appended button, so a second
  // action toast used to arrive wearing the first one's Undo as well.
  el.querySelector('.toast__act')?.remove();
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
  toastTimer = setTimeout(() => {
    el.classList.remove('is-shown');
    /*
     * The button goes with it. `.has-act` keeps pointer-events on so Undo can be
     * pressed, and removing only `is-shown` left an invisible, still-focusable
     * control in the tab order — one whose job is to replace the formation you
     * are now working on. On a phone it also sat over the bench dock, eating
     * taps meant for a Tatari.
     */
    el.classList.remove('has-act');
    el.querySelector('.toast__act')?.remove();
  }, action ? 6000 : 2600);
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
