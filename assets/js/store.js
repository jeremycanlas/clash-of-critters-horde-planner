/**
 * Formation state: what sits on the grid, in what level-up order, plus
 * persistence (localStorage), shareable URLs, and JSON import/export.
 *
 * Two invariants are enforced here rather than in the UI:
 *   - at most MAX_DEPLOYED Tatari on the grid
 *   - at most one member of any evolution family (T1..T4 are exclusive)
 */

import { state } from './data.js';

export const COLS = 5;
export const ROWS = 6;
export const CELLS = COLS * ROWS;
export const MAX_DEPLOYED = 15;

const SAVE_KEY = 'coc.formation.v1';

/** @type {{cells: (string|null)[], priority: string[], name: string}} */
export const formation = {
  cells: Array(CELLS).fill(null),   // cell index -> slug
  priority: [],                     // slugs, highest level-up priority first
  name: '',
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() {
  persist();
  for (const fn of listeners) fn();
}

// ---------------------------------------------------------------- queries

export const cellRow = (i) => Math.floor(i / COLS);
export const cellCol = (i) => i % COLS;

export function deployedSlugs() {
  return formation.cells.filter(Boolean);
}

export function deployedCount() {
  return deployedSlugs().length;
}

export function cellOf(slug) {
  const i = formation.cells.indexOf(slug);
  return i === -1 ? null : i;
}

/** The Tatari from the same family that is already deployed, if any. */
export function familyConflict(tatari) {
  for (const slug of deployedSlugs()) {
    const other = state.bySlug.get(slug);
    if (other && other.familyId === tatari.familyId && other.slug !== tatari.slug) return other;
  }
  return null;
}

/** Why a Tatari cannot be placed right now, or null if it can. */
export function blockedReason(tatari) {
  if (cellOf(tatari.slug) !== null) return 'Already on the grid';
  const clash = familyConflict(tatari);
  if (clash) return `${clash.name} from the same line is deployed`;
  if (deployedCount() >= MAX_DEPLOYED) return `Grid is full (${MAX_DEPLOYED} max)`;
  return null;
}

// ---------------------------------------------------------------- mutations

/**
 * Puts `slug` in `cell`. Moving something already on the grid is a move (and a
 * swap if the target is taken); anything else is a fresh placement subject to
 * the deploy cap and family exclusion.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function place(slug, cell) {
  const tatari = state.bySlug.get(slug);
  if (!tatari) return { ok: false, reason: 'Unknown Tatari' };
  if (cell < 0 || cell >= CELLS) return { ok: false, reason: 'Off the grid' };

  const from = cellOf(slug);
  if (from === cell) return { ok: true };

  if (from !== null) {
    const displaced = formation.cells[cell];
    formation.cells[cell] = slug;
    formation.cells[from] = displaced;      // null when the target was empty
    emit();
    return { ok: true };
  }

  const reason = blockedReason(tatari);
  if (reason) return { ok: false, reason };

  const replaced = formation.cells[cell];
  formation.cells[cell] = slug;
  if (replaced) dropFromPriority(replaced);
  if (!formation.priority.includes(slug)) formation.priority.push(slug);
  emit();
  return { ok: true };
}

/** First free cell, scanning back rows first so new picks land out of harm's way. */
export function firstFreeCell() {
  for (let i = CELLS - 1; i >= 0; i--) if (!formation.cells[i]) return i;
  return null;
}

export function autoPlace(slug) {
  const cell = firstFreeCell();
  if (cell === null) return { ok: false, reason: 'No empty cell' };
  return place(slug, cell);
}

export function removeAt(cell) {
  const slug = formation.cells[cell];
  if (!slug) return;
  formation.cells[cell] = null;
  dropFromPriority(slug);
  emit();
}

export function remove(slug) {
  const cell = cellOf(slug);
  if (cell !== null) removeAt(cell);
}

function dropFromPriority(slug) {
  const i = formation.priority.indexOf(slug);
  if (i !== -1) formation.priority.splice(i, 1);
}

export function clear() {
  formation.cells = Array(CELLS).fill(null);
  formation.priority = [];
  emit();
}

export function setName(name) {
  formation.name = name;
  emit();
}

/** Moves `slug` to position `to` in the level-up priority order. */
export function reprioritize(slug, to) {
  const from = formation.priority.indexOf(slug);
  if (from === -1) return;
  formation.priority.splice(from, 1);
  formation.priority.splice(Math.max(0, Math.min(to, formation.priority.length)), 0, slug);
  emit();
}

/** Keeps priority in sync with the grid: no ghosts, no omissions. */
function reconcilePriority() {
  const deployed = new Set(deployedSlugs());
  formation.priority = formation.priority.filter((s) => deployed.has(s));
  for (const slug of deployedSlugs()) {
    if (!formation.priority.includes(slug)) formation.priority.push(slug);
  }
}

// ---------------------------------------------------------------- persistence

function persist() {
  reconcilePriority();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      cells: formation.cells, priority: formation.priority, name: formation.name,
    }));
  } catch { /* private browsing, quota - not worth interrupting the user */ }
}

export function restore() {
  if (fromHash()) return true;
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!saved || !Array.isArray(saved.cells)) return false;
    applyCells(saved.cells, saved.priority);
    formation.name = saved.name || '';
    return true;
  } catch { return false; }
}

function applyCells(cells, priority) {
  formation.cells = Array(CELLS).fill(null);
  const seenFamilies = new Set();
  let n = 0;
  cells.slice(0, CELLS).forEach((slug, i) => {
    const t = slug && state.bySlug.get(slug);
    if (!t || n >= MAX_DEPLOYED || seenFamilies.has(t.familyId)) return;
    formation.cells[i] = slug;
    seenFamilies.add(t.familyId);
    n++;
  });
  formation.priority = (Array.isArray(priority) ? priority : []).filter((s) => formation.cells.includes(s));
  reconcilePriority();
}

// ---------------------------------------------------------------- share links

/**
 * `#v1=slug@cell,slug@cell,...` - array order is the level-up priority, so one
 * short readable token carries both the layout and the plan.
 */
export function shareUrl() {
  const tokens = formation.priority.map((slug) => `${slug}@${cellOf(slug)}`);
  const url = new URL(location.href);
  url.hash = tokens.length ? `v1=${tokens.join(',')}` : '';
  return url.toString();
}

/** @returns {{unknown: string[]}|null} null when the hash held no formation */
export function fromHash() {
  const m = location.hash.match(/v1=([^&]+)/);
  if (!m) return null;

  const cells = Array(CELLS).fill(null);
  const priority = [];
  const unknown = [];

  for (const token of decodeURIComponent(m[1]).split(',')) {
    const [slug, cellStr] = token.split('@');
    const cell = Number(cellStr);
    if (!slug || !Number.isInteger(cell) || cell < 0 || cell >= CELLS) continue;
    if (!state.bySlug.has(slug)) { unknown.push(slug); continue; }
    if (cells[cell]) continue;
    cells[cell] = slug;
    priority.push(slug);
  }
  applyCells(cells, priority);
  return { unknown };
}

// ---------------------------------------------------------------- import/export

export function toJSON() {
  return {
    format: 'clash-of-critters-formation',
    version: 1,
    name: formation.name || 'Untitled formation',
    grid: { columns: COLS, rows: ROWS, maxDeployed: MAX_DEPLOYED },
    placements: formation.priority.map((slug, i) => {
      const t = state.bySlug.get(slug);
      const cell = cellOf(slug);
      return {
        slug, name: t?.name ?? slug, type: t?.type ?? null, role: t?.role ?? null,
        tier: t?.tier ?? null, cell, row: cellRow(cell), column: cellCol(cell),
        levelPriority: i + 1, custom: !!t?.custom,
      };
    }),
    customTatari: state.all
      .filter((t) => t.custom && formation.cells.includes(t.slug))
      .map(({ _search, ...rest }) => rest),
    exportedAt: new Date().toISOString(),
  };
}

/**
 * @returns {{ok: true, unknown: string[]} | {ok: false, reason: string}}
 * Unknown slugs are reported rather than swallowed - usually it means the file
 * used custom Tatari that were not bundled with it.
 */
export function fromJSON(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'Not a JSON object' };
  const placements = data.placements ?? data.cells;
  if (!Array.isArray(placements)) return { ok: false, reason: 'No "placements" array' };

  const cells = Array(CELLS).fill(null);
  const ordered = [];
  const unknown = [];

  const sorted = [...placements].sort(
    (a, b) => (a.levelPriority ?? 1e9) - (b.levelPriority ?? 1e9));

  for (const p of sorted) {
    const slug = typeof p === 'string' ? p : p.slug;
    if (!slug) continue;
    if (!state.bySlug.has(slug)) { unknown.push(slug); continue; }
    let cell = Number.isInteger(p.cell) ? p.cell
      : Number.isInteger(p.row) && Number.isInteger(p.column) ? p.row * COLS + p.column
        : null;
    if (cell === null || cell < 0 || cell >= CELLS || cells[cell]) {
      cell = cells.findLastIndex((c) => c === null);
      if (cell === -1) continue;
    }
    cells[cell] = slug;
    ordered.push(slug);
  }

  applyCells(cells, ordered);
  formation.name = typeof data.name === 'string' ? data.name : formation.name;
  emit();
  return { ok: true, unknown };
}
