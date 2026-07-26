/**
 * Formation state: who is bringing what, where it stands, the order to spend
 * level-ups in, plus persistence, shareable URLs and JSON import/export.
 *
 * Two layers, because Horde has two:
 *   - a BENCH of up to 15 per player, the Tatari you bring into the run
 *   - the shared FIELD, where only some of your bench actually lands (the game
 *     offers you random choices, so co-op gets 10 of your 15 down)
 *
 * Co-op puts two players on one field. They may bring the same Tatari as each
 * other, so an occupant is identified by (slug, player) rather than slug alone.
 *
 * Invariants enforced here rather than in the UI:
 *   - a player's bench holds at most benchCap() Tatari
 *   - a player has at most fieldCap() Tatari on the field
 *   - within one player, at most one member of any evolution family
 *   - anything on the field is on that player's bench
 *   - a player can plan each level 1..MAX_LEVEL of a Tatari at most once
 */

import { state } from './data.js';

/** Your half of the Horde field: 6 tiles across, 5 deep. Zobos spawn beyond row 0. */
export const COLS = 6;
export const ROWS = 5;
export const CELLS = COLS * ROWS;

/** Tatari cap out at level 7. */
export const MAX_LEVEL = 7;

export const MODES = {
  solo: { label: 'Solo', players: 1, bench: 15, field: 15 },
  coop: { label: 'Co-op', players: 2, bench: 15, field: 10 },
};

// v4: occupants gained a player, and the bench layer is new. Earlier saves have
// no player information, so they are read as solo.
const SAVE_KEY = 'coc.formation.v4';
const HASH_VERSION = 'v4';

/**
 * @typedef {{slug: string, player: number}} Occupant
 * @typedef {{slug: string, player: number, level: number}} Step
 */

/**
 * @type {{mode: keyof MODES, cells: (Occupant|null)[], bench: Record<number, string[]>,
 *         plan: Step[], name: string, activePlayer: number}}
 */
export const formation = {
  mode: 'solo',
  cells: Array(CELLS).fill(null),
  bench: { 1: [], 2: [] },
  plan: [],
  name: '',
  activePlayer: 1,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() {
  reconcile();
  persist();
  for (const fn of listeners) fn();
}

// ---------------------------------------------------------------- mode

export const mode = () => MODES[formation.mode];
export const playerCount = () => mode().players;
export const benchCap = () => mode().bench;
export const fieldCap = () => mode().field;
export const isCoop = () => playerCount() > 1;
export const players = () => Array.from({ length: playerCount() }, (_, i) => i + 1);

/**
 * Switches mode. Going to solo discards player 2 entirely; either direction can
 * push a player over the new field cap, so the excess is unplaced (it stays on
 * the bench) rather than silently dropped.
 * @returns {{trimmed: number, discarded: number}}
 */
export function setMode(next) {
  if (!MODES[next] || next === formation.mode) return { trimmed: 0, discarded: 0 };
  formation.mode = next;

  let discarded = 0;
  if (playerCount() === 1) {
    discarded = formation.bench[2].length;
    formation.bench[2] = [];
    formation.activePlayer = 1;
  }

  let trimmed = 0;
  for (const player of players()) {
    const placed = placedFor(player);
    for (const { cell } of placed.slice(fieldCap())) {
      formation.cells[cell] = null;
      trimmed++;
    }
    formation.bench[player] = formation.bench[player].slice(0, benchCap());
  }
  emit();
  return { trimmed, discarded };
}

export function setActivePlayer(player) {
  if (!players().includes(player)) return;
  formation.activePlayer = player;
  for (const fn of listeners) fn();
}

// ---------------------------------------------------------------- queries

export const cellRow = (i) => Math.floor(i / COLS);
export const cellCol = (i) => i % COLS;

/** @returns {{cell: number, slug: string, player: number}[]} in cell order */
export function placedFor(player) {
  const out = [];
  formation.cells.forEach((occ, cell) => {
    if (occ && occ.player === player) out.push({ cell, slug: occ.slug, player });
  });
  return out;
}

export function allPlaced() {
  const out = [];
  formation.cells.forEach((occ, cell) => { if (occ) out.push({ cell, ...occ }); });
  return out;
}

export const placedCount = (player) => placedFor(player).length;
/** A copy - callers must go through addToBench/removeFromBench to change it. */
export const benchOf = (player) => [...(formation.bench[player] ?? [])];
export const onBench = (slug, player) => (formation.bench[player] ?? []).includes(slug);

/** Cell holding this player's copy of `slug`, or null. */
export function cellOf(slug, player = formation.activePlayer) {
  const i = formation.cells.findIndex((o) => o && o.slug === slug && o.player === player);
  return i === -1 ? null : i;
}

export const isPlaced = (slug, player) => cellOf(slug, player) !== null;

/** Benched but not on the field - the part of your 15 that has not landed. */
export function unplacedBench(player) {
  return benchOf(player).filter((slug) => cellOf(slug, player) === null);
}

/** A Tatari from the same evolution line already on this player's bench. */
export function familyConflict(tatari, player) {
  for (const slug of benchOf(player)) {
    const other = state.bySlug.get(slug);
    if (other && other.familyId === tatari.familyId && other.slug !== tatari.slug) return other;
  }
  return null;
}

/** Why `tatari` cannot join this player's bench, or null if it can. */
export function benchBlockedReason(tatari, player = formation.activePlayer) {
  if (onBench(tatari.slug, player)) return null;
  const clash = familyConflict(tatari, player);
  if (clash) return `${clash.name} from the same line is already on P${player}'s bench`;
  if (benchOf(player).length >= benchCap()) return `P${player}'s bench is full (${benchCap()} max)`;
  return null;
}

/** Why `tatari` cannot be placed on the field, or null if it can. */
export function placeBlockedReason(tatari, player = formation.activePlayer) {
  if (isPlaced(tatari.slug, player)) return 'Already on the field';
  const benched = benchBlockedReason(tatari, player);
  if (benched) return benched;
  if (placedCount(player) >= fieldCap()) return `P${player} has ${fieldCap()} on the field already`;
  return null;
}

// ---------------------------------------------------------------- bench

/** @returns {{ok: true} | {ok: false, reason: string}} */
export function addToBench(slug, player = formation.activePlayer) {
  const tatari = state.bySlug.get(slug);
  if (!tatari) return { ok: false, reason: 'Unknown Tatari' };
  if (onBench(slug, player)) return { ok: true };
  const reason = benchBlockedReason(tatari, player);
  if (reason) return { ok: false, reason };
  formation.bench[player].push(slug);
  emit();
  return { ok: true };
}

/** Drops a Tatari from a bench, which also takes it off the field and out of the plan. */
export function removeFromBench(slug, player = formation.activePlayer) {
  const i = formation.bench[player].indexOf(slug);
  if (i === -1) return;
  formation.bench[player].splice(i, 1);
  const cell = cellOf(slug, player);
  if (cell !== null) formation.cells[cell] = null;
  emit();
}

export function toggleBench(slug, player = formation.activePlayer) {
  if (onBench(slug, player)) { removeFromBench(slug, player); return { ok: true }; }
  return addToBench(slug, player);
}

export function clearBench(player) {
  formation.bench[player] = [];
  formation.cells = formation.cells.map((o) => (o && o.player === player ? null : o));
  emit();
}

// ---------------------------------------------------------------- field

/**
 * Puts a player's copy of `slug` in `cell`, benching it first if there is room.
 * Moving something already placed is a move, and a swap if the target is taken -
 * including a swap with the other player's token.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function place(slug, cell, player = formation.activePlayer) {
  const tatari = state.bySlug.get(slug);
  if (!tatari) return { ok: false, reason: 'Unknown Tatari' };
  if (cell < 0 || cell >= CELLS) return { ok: false, reason: 'Off the grid' };

  const from = cellOf(slug, player);
  if (from === cell) return { ok: true };

  if (from !== null) {
    const displaced = formation.cells[cell];
    formation.cells[cell] = { slug, player };
    formation.cells[from] = displaced;          // null when the target was empty
    emit();
    return { ok: true };
  }

  const reason = placeBlockedReason(tatari, player);
  if (reason) return { ok: false, reason };

  if (!onBench(slug, player)) formation.bench[player].push(slug);

  const evicted = formation.cells[cell];
  formation.cells[cell] = { slug, player };
  if (evicted) dropSteps(evicted.slug, evicted.player);   // it left the field
  emit();
  return { ok: true };
}

/** Rearmost free cell, so fresh picks land away from the contact line. */
export function firstFreeCell() {
  for (let i = CELLS - 1; i >= 0; i--) if (!formation.cells[i]) return i;
  return null;
}

export function autoPlace(slug, player = formation.activePlayer) {
  if (isPlaced(slug, player)) return { ok: true };
  const cell = firstFreeCell();
  if (cell === null) return { ok: false, reason: 'No empty cell' };
  return place(slug, cell, player);
}

/** Takes a token off the field. It stays on its owner's bench. */
export function unplaceAt(cell) {
  const occ = formation.cells[cell];
  if (!occ) return;
  formation.cells[cell] = null;
  dropSteps(occ.slug, occ.player);
  emit();
}

export function unplace(slug, player = formation.activePlayer) {
  const cell = cellOf(slug, player);
  if (cell !== null) unplaceAt(cell);
}

export function clearField() {
  formation.cells = Array(CELLS).fill(null);
  formation.plan = [];
  emit();
}

export function clearAll() {
  formation.cells = Array(CELLS).fill(null);
  formation.bench = { 1: [], 2: [] };
  formation.plan = [];
  emit();
}

export function setName(name) {
  formation.name = name;
  emit();
}

// ---------------------------------------------------------------- level plan

const sameStep = (s, slug, player) => s.slug === slug && s.player === player;

function dropSteps(slug, player) {
  formation.plan = formation.plan.filter((s) => !sameStep(s, slug, player));
}

export function plannedLevels(slug, player = formation.activePlayer) {
  return formation.plan.filter((s) => sameStep(s, slug, player))
    .map((s) => s.level).sort((a, b) => a - b);
}

export function topLevel(slug, player = formation.activePlayer) {
  const levels = plannedLevels(slug, player);
  return levels.length ? levels[levels.length - 1] : null;
}

/**
 * The level to offer next, or null once all MAX_LEVEL are planned. Prefers one
 * above the current top so repeated adds walk 1-2-3-4; falls back to the lowest
 * unplanned level, which fills the gaps left by a plan like "3, then 5".
 */
export function suggestedLevel(slug, player = formation.activePlayer) {
  const taken = new Set(plannedLevels(slug, player));
  const top = topLevel(slug, player);
  if (top !== null && top < MAX_LEVEL && !taken.has(top + 1)) return top + 1;
  for (let level = 1; level <= MAX_LEVEL; level++) if (!taken.has(level)) return level;
  return null;
}

/** @returns {{ok: true, index: number} | {ok: false, reason: string}} */
export function addStep(slug, level, player = formation.activePlayer) {
  const tatari = state.bySlug.get(slug);
  if (!tatari) return { ok: false, reason: 'Unknown Tatari' };
  if (cellOf(slug, player) === null) {
    return { ok: false, reason: `${tatari.name} is not on the field for P${player}` };
  }
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    return { ok: false, reason: `Level must be 1 to ${MAX_LEVEL}` };
  }
  if (plannedLevels(slug, player).includes(level)) {
    return { ok: false, reason: `${tatari.name} level ${level} is already planned` };
  }
  formation.plan.push({ slug, player, level });
  emit();
  return { ok: true, index: formation.plan.length - 1 };
}

export function removeStep(index) {
  if (index < 0 || index >= formation.plan.length) return;
  formation.plan.splice(index, 1);
  emit();
}

/** @returns {{ok: true} | {ok: false, reason: string}} */
export function setStepLevel(index, level) {
  const step = formation.plan[index];
  if (!step) return { ok: false, reason: 'No such step' };
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    return { ok: false, reason: `Level must be 1 to ${MAX_LEVEL}` };
  }
  const clash = formation.plan.some((s, i) =>
    i !== index && sameStep(s, step.slug, step.player) && s.level === level);
  if (clash) {
    const name = state.bySlug.get(step.slug)?.name ?? step.slug;
    return { ok: false, reason: `${name} level ${level} is already planned` };
  }
  step.level = level;
  emit();
  return { ok: true };
}

export function moveStep(from, to) {
  if (from < 0 || from >= formation.plan.length) return;
  const [step] = formation.plan.splice(from, 1);
  formation.plan.splice(Math.max(0, Math.min(to, formation.plan.length)), 0, step);
  emit();
}

export function clearPlan() {
  formation.plan = [];
  emit();
}

// ---------------------------------------------------------------- integrity

/**
 * Pulls state back inside the invariants after any change: unknown Tatari, ghost
 * players, over-cap benches and fields, family clashes, tokens that are not on
 * their owner's bench, and plan steps for anything no longer on the field.
 */
function reconcile() {
  const active = players();
  if (!active.includes(formation.activePlayer)) formation.activePlayer = 1;

  for (const player of [1, 2]) {
    if (!active.includes(player)) { formation.bench[player] = []; continue; }
    const seenFamilies = new Set();
    formation.bench[player] = (formation.bench[player] ?? []).filter((slug) => {
      const t = state.bySlug.get(slug);
      if (!t || seenFamilies.has(t.familyId)) return false;
      seenFamilies.add(t.familyId);
      return true;
    }).slice(0, benchCap());
  }

  const placedPerPlayer = { 1: 0, 2: 0 };
  formation.cells = formation.cells.map((occ) => {
    if (!occ) return null;
    if (!active.includes(occ.player)) return null;
    if (!onBench(occ.slug, occ.player)) return null;
    if (placedPerPlayer[occ.player] >= fieldCap()) return null;
    placedPerPlayer[occ.player]++;
    return occ;
  });

  const seenSteps = new Set();
  formation.plan = formation.plan.filter((s) => {
    const key = `${s.player}:${s.slug}:${s.level}`;
    if (seenSteps.has(key)) return false;
    if (!active.includes(s.player)) return false;
    if (!Number.isInteger(s.level) || s.level < 1 || s.level > MAX_LEVEL) return false;
    if (cellOf(s.slug, s.player) === null) return false;
    seenSteps.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- persistence

function persist() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      mode: formation.mode, cells: formation.cells, bench: formation.bench,
      plan: formation.plan, name: formation.name,
    }));
  } catch { /* private browsing, quota - not worth interrupting the user */ }
}

export function restore() {
  if (fromHash()) return true;
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!saved || !Array.isArray(saved.cells)) return false;
    apply(saved);
    return true;
  } catch { return false; }
}

/** Loads a raw state blob, letting reconcile() enforce every invariant. */
function apply({ mode: m, cells, bench, plan, name }) {
  formation.mode = MODES[m] ? m : 'solo';
  formation.bench = {
    1: Array.isArray(bench?.[1]) ? [...bench[1]] : [],
    2: Array.isArray(bench?.[2]) ? [...bench[2]] : [],
  };
  formation.cells = Array(CELLS).fill(null);
  (Array.isArray(cells) ? cells : []).slice(0, CELLS).forEach((occ, i) => {
    if (!occ) return;
    const slug = typeof occ === 'string' ? occ : occ.slug;
    const player = Number(typeof occ === 'string' ? 1 : occ.player) || 1;
    if (!slug || !state.bySlug.has(slug)) return;
    // A token implies its owner brought it, so back-fill the bench for older
    // saves and hand-written files that only list placements.
    if (!formation.bench[player].includes(slug)) formation.bench[player].push(slug);
    formation.cells[i] = { slug, player };
  });
  formation.plan = (Array.isArray(plan) ? plan : [])
    .filter((s) => s && typeof s.slug === 'string')
    .map((s) => ({ slug: s.slug, player: Number(s.player) || 1, level: Number(s.level) }));
  if (typeof name === 'string') formation.name = name;
  emit();
}

// ---------------------------------------------------------------- share links

/**
 * `#v4=<mode>/<layout>;<plan>` where layout is `player.slug@cell,...` and plan is
 * `player.slug.level,...` in the order the level-ups should be taken. Benched but
 * unplaced Tatari ride along as `player.slug@-`.
 */
export function shareUrl() {
  const tokens = [];
  for (const player of players()) {
    for (const { slug, cell } of placedFor(player)) tokens.push(`${player}.${slug}@${cell}`);
    for (const slug of unplacedBench(player)) tokens.push(`${player}.${slug}@-`);
  }
  const plan = formation.plan.map((s) => `${s.player}.${s.slug}.${s.level}`).join(',');
  const url = new URL(location.href);
  url.hash = tokens.length ? `${HASH_VERSION}=${formation.mode}/${tokens.join(',')};${plan}` : '';
  return url.toString();
}

/** @returns {{unknown: string[]}|null} null when the hash held no formation */
export function fromHash() {
  const m = location.hash.match(new RegExp(`${HASH_VERSION}=([^&]+)`));
  if (!m) return null;

  const raw = decodeURIComponent(m[1]);
  const slash = raw.indexOf('/');
  const modeName = slash === -1 ? 'solo' : raw.slice(0, slash);
  const [layoutPart = '', planPart = ''] = raw.slice(slash + 1).split(';');

  const cells = Array(CELLS).fill(null);
  const bench = { 1: [], 2: [] };
  const unknown = [];

  for (const token of layoutPart.split(',')) {
    const at = token.lastIndexOf('@');
    if (at === -1) continue;
    const dot = token.indexOf('.');
    const player = Number(token.slice(0, dot)) || 1;
    const slug = token.slice(dot + 1, at);
    const where = token.slice(at + 1);
    if (!slug) continue;
    if (!state.bySlug.has(slug)) { unknown.push(slug); continue; }
    if (!bench[player]) continue;
    if (!bench[player].includes(slug)) bench[player].push(slug);
    if (where === '-') continue;
    const cell = Number(where);
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS || cells[cell]) continue;
    cells[cell] = { slug, player };
  }

  const plan = [];
  for (const token of planPart.split(',')) {
    if (!token) continue;
    const parts = token.split('.');
    if (parts.length < 3) continue;
    plan.push({
      player: Number(parts[0]) || 1,
      slug: parts.slice(1, -1).join('.'),
      level: Number(parts[parts.length - 1]),
    });
  }

  apply({ mode: modeName, cells, bench, plan });
  return { unknown };
}

// ---------------------------------------------------------------- import/export

export function toJSON() {
  const describe = (slug) => {
    const t = state.bySlug.get(slug);
    return {
      slug, name: t?.name ?? slug, type: t?.type ?? null,
      role: t?.role ?? null, tier: t?.tier ?? null, custom: !!t?.custom,
    };
  };

  return {
    format: 'clash-of-critters-formation',
    version: 4,
    name: formation.name || 'Untitled formation',
    mode: formation.mode,
    rules: {
      columns: COLS, rows: ROWS, players: playerCount(),
      benchPerPlayer: benchCap(), fieldPerPlayer: fieldCap(), maxLevel: MAX_LEVEL,
    },
    players: players().map((player) => ({
      player,
      bench: benchOf(player).map((slug) => ({
        ...describe(slug),
        cell: cellOf(slug, player),
        row: cellOf(slug, player) === null ? null : cellRow(cellOf(slug, player)),
        column: cellOf(slug, player) === null ? null : cellCol(cellOf(slug, player)),
        onField: cellOf(slug, player) !== null,
        targetLevel: topLevel(slug, player),
      })),
    })),
    /** Ordered level-ups: step 1 is the first one you take. */
    levelPlan: formation.plan.map((s, i) => ({
      step: i + 1, player: s.player, slug: s.slug,
      name: state.bySlug.get(s.slug)?.name ?? s.slug, level: s.level,
    })),
    customTatari: state.all
      .filter((t) => t.custom && [1, 2].some((p) => onBench(t.slug, p)))
      .map(({ _search, ...rest }) => rest),
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Reads v4 files, and v1-v3 ones as a solo formation. Unknown slugs are reported
 * rather than swallowed - usually it means custom Tatari were not bundled along.
 * @returns {{ok: true, unknown: string[]} | {ok: false, reason: string}}
 */
export function fromJSON(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'Not a JSON object' };

  const unknown = [];
  const cells = Array(CELLS).fill(null);
  const bench = { 1: [], 2: [] };

  // Cell indices are only meaningful relative to the grid width they were
  // written for, so a differently-shaped file is read by row/column.
  const declaredCols = data.rules?.columns ?? data.grid?.columns ?? COLS;
  const sameShape = declaredCols === COLS;

  const put = (slug, player, cellHint, row, column) => {
    if (!slug) return;
    if (!state.bySlug.has(slug)) { unknown.push(slug); return; }
    if (!bench[player]) return;
    if (!bench[player].includes(slug)) bench[player].push(slug);
    let cell = Number.isInteger(row) && Number.isInteger(column) && column < COLS
      ? row * COLS + column
      : sameShape && Number.isInteger(cellHint) ? cellHint : null;
    if (cell === null || cell < 0 || cell >= CELLS || cells[cell]) return;
    cells[cell] = { slug, player };
  };

  if (Array.isArray(data.players)) {
    for (const entry of data.players) {
      const player = Number(entry?.player) || 1;
      for (const b of entry?.bench ?? []) {
        if (b?.onField === false) { if (bench[player] && !bench[player].includes(b.slug) && state.bySlug.has(b.slug)) bench[player].push(b.slug); continue; }
        put(b?.slug, player, b?.cell, b?.row, b?.column);
      }
    }
  } else if (Array.isArray(data.placements ?? data.cells)) {
    for (const p of data.placements ?? data.cells) {
      const slug = typeof p === 'string' ? p : p?.slug;
      put(slug, Number(p?.player) || 1, p?.cell, p?.row, p?.column);
    }
  } else {
    return { ok: false, reason: 'No "players" or "placements" data' };
  }

  // v1 and v2 carried a bare priority order with no levels, so there is nothing
  // to reconstruct - those import as a layout with an empty plan.
  const plan = Array.isArray(data.levelPlan)
    ? [...data.levelPlan].sort((a, b) => (a.step ?? 1e9) - (b.step ?? 1e9))
      .map((s) => ({ slug: s.slug, player: Number(s.player) || 1, level: Number(s.level) }))
    : [];

  apply({
    mode: MODES[data.mode] ? data.mode : 'solo',
    cells, bench, plan,
    name: typeof data.name === 'string' ? data.name : formation.name,
  });
  return { ok: true, unknown };
}
