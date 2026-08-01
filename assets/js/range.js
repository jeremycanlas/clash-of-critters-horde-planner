/**
 * Attack ranges, as tiles.
 *
 * The wiki documents range only as in-game screenshots, so the tile patterns in
 * data/ranges.json are read off those by hand. Coverage is therefore partial and
 * always will be for a while: a Tatari with no entry shows no range at all,
 * rather than a guess, because a wrong tile is worse than a missing one in a
 * tool people position by.
 *
 * Ranges are keyed by evolution line, matching how the game shares skills along
 * one, with a per-slug override for any form that differs.
 */

import { state } from './data.js';
import { COLS, ROWS } from './store.js';

/** The offsets for this Tatari, or null when nobody has recorded them. */
export function rangeOf(slug) {
  const tatari = state.bySlug.get(slug);
  if (!tatari || !state.ranges) return null;

  const bySlug = state.ranges.bySlug?.[slug];
  const byLine = state.ranges.byLine?.[lineKey(tatari)];
  return (bySlug ?? byLine)?.tiles ?? null;
}

export const hasRange = (slug) => rangeOf(slug) !== null;

/**
 * How well known this Tatari's reach is, for the range recorder's roster.
 *
 * Three states rather than two, because "somebody typed this in" and "somebody
 * checked it against the game" are not the same claim and the difference is the
 * whole reason coverage is worth showing. Several entries on file were read off
 * a sibling's diagram and say UNVERIFIED in their own note; those are recorded,
 * not verified.
 *
 * @param {string} slug
 * @param {'attack'|'heal'|'buff'|'debuff'} kind
 * @returns {'none'|'recorded'|'verified'}
 */
export function rangeStatus(slug, kind = 'attack') {
  const tatari = state.bySlug.get(slug);
  if (!tatari) return 'none';

  const book = kind === 'attack' ? state.ranges : state.effectRanges?.[kind];
  const entry = book?.bySlug?.[slug] ?? book?.byLine?.[lineKey(tatari)];
  // A reach with no shape carries no tiles at all, deliberately — a heal that
  // mends the whole team has no pattern to store. It is still a recorded reach,
  // and counting it as nothing would have the recorder ask for it again forever.
  if (!entry) return 'none';
  if (entry.scope !== 'all' && !entry.tiles?.length) return 'none';
  return entry.verified === true ? 'verified' : 'recorded';
}

/** The base form's slug, which is how ranges are keyed. */
function lineKey(tatari) {
  // One Map lookup. This used to scan all 218 Tatari, from inside loops that
  // themselves ran over all 218 — see data.js reindex() for the numbers.
  const base = state.baseOfFamily?.get(tatari.familyId);
  return (base ?? tatari).slug;
}

/**
 * Which cells this Tatari would cover standing on `cell`. Offsets that fall off
 * the field are dropped rather than wrapped — a Tatari on the left edge simply
 * covers less.
 */
export function coveredFrom(cell, slug) {
  const tiles = rangeOf(slug);
  if (tiles === null || cell === null) return [];

  const col = cell % COLS;
  const row = Math.floor(cell / COLS);
  const out = [];
  for (const [dCol, dRow] of tiles) {
    const c = col + dCol;
    const r = row + dRow;
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
    out.push(r * COLS + c);
  }
  return out;
}

/**
 * How many of these occupants cover each cell, for the coverage view.
 * @returns {{counts: number[], known: number, unknown: number}}
 */
export function coverage(occupants) {
  const counts = new Array(COLS * ROWS).fill(0);
  let known = 0, unknown = 0;

  for (const { cell, slug } of occupants) {
    if (!hasRange(slug)) { unknown++; continue; }
    known++;
    for (const covered of coveredFrom(cell, slug)) counts[covered]++;
  }
  return { counts, known, unknown };
}
