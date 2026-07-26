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

/** The base form's slug, which is how ranges are keyed. */
function lineKey(tatari) {
  const base = state.all.find((t) => t.familyId === tatari.familyId && t.tier === 1);
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
