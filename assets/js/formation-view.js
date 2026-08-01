/**
 * A formation you are looking at, rather than the one you are editing.
 *
 * `card.js` draws the picture people actually post, and it read the live
 * formation directly — which was right while the only formation on the page was
 * yours. The community gallery has to draw somebody else's, and it has to draw
 * it with the *same* code: if the shared PNG gains a badge or changes its
 * spacing, every formation in the gallery should gain it too, without anyone
 * remembering to update a second renderer. Two renderers drift. One does not.
 *
 * So `viewOf(snapshot)` answers the same questions `store` answers, computed
 * from a snapshot instead of from live state. The shape is deliberately
 * identical to the part of store's surface that card.js touches, which means
 * `store` is itself a valid view and the live path is unchanged.
 *
 * Read-only by construction: there is no setter here, and nothing in this file
 * can move a Tatari. Drawing somebody else's build must never be able to touch
 * yours.
 */

import { state } from './data.js';
import { COLS, ROWS, CELLS, MAX_LEVEL, MODES } from './rules.js';

/** Mirrors store.js, so a caller can read either without knowing which it has. */
export const LF_LABELS = { lf: 'LF:', have: 'HAVE:' };

/**
 * @param {object} snap a store.snapshot(), or anything shaped like one
 * @returns {object} the read surface card.js uses
 */
export function viewOf(snap) {
  const mode = MODES[snap?.mode] ? snap.mode : 'solo';
  const cells = Array(CELLS).fill(null);
  (Array.isArray(snap?.cells) ? snap.cells : []).slice(0, CELLS).forEach((occ, i) => {
    const slug = typeof occ === 'string' ? occ : occ?.slug;
    if (slug) cells[i] = { slug, player: Number(occ?.player) || 1 };
  });

  const playerCount = MODES[mode].players;
  const players = () => Array.from({ length: playerCount }, (_, i) => i + 1);

  /*
   * A posted formation may name Tatari this roster does not have, and a bench
   * that was never sent still has to hold whatever is on the field — otherwise
   * the card draws a board with nobody brought. Back-filling here matches what
   * store.apply() does on the way in, so both paths agree.
   */
  const bench = { 1: [], 2: [] };
  for (const p of [1, 2]) {
    for (const slug of snap?.bench?.[p] ?? []) {
      if (typeof slug === 'string' && !bench[p].includes(slug)) bench[p].push(slug);
    }
  }
  cells.forEach((occ) => {
    if (occ && bench[occ.player] && !bench[occ.player].includes(occ.slug)) {
      bench[occ.player].push(occ.slug);
    }
  });

  const plan = (Array.isArray(snap?.plan) ? snap.plan : []).map((s) => ({
    members: (Array.isArray(s?.members) ? s.members : [])
      .map((m) => ({ slug: m?.slug, player: Number(m?.player) || 1 }))
      .filter((m) => m.slug),
    level: Number.isInteger(s?.level) && s.level >= 1 && s.level <= MAX_LEVEL ? s.level : null,
    note: typeof s?.note === 'string' ? s.note : '',
  })).filter((s) => s.members.length);

  const line = (raw) => ({
    wants: (Array.isArray(raw?.wants) ? raw.wants : []).filter((w) => typeof w === 'string'),
    note: typeof raw?.note === 'string' ? raw.note : '',
  });
  const lines = { lf: line(snap?.lines?.lf), have: line(snap?.lines?.have) };

  const formation = {
    mode, cells, bench, plan, lines,
    name: typeof snap?.name === 'string' ? snap.name : '',
    lfMode: snap?.lfMode === 'have' ? 'have' : 'lf',
    activePlayer: 1,
  };

  const cellOf = (slug, player) => {
    const i = cells.findIndex((o) => o && o.slug === slug && o.player === player);
    return i === -1 ? null : i;
  };

  const allPlaced = () => cells.reduce((out, occ, cell) => {
    if (occ) out.push({ cell, ...occ });
    return out;
  }, []);

  const stepPlayer = (step) => step.members[0]?.player ?? 1;
  const hasMember = (step, slug, player) =>
    step.members.some((m) => m.slug === slug && m.player === player);

  const planFor = (player) => plan
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => stepPlayer(step) === player);

  return {
    // constants, so a caller never has to import two modules to draw a grid
    COLS, ROWS, CELLS, MAX_LEVEL, MODES, LF_LABELS,

    formation,
    players,
    playerCount: () => playerCount,
    mode: () => MODES[mode],
    isCoop: () => playerCount > 1,
    benchCap: () => MODES[mode].bench,
    fieldCap: () => MODES[mode].field,

    benchOf: (player) => [...(bench[player] ?? [])],
    placedCount: (player) => cells.filter((o) => o && o.player === player).length,
    cellOf,
    allPlaced,

    filledLines: () => ['have', 'lf']
      .map((side) => ({ side, ...lines[side] }))
      .filter((l) => l.wants.length || l.note.trim()),

    planFor,

    /** The highest level this Tatari is planned to reach, or null. */
    topLevel(slug, player) {
      let top = null;
      for (const s of plan) {
        if (s.level === null || !hasMember(s, slug, player)) continue;
        if (top === null || s.level > top) top = s.level;
      }
      return top;
    },

    /** Where this Tatari first appears in its owner's plan, counting from 1. */
    planPositionOf(slug, player) {
      const at = planFor(player).findIndex(({ step }) => hasMember(step, slug, player));
      return at === -1 ? null : at + 1;
    },
  };
}

/** Every Tatari a view's card would draw, for warming sprites before it does. */
export function slugsOf(view) {
  return [
    ...view.formation.cells.filter(Boolean).map((o) => o.slug),
    ...view.players().flatMap((p) => view.benchOf(p)),
    ...view.filledLines().flatMap((l) => l.wants),
  ].filter((slug) => state.bySlug.has(slug));
}
