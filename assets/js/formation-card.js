/**
 * A formation drawn as a stamp: every placed Tatari, sprite by sprite, on the
 * grid it was placed on.
 *
 * Lifted out of the saves drawer because the community gallery and the saves
 * list are asking the same question (which build is this), and art answers it
 * faster than a name does. A player recognises a formation by its shape and its
 * sprites long before they read its title.
 *
 * One deliberate difference from the version this replaces. In the saves drawer
 * an unresolvable slug drew nothing, which mirrors what the autosave does with
 * one. On a community card that is wrong: a fifteen-Tatari build rendering
 * eleven sprites quietly misrepresents itself, and the viewer has no way to
 * know. So a placed-but-unknown slug leaves a marked gap, and `unknownSlugs()`
 * lets the caller say how many in words.
 */

import { state } from './data.js';
import { COLS, MODES } from './rules.js';
import { esc, artOf } from './ui.js';

/** Occupied cells, as `{cell, slug, player}`, in cell order. */
function occupants(cells) {
  const out = [];
  (Array.isArray(cells) ? cells : []).forEach((occ, cell) => {
    const slug = typeof occ === 'string' ? occ : occ?.slug;
    if (slug) out.push({ cell, slug, player: Number(occ?.player) || 1 });
  });
  return out;
}

/** Placed slugs this copy of the roster cannot resolve. */
export function unknownSlugs(cells) {
  return [...new Set(occupants(cells)
    .map((o) => o.slug)
    .filter((slug) => !state.bySlug.has(slug)))];
}

/**
 * @param {Array} cells a snapshot's `cells`
 * @param {{cell?: number}} [opts] tile size in px; the default is thumb-sized
 */
export function mapHTML(cells, { cell = 13 } = {}) {
  const tiles = occupants(cells).map(({ cell: i, slug }) => {
    const place = `grid-row:${Math.floor(i / COLS) + 1};grid-column:${(i % COLS) + 1}`;
    const t = state.bySlug.get(slug);
    // Placed, but not in this roster: a custom Tatari, or one the wiki has
    // dropped since. Marked rather than skipped — see the header.
    if (!t) return `<span class="fmap__gap" style="${place}"></span>`;
    const src = artOf(t);
    return src
      ? `<img style="${place}" src="${esc(src)}" alt="" loading="lazy" decoding="async">`
      : `<span class="fmap__stub" style="${place}">${esc(t.name[0] ?? '?')}</span>`;
  }).join('');

  const size = cell === 13 ? '' : ` style="--fmap-cell:${cell}px"`;
  return `<span class="fmap"${size} aria-hidden="true">${tiles}</span>`;
}

/** The one-line facts under a formation's name. */
export function statsOf(snap) {
  const cells = Array.isArray(snap) ? snap : snap?.cells;
  return {
    placed: occupants(cells).length,
    modeLabel: MODES[snap?.mode]?.label ?? 'Solo',
    steps: Array.isArray(snap?.plan) ? snap.plan.length : 0,
  };
}

/** Fresh things say how fresh; older ones just say the day. */
export function fmtWhen(ts) {
  const at = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(at)) return '';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * "1 Tatari in this build is not in the roster any more", or nothing at all.
 * Kept here so the gallery and the saves list word it the same way.
 */
export function missingNote(cells) {
  const n = unknownSlugs(cells).length;
  if (!n) return '';
  return `${n} Tatari in this build ${n === 1 ? 'is' : 'are'} not in the roster any more`;
}
