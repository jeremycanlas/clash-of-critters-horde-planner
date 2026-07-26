/**
 * Formation state: what sits on the grid, the order to spend level-ups in, plus
 * persistence (localStorage), shareable URLs, and JSON import/export.
 *
 * Three invariants are enforced here rather than in the UI:
 *   - at most MAX_DEPLOYED Tatari on the grid
 *   - at most one member of any evolution family (T1..T4 are exclusive)
 *   - a Tatari can be planned at each level 1..MAX_LEVEL at most once
 */

import { state } from './data.js';

/**
 * Your half of the Horde field: 6 tiles across, 5 deep. Row 0 is the contact
 * line; the Zobos come in from beyond it and never occupy these cells.
 */
export const COLS = 6;
export const ROWS = 5;
export const CELLS = COLS * ROWS;
export const MAX_DEPLOYED = 15;

/** Tatari cap out at level 7, so that is the most steps any one of them can have. */
export const MAX_LEVEL = 7;

// v3: the level plan replaced the flat priority list. v2 state has no level
// information to migrate, so it is dropped rather than guessed at.
const SAVE_KEY = 'coc.formation.v3';
const HASH_VERSION = 'v3';

/**
 * @typedef {{slug: string, level: number}} Step
 * A single level-up you intend to take, e.g. Sealing to level 3.
 */

/** @type {{cells: (string|null)[], plan: Step[], name: string}} */
export const formation = {
  cells: Array(CELLS).fill(null),   // cell index -> slug
  plan: [],                         // ordered level-ups, earliest first
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
  if (replaced) dropSteps(replaced);
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
  dropSteps(slug);
  emit();
}

export function remove(slug) {
  const cell = cellOf(slug);
  if (cell !== null) removeAt(cell);
}

function dropSteps(slug) {
  formation.plan = formation.plan.filter((s) => s.slug !== slug);
}

export function clear() {
  formation.cells = Array(CELLS).fill(null);
  formation.plan = [];
  emit();
}

export function setName(name) {
  formation.name = name;
  emit();
}

// ---------------------------------------------------------------- level plan

/** Levels already planned for `slug`, ascending. */
export function plannedLevels(slug) {
  return formation.plan.filter((s) => s.slug === slug).map((s) => s.level).sort((a, b) => a - b);
}

/** Highest level `slug` is planned to reach, or null if it has no steps. */
export function topLevel(slug) {
  const levels = plannedLevels(slug);
  return levels.length ? levels[levels.length - 1] : null;
}

/**
 * The level to offer next for `slug`, or null once all MAX_LEVEL are planned.
 *
 * Prefers one above whatever it is currently planned to reach, so building
 * 1-2-3-4 is just repeated Add. Falls back to the lowest unplanned level, which
 * is what fills gaps left by a plan like "3, then 5".
 */
export function suggestedLevel(slug) {
  const taken = new Set(plannedLevels(slug));
  const top = topLevel(slug);
  if (top !== null && top < MAX_LEVEL && !taken.has(top + 1)) return top + 1;
  for (let level = 1; level <= MAX_LEVEL; level++) if (!taken.has(level)) return level;
  return null;
}

/**
 * Appends a level-up step. A Tatari must be on the grid to be levelled, and each
 * of its levels can only be planned once.
 * @returns {{ok: true, index: number} | {ok: false, reason: string}}
 */
export function addStep(slug, level) {
  const tatari = state.bySlug.get(slug);
  if (!tatari) return { ok: false, reason: 'Unknown Tatari' };
  if (cellOf(slug) === null) return { ok: false, reason: `${tatari.name} is not on the grid` };
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    return { ok: false, reason: `Level must be 1 to ${MAX_LEVEL}` };
  }
  if (plannedLevels(slug).includes(level)) {
    return { ok: false, reason: `${tatari.name} level ${level} is already planned` };
  }
  formation.plan.push({ slug, level });
  emit();
  return { ok: true, index: formation.plan.length - 1 };
}

export function removeStep(index) {
  if (index < 0 || index >= formation.plan.length) return;
  formation.plan.splice(index, 1);
  emit();
}

/**
 * Retargets an existing step. Refuses a level the same Tatari already has
 * planned elsewhere in the list.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function setStepLevel(index, level) {
  const step = formation.plan[index];
  if (!step) return { ok: false, reason: 'No such step' };
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    return { ok: false, reason: `Level must be 1 to ${MAX_LEVEL}` };
  }
  if (formation.plan.some((s, i) => i !== index && s.slug === step.slug && s.level === level)) {
    const name = state.bySlug.get(step.slug)?.name ?? step.slug;
    return { ok: false, reason: `${name} level ${level} is already planned` };
  }
  step.level = level;
  emit();
  return { ok: true };
}

/** Moves the step at `from` to position `to`. */
export function moveStep(from, to) {
  if (from < 0 || from >= formation.plan.length) return;
  const [step] = formation.plan.splice(from, 1);
  formation.plan.splice(Math.max(0, Math.min(to, formation.plan.length)), 0, step);
  emit();
}

/** Drops steps for anything no longer deployed, and any duplicate slug+level. */
function reconcilePlan() {
  const deployed = new Set(deployedSlugs());
  const seen = new Set();
  formation.plan = formation.plan.filter((s) => {
    const key = `${s.slug}@${s.level}`;
    if (!deployed.has(s.slug) || seen.has(key)) return false;
    if (!Number.isInteger(s.level) || s.level < 1 || s.level > MAX_LEVEL) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- persistence

function persist() {
  reconcilePlan();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      cells: formation.cells, plan: formation.plan, name: formation.name,
    }));
  } catch { /* private browsing, quota - not worth interrupting the user */ }
}

export function restore() {
  if (fromHash()) return true;
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!saved || !Array.isArray(saved.cells)) return false;
    applyCells(saved.cells, saved.plan);
    formation.name = saved.name || '';
    return true;
  } catch { return false; }
}

function applyCells(cells, plan) {
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
  formation.plan = (Array.isArray(plan) ? plan : [])
    .filter((s) => s && typeof s.slug === 'string')
    .map((s) => ({ slug: s.slug, level: Number(s.level) }));
  reconcilePlan();
}

// ---------------------------------------------------------------- share links

/**
 * `#v3=<layout>;<plan>` where layout is `slug@cell,...` and plan is
 * `slug.level,...` in the order they should be taken. Slugs are lowercase with
 * hyphens, so `@`, `.` and `;` are all safe separators and the link stays
 * readable.
 */
export function shareUrl() {
  const layout = deployedSlugs().map((slug) => `${slug}@${cellOf(slug)}`).join(',');
  const plan = formation.plan.map((s) => `${s.slug}.${s.level}`).join(',');
  const url = new URL(location.href);
  url.hash = layout ? `${HASH_VERSION}=${layout};${plan}` : '';
  return url.toString();
}

/** @returns {{unknown: string[]}|null} null when the hash held no formation */
export function fromHash() {
  const m = location.hash.match(new RegExp(`${HASH_VERSION}=([^&]+)`));
  if (!m) return null;

  const [layoutPart = '', planPart = ''] = decodeURIComponent(m[1]).split(';');
  const cells = Array(CELLS).fill(null);
  const unknown = [];

  for (const token of layoutPart.split(',')) {
    const [slug, cellStr] = token.split('@');
    const cell = Number(cellStr);
    if (!slug || !Number.isInteger(cell) || cell < 0 || cell >= CELLS) continue;
    if (!state.bySlug.has(slug)) { unknown.push(slug); continue; }
    if (cells[cell]) continue;
    cells[cell] = slug;
  }

  const plan = [];
  for (const token of planPart.split(',')) {
    if (!token) continue;
    const dot = token.lastIndexOf('.');
    if (dot === -1) continue;
    plan.push({ slug: token.slice(0, dot), level: Number(token.slice(dot + 1)) });
  }

  applyCells(cells, plan);
  return { unknown };
}

// ---------------------------------------------------------------- import/export

export function toJSON() {
  return {
    format: 'clash-of-critters-formation',
    version: 3,
    name: formation.name || 'Untitled formation',
    grid: { columns: COLS, rows: ROWS, maxDeployed: MAX_DEPLOYED, maxLevel: MAX_LEVEL },
    placements: deployedSlugs().map((slug) => {
      const t = state.bySlug.get(slug);
      const cell = cellOf(slug);
      return {
        slug, name: t?.name ?? slug, type: t?.type ?? null, role: t?.role ?? null,
        tier: t?.tier ?? null, cell, row: cellRow(cell), column: cellCol(cell),
        targetLevel: topLevel(slug), custom: !!t?.custom,
      };
    }),
    /** Ordered level-ups: step 1 is the first one you take. */
    levelPlan: formation.plan.map((s, i) => ({
      step: i + 1,
      slug: s.slug,
      name: state.bySlug.get(s.slug)?.name ?? s.slug,
      level: s.level,
    })),
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
  const unknown = [];

  // A flat cell index only means anything relative to the grid width it was
  // written for, so a file from a differently-shaped grid is read by row/column.
  const sameShape = (data.grid?.columns ?? COLS) === COLS;

  for (const p of placements) {
    const slug = typeof p === 'string' ? p : p.slug;
    if (!slug) continue;
    if (!state.bySlug.has(slug)) { unknown.push(slug); continue; }
    let cell = Number.isInteger(p.row) && Number.isInteger(p.column) && p.column < COLS
      ? p.row * COLS + p.column
      : sameShape && Number.isInteger(p.cell) ? p.cell
        : null;
    if (cell === null || cell < 0 || cell >= CELLS || cells[cell]) {
      cell = cells.findLastIndex((c) => c === null);
      if (cell === -1) continue;
    }
    cells[cell] = slug;
  }

  // v1 and v2 files carry a bare priority order with no levels attached, so
  // there is nothing to reconstruct - those import as a layout with an empty plan.
  const plan = Array.isArray(data.levelPlan)
    ? [...data.levelPlan]
      .sort((a, b) => (a.step ?? 1e9) - (b.step ?? 1e9))
      .map((s) => ({ slug: s.slug, level: Number(s.level) }))
    : [];

  applyCells(cells, plan);
  formation.name = typeof data.name === 'string' ? data.name : formation.name;
  emit();
  return { ok: true, unknown };
}
