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

import { state, pieceBySlug } from './data.js';
import {
  COLS, ROWS, CELLS, MAX_LEVEL, MODES, cellRow, cellCol,
  ALL_CELLS, ENEMY_FIRST, ENEMY_ROWS, ENEMY_CELLS, isEnemyCell, cellDisplayRow,
  capsFor, cellCountFor, SANDBOX,
} from './rules.js';
import { toFragment, fromFragment } from './hash.js';

/*
 * The grid's shape lives in rules.js so a page that only draws formations can
 * have it without this module's 1000 lines behind it. Re-exported here because
 * every existing caller says `store.COLS`, and moving a constant is not a
 * reason to touch thirty call sites.
 */
export {
  COLS, ROWS, CELLS, MAX_LEVEL, MODES, cellRow, cellCol,
  ALL_CELLS, ENEMY_FIRST, ENEMY_ROWS, ENEMY_CELLS, isEnemyCell, cellDisplayRow,
  SANDBOX,
};

// v4: occupants gained a player, and the bench layer is new. Earlier saves have
// no player information, so they are read as solo.
// v5: a plan step names one or more Tatari and can carry a note. The save key is
// deliberately left at v4 - apply() reads both step shapes, so an existing plan
// survives the upgrade rather than being thrown away.
const SAVE_KEY = 'coc.formation.v4';

/**
 * @typedef {{slug: string, player: number}} Occupant
 * @typedef {{members: Occupant[], level: number|null, note: string}} Step
 */

/**
 * @type {{mode: keyof MODES, cells: (Occupant|null)[], bench: Record<number, string[]>,
 *         plan: Step[], name: string, lf: string, activePlayer: number}}
 */
export const formation = {
  mode: 'solo',
  /*
   * Caps off, whole board reachable. Orthogonal to mode — see SANDBOX in
   * rules.js for why it is a flag over Solo/Co-op rather than a third mode.
   */
  sandbox: false,
  /*
   * The ground beyond the contact line. Its own flag, and independent of
   * Sandbox: this says how much board there is, Sandbox says how much you may
   * bring, and either is worth wanting without the other.
   */
  zoboGround: false,
  /*
   * How many rows past the contact line the boss pull has opened, 0 to
   * ENEMY_ROWS.
   *
   * A pull that lands past row 0 needs somewhere real to put a Tatari. That used
   * to be a strip drawn outside the grid, which meant the Tatari standing on it
   * were nowhere — not in a cell, not draggable, and not addressable by anything
   * that works in cell indices. So the pull borrows the Zobo rows instead, one at
   * a time as it needs them, and they behave like every other cell: you can drag
   * out of them, drop into them and move along them.
   *
   * Persisted with the formation because it decides which cells are real. A save
   * written mid-pull would otherwise come back with its outermost Tatari cleared
   * by reconcile() for standing off the board.
   */
  pullRows: 0,
  /*
   * Always ALL_CELLS long, in both directions of the toggle. The alternative is
   * resizing on every switch, which means every index held anywhere else — a
   * drag in flight, a live peer's cursor, a plan step — is briefly pointing past
   * the end of the array. Cells 36..77 simply stay null outside Sandbox, and
   * reconcile() is what guarantees it.
   */
  cells: Array(ALL_CELLS).fill(null),
  bench: { 1: [], 2: [] },
  plan: [],
  name: '',
  /*
   * Co-op "looking for": what this player still wants a teammate to bring.
   * It is drawn on the field itself rather than only in the share sheet,
   * because people post a screenshot of the grid far more often than they use
   * the download button, and the ask has to survive being cropped out.
   */
  /**
   * Two independent lines, because "I have these, looking for those" is one
   * sentence and people were having to pick half of it. Either, neither or
   * both can carry Tatari and a free-text note; only the filled ones are drawn.
   */
  lines: {
    lf: { wants: [], note: '' },
    have: { wants: [], note: '' },
  },
  /** Which of the two the editor is pointed at. */
  lfMode: 'lf',
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
export const isSandbox = () => formation.sandbox === true;
/**
 * The caps actually in force. Every limit in this file reads through these two,
 * so turning Sandbox on lifts them everywhere at once — placeBlockedReason(),
 * reconcile() and the summary all follow without knowing Sandbox exists.
 */
export const caps = () => capsFor(formation.mode, formation.sandbox);
export const playerCount = () => caps().players;
export const benchCap = () => caps().bench;
export const fieldCap = () => caps().field;
export const isZoboGround = () => formation.zoboGround === true;
export const pullRows = () => formation.pullRows;

/*
 * The two questions card.js asks to draw the ground past the contact line — the
 * Zobo ground, or the rows a boss or second pull opened. viewOf() answers these
 * for a snapshot; without them here the *live* Share card (which draws store
 * directly) fell back to zero and quietly left every beyond-the-line row out.
 * Same formulas as viewOf, so the live card and a gallery card cannot drift.
 */
export const beyondRows = () => (formation.zoboGround ? ENEMY_ROWS : formation.pullRows);
export const cellAtRow = (row, col) => (row >= 0
  ? row * COLS + col
  : ENEMY_FIRST + (row + ENEMY_ROWS) * COLS + col);

/**
 * Whether a cell is part of the board right now.
 *
 * The field always is. Past the contact line it depends on two independent
 * things: the Zobo ground opens all seven rows at once, and a boss pull opens
 * them one at a time from the line outwards. Either is enough.
 *
 * Not expressible as "cell < some number", which is why this is a predicate:
 * the Zobo rows are numbered outermost-first (36 is row -7) while they come into
 * play innermost-first (row -1 before -2), so the live range is a suffix of the
 * array rather than a prefix.
 */
export function cellInPlay(cell) {
  if (cell < 0 || cell >= ALL_CELLS) return false;
  if (!isEnemyCell(cell)) return cell < CELLS;
  if (formation.zoboGround) return true;
  return cellDisplayRow(cell) >= -formation.pullRows;
}

/**
 * Moves a batch of occupants at once, for the boss pull.
 *
 * Not a loop over place(): every one of these is a move the drafting rules would
 * refuse to make on its own — a Tatari landing on ground that only exists
 * because of the pull, a lane rearranging in an order that is briefly two-in-a-
 * cell. The pull is not the player choosing anything, it is the game acting on
 * a formation, so it writes positions directly and leaves benches, caps and the
 * plan untouched.
 *
 * Sources are cleared before destinations are written, so a chain that walks a
 * Tatari into the cell another is leaving cannot lose one.
 *
 * @param {{from: number, to: number, slug: string, player: number}[]} moves
 * @returns {typeof moves} the ones that actually happened
 */
export function movePositions(moves, openRows = 0) {
  /*
   * The rows and the moves are opened and made in the same breath, before a
   * single emit. They cannot be two calls: reconcile() shrinks the pull rows
   * back to whatever is standing on them, so opening a row and then filling it
   * meant the row was closed again in between — and the Tatari that was about to
   * stand there landed on a cell that had just stopped existing.
   */
  if (openRows) {
    formation.pullRows = Math.max(formation.pullRows,
      Math.max(0, Math.min(ENEMY_ROWS, Math.floor(openRows))));
  }

  const done = [];
  for (const m of moves) {
    const occ = formation.cells[m.from];
    if (!occ || occ.slug !== m.slug || occ.player !== m.player) continue;
    formation.cells[m.from] = null;
    done.push(m);
  }
  for (const m of done) formation.cells[m.to] = { slug: m.slug, player: m.player };
  emit();
  return done;
}

/**
 * Puts moved occupants back, best effort.
 *
 * Best effort because the board was editable in between: the Tatari may have
 * been dragged somewhere else, deleted, or had something dropped into the cell
 * it came from. A move is only reversed when the thing that moved is still where
 * the pull left it, and the cell it came from is still free — anything else and
 * the player's own edit is the more recent truth and wins.
 */
export function restorePositions(moves) {
  for (const m of [...moves].reverse()) {
    const at = formation.cells[m.to];
    if (!at || at.slug !== m.slug || at.player !== m.player) continue;
    if (formation.cells[m.from]) continue;
    formation.cells[m.to] = null;
    formation.cells[m.from] = { slug: m.slug, player: m.player };
  }
  emit();
}

/**
 * Closes the ground the pull opened, bringing home anything still standing on it.
 *
 * restorePositions() puts back what the pull moved and nothing else, on purpose:
 * a Tatari you dragged somewhere yourself is your decision, and yanking it back
 * would overrule an edit you made more recently than the pull. But that leaves
 * it standing on rows that only exist *because* the pull is on, and switching
 * the pull off then either strands it out there with the red ground stuck open
 * forever, or — depending on which row emptied first — has reconcile() quietly
 * unplace it onto the bench.
 *
 * So anything still past the line comes back to the field, and it lines up
 * behind the rearmost Tatari in its own lane. The boss dragged it forward out of
 * the back of a rank; letting go should undo that direction and put it back on
 * the end of that rank — not at the contact line where it never chose to stand,
 * and not in whatever hole happens to be deepest. Its own column, because that
 * is the lane it was taken from; the rearmost free tile anywhere only if that
 * lane is occupied all the way to the back.
 *
 * If the field is genuinely full it is unplaced and stays on its owner's bench,
 * which is the same outcome every other over-capacity path in this file
 * produces.
 *
 * Does nothing when the Zobo ground is open — those rows are not the pull's to
 * close.
 */
export function evacuatePullRows() {
  if (formation.zoboGround || !formation.pullRows) return { moved: 0, benched: 0 };

  /**
   * The tile immediately behind the rearmost Tatari in `col`, or null if that
   * lane is occupied all the way to the back.
   *
   * Behind the last one, not at the bottom of the lane: the boss took it from
   * the back of a rank, so it rejoins the back of that rank rather than being
   * parked in whatever hole is deepest. A lane with Tatari at rows 1 and 3 takes
   * it at row 4, and an empty lane takes it at row 0 — there is nothing for it
   * to line up behind, so it is the front of its own lane.
   *
   * Everything past the rearmost occupant is free by definition, so the tile
   * this returns needs no further check.
   */
  const behindRearmost = (col) => {
    let last = -1;
    for (let row = 0; row < ROWS; row++) if (formation.cells[row * COLS + col]) last = row;
    const target = last + 1;
    return target < ROWS ? target * COLS + col : null;
  };
  const backAnywhere = () => {
    for (let i = CELLS - 1; i >= 0; i--) if (!formation.cells[i]) return i;
    return null;
  };

  let moved = 0;
  let benched = 0;
  formation.cells.forEach((occ, cell) => {
    if (!occ || !isEnemyCell(cell)) return;
    formation.cells[cell] = null;                       // free it before looking
    const home = behindRearmost(cellCol(cell)) ?? backAnywhere();
    if (home === null) { benched++; return; }
    formation.cells[home] = occ;
    moved++;
  });

  // reconcile() reads the rows back down to nothing now that they are empty.
  formation.pullRows = 0;
  emit();
  return { moved, benched };
}

/** Opens or closes rows past the line for the pull. Clamped to what exists. */
export function setPullRows(n) {
  const next = Math.max(0, Math.min(ENEMY_ROWS, Math.floor(n) || 0));
  if (next === formation.pullRows) return;
  formation.pullRows = next;
  emit();
}
/** How many cells are in play: the field alone, or the field and the Zobo rows. */
export const cellCount = () => cellCountFor(formation.zoboGround);
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

/**
 * What leaving Sandbox would cost, worked out without changing anything.
 *
 * The caller needs this *before* the switch, not after. Every other trim in
 * this file is small and reversible enough to report as it happens — losing the
 * back half of a 30-strong bench is neither, so the toggle asks first, and it
 * can only ask if the numbers are knowable in advance.
 *
 * Two things happen on the way out, and only the second loses anything:
 *
 *   1. anything over the field cap comes off the board — those Tatari are still
 *      on their bench, so nothing is lost;
 *   2. the bench is cut to its cap, and whatever is past the cut is gone.
 *
 * Nothing here is about the Zobo rows any more. Leaving Sandbox used to close
 * them, so everything standing out there was counted as coming off; now that
 * ground has its own switch and stays exactly as it was. A cell past the line
 * counts against the field cap like any other and is trimmed on the same rule.
 *
 * @returns {{unplaced: number, dropped: number, wouldLose: boolean}}
 */
export function sandboxExitCost() {
  const next = capsFor(formation.mode, false);
  const active = Array.from({ length: next.players }, (_, i) => i + 1);

  let unplaced = 0;
  const placedPerPlayer = { 1: 0, 2: 0 };
  formation.cells.forEach((occ) => {
    if (!occ) return;
    if (!active.includes(occ.player)) { unplaced++; return; }
    if (placedPerPlayer[occ.player] >= next.field) { unplaced++; return; }
    placedPerPlayer[occ.player]++;
  });

  // Dropping player 2 in Solo takes their whole bench; that is setMode's
  // business, not this function's, so only active players are counted here.
  let dropped = 0;
  for (const player of active) {
    dropped += Math.max(0, (formation.bench[player] ?? []).length - next.bench);
  }

  return { unplaced, dropped, wouldLose: dropped > 0 };
}

/**
 * Turns Sandbox on or off.
 *
 * Going in changes nothing about the formation — the caps lift and 42 more
 * cells become reachable, and anything already placed stays exactly where it
 * is. Coming out is the lossy direction, and reconcile() does the actual work:
 * it already clears over-cap cells and cuts over-cap benches, and now that the
 * caps read through the flag it needs no idea Sandbox exists.
 *
 * The counts come from sandboxExitCost() before the flag moves, so what the
 * caller reports is what the caller was able to warn about.
 *
 * @returns {{unplaced: number, dropped: number, beyondLine: number}}
 */
export function setSandbox(on) {
  const next = !!on;
  const nothing = { unplaced: 0, dropped: 0 };
  if (next === formation.sandbox) return nothing;

  const cost = next ? nothing : sandboxExitCost();
  formation.sandbox = next;
  emit();
  return cost;
}

/**
 * Opens or closes the ground beyond the contact line.
 *
 * Closing it is lossless, which is why it needs no warning and no confirm:
 * anything standing out there is unplaced, and everything on the field is on its
 * owner's bench by invariant, so the Tatari are kept and only their positions
 * go. reconcile() does the clearing off the back of the flag — see the `reach`
 * check there.
 *
 * @returns {{unplaced: number}} how many came off the Zobo rows
 */
export function setZoboGround(on) {
  const next = !!on;
  if (next === formation.zoboGround) return { unplaced: 0 };

  let unplaced = 0;
  if (!next) {
    formation.cells.forEach((occ, cell) => { if (occ && isEnemyCell(cell)) unplaced++; });
  }
  formation.zoboGround = next;
  emit();
  return { unplaced };
}

export function setActivePlayer(player) {
  if (!players().includes(player)) return;
  formation.activePlayer = player;
  for (const fn of listeners) fn();
}

// ---------------------------------------------------------------- queries

/** @returns {{cell: number, slug: string, player: number}[]} in cell order */
export function placedFor(player) {
  const out = [];
  formation.cells.forEach((occ, cell) => {
    if (occ && occ.player === player && occ.player > 0) out.push({ cell, slug: occ.slug, player });
  });
  return out;
}

/** Every Zobo standing on the board, in cell order. Nobody owns them. */
export function placedZobos() {
  const out = [];
  formation.cells.forEach((occ, cell) => {
    if (occ && occ.kind === 'zobo') out.push({ cell, slug: occ.slug });
  });
  return out;
}

export const isZoboAt = (cell) => formation.cells[cell]?.kind === 'zobo';

/**
 * Moves whatever is standing on one cell to another, addressed by cell.
 *
 * Everything else in this file identifies an occupant by (slug, player), which
 * is unique for a Tatari and meaningless for a Zobo: the same Zobo standing in
 * six places is the ordinary case, so "move the Ordinary Zobo" does not name
 * one. Dragging one therefore has to say which tile it came from, and this is
 * what takes that answer.
 *
 * Swaps when the target is occupied, matching how a Tatari move behaves.
 */
export function moveFrom(fromCell, toCell) {
  const occ = formation.cells[fromCell];
  if (!occ) return { ok: false, reason: 'Nothing there' };
  if (!cellInPlay(toCell)) {
    return { ok: false, reason: isEnemyCell(toCell) ? 'Turn on Zobo ground to use those rows' : 'Off the grid' };
  }
  if (fromCell === toCell) return { ok: true };

  const displaced = formation.cells[toCell] ?? null;
  formation.cells[toCell] = occ;
  formation.cells[fromCell] = displaced;
  emit();
  return { ok: true };
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

/**
 * Why `tatari` cannot join this player's bench, or null if it can.
 *
 * Exported for the same reason placeBlockedReason is: a drop target has to know
 * whether a drop would be accepted *before* it is made, so it can decline to
 * light up, and the alternative is the caller re-deriving the family and cap
 * rules and drifting out of step with them.
 */
export function benchBlockedReason(tatari, player = formation.activePlayer) {
  if (onBench(tatari.slug, player)) return null;
  // Sandbox lets a whole line stand at once — Zapup and the tier above it
  // together — so the one-per-line rule that a real draft needs is lifted here
  // exactly the way the bench and field caps already are.
  const clash = familyConflict(tatari, player);
  if (clash && !isSandbox()) return `${clash.name} from the same line is already on P${player}'s bench`;
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

/**
 * Swaps one Tatari for another from the same evolution line, keeping everything
 * that was decided about it.
 *
 * Changing your mind about which tier to bring used to mean removing the one you
 * had and adding the other, which threw away its place on the field, its
 * position on the bench and — worst — the level-up order you had worked out for
 * it. None of those decisions were about the tier. A T2 planned to reach level 5
 * second is still planned to reach level 5 second when it becomes a T3.
 *
 * So the swap is in-place at every layer: the bench slot keeps its index, the
 * cell keeps its occupant, and the plan has its member slugs rewritten rather
 * than dropped. Only the identity changes.
 *
 * Refuses across evolution lines, because that is not a change of mind about a
 * tier, it is a different Tatari — and `addToBench` is already the way to bring
 * one of those.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function switchTier(fromSlug, toSlug, player = formation.activePlayer) {
  if (fromSlug === toSlug) return { ok: true };
  const from = state.bySlug.get(fromSlug);
  const to = state.bySlug.get(toSlug);
  if (!from || !to) return { ok: false, reason: 'Unknown Tatari' };
  if (from.familyId !== to.familyId) {
    return { ok: false, reason: `${to.name} is not from ${from.name}'s line` };
  }

  const at = formation.bench[player]?.indexOf(fromSlug) ?? -1;
  if (at === -1) return { ok: false, reason: `P${player} is not bringing ${from.name}` };
  if (onBench(toSlug, player)) return { ok: true };

  formation.bench[player][at] = toSlug;

  const cell = cellOf(fromSlug, player);
  if (cell !== null) formation.cells[cell] = { slug: toSlug, player };

  formation.plan = formation.plan.map((s) => ({
    ...s,
    members: s.members.map((m) => (sameMember(m, fromSlug, player) ? { ...m, slug: toSlug } : m)),
  }));

  emit();
  return { ok: true };
}

/**
 * Moves a Tatari to the other player, taking its plan with it.
 *
 * The mistake this exists for is building a level-up order under the wrong
 * player and noticing afterwards. Before, the only fix was to remove it and
 * start again on the other side, which is the same loss the tier switch was
 * about: the order was never a property of whose it was.
 *
 * ## When the other player already brings that line
 *
 * They trade sides. It cannot be a plain move — a player holds at most one of
 * any evolution line — and refusing would leave you doing by hand exactly the
 * destructive thing this is here to avoid.
 *
 * A swap is not the no-op it first looks like, because the plans travel with the
 * tokens: P1's Poakie planned for L3/L5 and P2's planned for L7 come out as P1
 * holding the L7 plan and P2 holding L3/L5. That is precisely "this plan is on
 * the wrong player", fixed, in the case where both of them brought the Tatari.
 * Field positions go along too, so the board reads the same and only the
 * ownership has changed hands.
 *
 * @returns {{ok: true, swapped: boolean} | {ok: false, reason: string}}
 */
export function switchPlayer(slug, from = formation.activePlayer) {
  if (!isCoop()) return { ok: false, reason: 'Only in co-op' };
  const tatari = state.bySlug.get(slug);
  if (!tatari) return { ok: false, reason: 'Unknown Tatari' };

  const to = from === 1 ? 2 : 1;
  const at = formation.bench[from]?.indexOf(slug) ?? -1;
  if (at === -1) return { ok: false, reason: `P${from} is not bringing ${tatari.name}` };

  // Whatever the other player holds from this line is what has to come back.
  const counterpart = familyConflict(tatari, to)?.slug
    ?? (onBench(slug, to) ? slug : null);

  const cellHere = cellOf(slug, from);
  const cellThere = counterpart ? cellOf(counterpart, to) : null;

  if (counterpart) {
    const theirAt = formation.bench[to].indexOf(counterpart);
    formation.bench[from][at] = counterpart;
    formation.bench[to][theirAt] = slug;
  } else {
    if (formation.bench[to].length >= benchCap()) {
      return { ok: false, reason: `P${to}'s bench is full (${benchCap()} max)` };
    }
    formation.bench[from].splice(at, 1);
    formation.bench[to].push(slug);
  }

  if (cellHere !== null) formation.cells[cellHere] = { slug, player: to };
  if (cellThere !== null) formation.cells[cellThere] = { slug: counterpart, player: from };

  /*
   * Rewritten in one pass off the originals, so a swap cannot move a member
   * twice — writing P1 -> P2 and then P2 -> P1 over the top would put both back
   * where they started.
   */
  formation.plan = formation.plan.map((s) => ({
    ...s,
    members: s.members.map((m) => {
      if (sameMember(m, slug, from)) return { ...m, player: to };
      if (counterpart && sameMember(m, counterpart, to)) return { ...m, player: from };
      return m;
    }),
  }));

  emit();
  return { ok: true, swapped: !!counterpart };
}

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
  const zobo = tatari ? null : state.zoboBySlug.get(slug);
  if (!tatari && !zobo) return { ok: false, reason: 'Unknown Tatari' };
  // The bound moves with the toggle: 36 normally, 78 in Sandbox. Outside
  // Sandbox a cell beyond the line is off the grid in the literal sense — there
  // is nothing drawn there to have dropped onto.
  if (!cellInPlay(cell)) {
    return { ok: false, reason: isEnemyCell(cell) ? 'Turn on Zobo ground to use those rows' : 'Off the grid' };
  }

  /*
   * Zobos are the other side of the board and obey none of the drafting rules.
   *
   * They are not brought, so there is no bench entry and no bench cap; there can
   * be as many as there are tiles, so the field cap does not apply; and the same
   * Zobo can stand in six places at once, because six of them turning up is the
   * ordinary case rather than a mistake. What is left is the one rule that is
   * about the board rather than the draft: one thing per tile.
   *
   * `player: 0` marks them as nobody's. Every count in this file filters on a
   * real player number, so a Zobo is invisible to "how many have I placed" and
   * to "whose bench is this" without either having to learn what a Zobo is.
   */
  if (zobo) {
    // Whatever was standing here goes back to its bench with its plan intact —
    // see the plan rule in reconcile().
    formation.cells[cell] = { slug, player: 0, kind: 'zobo' };
    emit();
    return { ok: true };
  }

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

  formation.cells[cell] = { slug, player };   // anything evicted keeps its plan
  emit();
  return { ok: true };
}

/**
 * Rearmost free cell, so fresh picks land away from the contact line.
 *
 * Stays inside the field even in Sandbox. Auto-place is what happens when you
 * tap a Tatari rather than aim it, and the answer to "put this somewhere
 * sensible" is never the ground the Zobos are walking in from — those cells are
 * for something you meant to do, so they are reachable by drag only.
 */
export function firstFreeCell() {
  for (let i = CELLS - 1; i >= 0; i--) if (!formation.cells[i]) return i;
  return null;
}

/**
 * Where a tapped Zobo lands: the frontmost free tile there is.
 *
 * The mirror of firstFreeCell(), and deliberately so. A Tatari tapped from the
 * roster goes to the rearmost free cell, away from the contact line, because
 * that is the safe end of your own board. A Zobo comes from the other
 * direction — it walks in from beyond the line — so the front is where it
 * belongs, and the search starts at the outermost row that currently exists and
 * works inwards.
 *
 * Tapping matters more here than it looks: on a phone there is no drag from the
 * roster to the field worth performing, so this is the only way most people will
 * ever put one down.
 */
export function firstFreeZoboCell() {
  const outer = formation.zoboGround ? ENEMY_ROWS : formation.pullRows;
  const rows = [];
  for (let r = -outer; r < 0; r++) rows.push(r);
  for (let r = 0; r < ROWS; r++) rows.push(r);

  for (const r of rows) {
    for (let c = 0; c < COLS; c++) {
      const i = r >= 0 ? r * COLS + c : ENEMY_FIRST + (r + ENEMY_ROWS) * COLS + c;
      if (cellInPlay(i) && !formation.cells[i]) return i;
    }
  }
  return null;
}

export function autoPlace(slug, player = formation.activePlayer) {
  if (isPlaced(slug, player)) {
    // Already down. Normally that is the whole story; in Sandbox a second tap is
    // a second copy, dropped like a Zobo rather than moving the one that is
    // there — so "add more Zapup" is just tapping Zapup again.
    if (!isSandbox()) return { ok: true };
    return placeCopy(slug, firstFreeCell(), player);
  }
  const cell = firstFreeCell();
  if (cell === null) return { ok: false, reason: 'No empty cell' };
  return place(slug, cell, player);
}

/**
 * Another copy of a Tatari already on the field, on the tile given (or the first
 * free one). Sandbox only.
 *
 * Modelled on the Zobo: a copy is a plain cell occupant and nothing more. It is
 * not brought a second time — the bench holds one entry for the line and the
 * plan keeps one entry for it — so the (slug, player) identity every count,
 * switch and plan step is keyed on stays single-valued. What the extra copies
 * are is exactly what a shared link already carries: a slug standing on a tile.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function placeCopy(slug, cell = firstFreeCell(), player = formation.activePlayer) {
  if (!isSandbox()) return { ok: false, reason: 'Extra copies are a Sandbox thing' };
  if (!state.bySlug.has(slug)) return { ok: false, reason: 'Unknown Tatari' };
  if (cell === null) return { ok: false, reason: 'No empty cell' };
  if (!cellInPlay(cell)) return { ok: false, reason: 'Off the grid' };
  if (formation.cells[cell]) return { ok: false, reason: 'That tile is taken' };
  // reconcile() drops any field occupant whose slug is not on its owner's bench,
  // so the line has to be brought for its copies to stand. The first copy always
  // is; this keeps a copy alive even when it is somehow the first of its slug.
  if (!onBench(slug, player)) formation.bench[player].push(slug);
  formation.cells[cell] = { slug, player };
  emit();
  return { ok: true };
}

/**
 * Takes a token off the field. It stays on its owner's bench, and so does its
 * plan — taking something off the board is not a decision to stop levelling it.
 */
export function unplaceAt(cell) {
  if (!formation.cells[cell]) return;
  formation.cells[cell] = null;
  emit();
}

export function unplace(slug, player = formation.activePlayer) {
  const cell = cellOf(slug, player);
  if (cell !== null) unplaceAt(cell);
}

/**
 * Takes everyone off the field. Benches are kept; the plan is not, and cannot be.
 *
 * A step names Tatari that are on the field — reconcile() drops any member whose
 * cell is null, and a step with no members left goes with it. So emptying the
 * field empties the plan whatever this function does; the assignment below is
 * explicit about that rather than leaving it to a side effect two hundred lines
 * away.
 *
 * That is a real cost, and the plan has its own Clear button, which reads as a
 * promise that it is separate. The answer is not to pretend it survives — it is
 * for the caller to say so plainly and offer the way back. app.js does both.
 */
export function clearField() {
  formation.cells = Array(ALL_CELLS).fill(null);
  formation.plan = [];
  emit();
}

export function clearAll() {
  formation.cells = Array(ALL_CELLS).fill(null);
  formation.bench = { 1: [], 2: [] };
  formation.plan = [];
  emit();
}

/** How long an LF line can be before it stops fitting under the field. */
export const LF_MAX = 60;

/** Sprites past this stop fitting on the field strip, and on the card. */
export const LF_WANTS_MAX = 6;

/** Point the editor at one of the two lines. */
export function setLfMode(next) {
  if (next !== 'lf' && next !== 'have') return;
  if (formation.lfMode === next) return;
  formation.lfMode = next;
  for (const fn of listeners) fn();
}

export const LF_LABELS = { lf: 'LF:', have: 'HAVE:' };
export const lfLine = (side = formation.lfMode) => formation.lines[side];
/** The lines with anything on them, in reading order. */
export const filledLines = () => ['have', 'lf']
  .map((side) => ({ side, ...formation.lines[side] }))
  .filter((l) => l.wants.length || l.note.trim());

/** Name a Tatari on a line, or take it off again. Ignores anything unknown. */
export function toggleWant(slug, side = formation.lfMode) {
  if (!state.bySlug.has(slug)) return { ok: false, reason: 'Unknown Tatari' };
  const line = formation.lines[side];
  if (!line) return { ok: false, reason: 'Unknown line' };
  const at = line.wants.indexOf(slug);
  if (at !== -1) line.wants.splice(at, 1);
  else {
    if (line.wants.length >= LF_WANTS_MAX) {
      return { ok: false, reason: `${LF_LABELS[side]} holds ${LF_WANTS_MAX} at a time` };
    }
    line.wants.push(slug);
  }
  emit();
  return { ok: true };
}

/** What this player wants a teammate to bring. Shown on the field in co-op. */
export function setLF(text, side = formation.lfMode) {
  const line = formation.lines[side];
  const next = String(text ?? '').slice(0, LF_MAX);
  if (!line || next === line.note) return;
  line.note = next;
  emit();
}

export function setName(name) {
  formation.name = name;
  emit();
}

// ---------------------------------------------------------------- level plan

/**
 * A step is an instruction, not a single action. One Tatari is the common case,
 * but a step can name several - the three tanks, say - and carry a note for the
 * part no level number can express: "max one of these first".
 *
 * Its level is what the step is about, and it applies to whichever member the
 * game actually offers you a card for. It may be null when the note carries the
 * whole intent.
 */

export const MAX_NOTE = 140;

const sameMember = (m, slug, player) => m.slug === slug && m.player === player;
const hasMember = (step, slug, player) => step.members.some((m) => sameMember(m, slug, player));
const memberKey = (m) => `${m.player}:${m.slug}`;

/** Drops anything unusable and any repeat, so a step never lists one Tatari twice. */
function normalizeMembers(members) {
  const seen = new Set();
  return (Array.isArray(members) ? members : []).reduce((list, m) => {
    const slug = typeof m === 'string' ? m : m?.slug;
    if (typeof slug !== 'string' || !slug) return list;
    const member = { slug, player: Number(m?.player) || 1 };
    if (!seen.has(memberKey(member))) { seen.add(memberKey(member)); list.push(member); }
    return list;
  }, []);
}

/** @returns {number|null} the level, or undefined when it is not a usable one. */
function normalizeLevel(level) {
  if (level === null || level === undefined || level === '') return null;
  const n = Number(level);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LEVEL ? n : undefined;
}

const trimNote = (note) => (typeof note === 'string' ? note.trim().slice(0, MAX_NOTE) : '');

/**
 * Reads a step in the current shape, in the older one Tatari per step shape,
 * and in the shape exported files use.
 */
function toStep(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const members = normalizeMembers(
    Array.isArray(raw.members) ? raw.members
      : Array.isArray(raw.tatari) ? raw.tatari
        : [{ slug: raw.slug, player: raw.player }]
  );
  if (!members.length) return null;
  return { members, level: normalizeLevel(raw.level) ?? null, note: trimNote(raw.note) };
}

/**
 * Whose step this is. Every member of a step belongs to one player - the adder
 * only ever offers one player's Tatari - so the first member speaks for it.
 */
export const stepPlayer = (step) => step.members[0]?.player ?? 1;

/** One player's steps, each with the index it holds in the whole plan. */
export function planFor(player) {
  return formation.plan
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => stepPlayer(step) === player);
}

/** Levels this Tatari is planned to reach. Steps with no level do not name one. */
export function plannedLevels(slug, player = formation.activePlayer) {
  return formation.plan
    .filter((s) => s.level !== null && hasMember(s, slug, player))
    .map((s) => s.level).sort((a, b) => a - b);
}

/**
 * Where this Tatari first appears in its owner's plan, counting from 1.
 *
 * The field draws this so the ordering is legible on the formation itself. A
 * token badged L7 says what it gets levelled to but not whether it gets there
 * first or last, and going in order is the entire point of a plan meant to be
 * read top-down mid-run.
 */
export function planPositionOf(slug, player = formation.activePlayer) {
  const at = planFor(player).findIndex(({ step }) => hasMember(step, slug, player));
  return at === -1 ? null : at + 1;
}

/**
 * The highest level this Tatari is already planned to reach, or null for none.
 *
 * The highest is the only one that matters: levelling to 7 passes through
 * everything below it, so a step for level 3 adds nothing to a plan that
 * already takes the same Tatari to 7. Group steps count - being one of the
 * three tanks a step takes to 7 is still being taken to 7.
 *
 * @param {number} [ignoreIndex] a step to leave out, when editing that step
 */
export function topLevel(slug, player = formation.activePlayer, ignoreIndex = -1) {
  let top = null;
  formation.plan.forEach((s, i) => {
    if (i === ignoreIndex || s.level === null || !hasMember(s, slug, player)) return;
    if (top === null || s.level > top) top = s.level;
  });
  return top;
}

/** The level to offer next, or null once this Tatari is already planned to MAX_LEVEL. */
export function suggestedLevel(slug, player = formation.activePlayer) {
  const top = topLevel(slug, player);
  if (top === null) return 1;
  return top < MAX_LEVEL ? top + 1 : null;
}

/**
 * A one-Tatari step that asks for a level it is already planned to pass through
 * is a mistake worth refusing. A group step is an instruction about several of
 * them ("max one of these"), and repeating it is how you say "now the next one".
 */
function alreadyPlanned(members, level, ignoreIndex = -1) {
  if (members.length !== 1) return false;
  const [m] = members;
  if (level === null) {
    return formation.plan.some((s, i) => i !== ignoreIndex && s.members.length === 1
      && s.level === null && sameMember(s.members[0], m.slug, m.player));
  }
  const top = topLevel(m.slug, m.player, ignoreIndex);
  return top !== null && level <= top;
}

function plannedReason(member, level, ignoreIndex = -1) {
  const name = state.bySlug.get(member.slug)?.name ?? member.slug;
  if (level === null) return `${name} is already a step`;
  const top = topLevel(member.slug, member.player, ignoreIndex);
  return top === level
    ? `${name} is already planned to level ${level}`
    : `${name} is already planned to level ${top}, which passes through ${level}`;
}

/**
 * @param {{slug: string, player: number}[]} members
 * @param {number|null} level  null when the note carries the intent instead
 * @returns {{ok: true, index: number} | {ok: false, reason: string}}
 */
export function addStep(members, level = null, note = '') {
  const list = normalizeMembers(members);
  if (!list.length) return { ok: false, reason: 'Pick at least one Tatari' };

  /*
   * Brought, not placed.
   *
   * This asked for a cell, which matched the old rule that a plan died when its
   * Tatari left the field. That rule is gone — a plan is a decision about
   * something you are bringing — and leaving this one behind would have made the
   * two halves disagree: a step could survive being benched but could not be
   * written for a Tatari already there, which is exactly when you are thinking
   * about the order.
   */
  for (const m of list) {
    const tatari = state.bySlug.get(m.slug);
    if (!tatari) return { ok: false, reason: 'Unknown Tatari' };
    if (!onBench(m.slug, m.player)) {
      return {
        ok: false,
        reason: `${tatari.name} is not brought${isCoop() ? ` by P${m.player}` : ''}`,
      };
    }
  }

  const lvl = normalizeLevel(level);
  if (lvl === undefined) return { ok: false, reason: `Level must be 1 to ${MAX_LEVEL}` };

  if (alreadyPlanned(list, lvl)) {
    return { ok: false, reason: plannedReason(list[0], lvl) };
  }

  formation.plan.push({ members: list, level: lvl, note: trimNote(note) });
  emit();
  return { ok: true, index: formation.plan.length - 1 };
}

export function removeStep(index) {
  if (index < 0 || index >= formation.plan.length) return;
  formation.plan.splice(index, 1);
  emit();
}

/** Takes one Tatari out of a step. A step with nobody left goes with it. */
export function removeStepMember(index, slug, player) {
  const step = formation.plan[index];
  if (!step) return;
  step.members = step.members.filter((m) => !sameMember(m, slug, player));
  if (!step.members.length) formation.plan.splice(index, 1);
  emit();
}

/** @returns {{ok: true} | {ok: false, reason: string}} */
export function setStepLevel(index, level) {
  const step = formation.plan[index];
  if (!step) return { ok: false, reason: 'No such step' };
  const lvl = normalizeLevel(level);
  if (lvl === undefined) return { ok: false, reason: `Level must be 1 to ${MAX_LEVEL}` };
  if (alreadyPlanned(step.members, lvl, index)) {
    return { ok: false, reason: plannedReason(step.members[0], lvl, index) };
  }
  step.level = lvl;
  emit();
  return { ok: true };
}

/** The free-text half of a step: what to do with the Tatari it names. */
export function setStepNote(index, note) {
  const step = formation.plan[index];
  if (!step) return;
  const next = trimNote(note);
  if (next === step.note) return;
  step.note = next;
  emit();
}

export function moveStep(from, to) {
  if (from < 0 || from >= formation.plan.length) return;
  const [step] = formation.plan.splice(from, 1);
  formation.plan.splice(Math.max(0, Math.min(to, formation.plan.length)), 0, step);
  emit();
}

/** Clears one player's steps, or the whole plan when no player is named. */
export function clearPlan(player = null) {
  formation.plan = player === null
    ? []
    : formation.plan.filter((s) => stepPlayer(s) !== player);
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
      if (!t) return false;
      // Sandbox brings a whole line at once, so the one-per-family cut a real
      // draft needs is off here — the same lift as the caps and the placement
      // rules. Without this the tier above a Tatari you already bring is stripped
      // back off the bench the instant it lands, and its field copy with it.
      if (!formation.sandbox) {
        if (seenFamilies.has(t.familyId)) return false;
        seenFamilies.add(t.familyId);
      }
      return true;
    }).slice(0, benchCap());
  }

  /*
   * The array is always ALL_CELLS long, so the cells beyond the contact line
   * exist whether or not Sandbox does. This is the one place that guarantees
   * they are empty when it does not — the check is on the flag rather than on
   * how the occupant got there, so a hand-edited link, a stale autosave from a
   * Sandbox session and a live peer still in Sandbox are all handled by it.
   */
  /*
   * A pull row exists for as long as somebody is standing on it. Recomputed here
   * rather than tracked by the pull, so it is right however the last Tatari left
   * — dragged away, deleted, or swapped with something on the field.
   */
  if (!formation.zoboGround && formation.pullRows > 0) {
    let deepest = 0;
    formation.cells.forEach((occ, cell) => {
      if (occ && isEnemyCell(cell)) deepest = Math.max(deepest, -cellDisplayRow(cell));
    });
    formation.pullRows = Math.min(formation.pullRows, deepest);
  }

  const placedPerPlayer = { 1: 0, 2: 0 };
  formation.cells = formation.cells.map((occ, cell) => {
    if (!occ) return null;
    if (!cellInPlay(cell)) return null;
    /*
     * Zobos skip every check below this line. They belong to no player, sit on
     * no bench and count against no cap — the only thing that can remove one is
     * the board shrinking under it, which the `reach` test above already did.
     */
    if (occ.player === 0 || occ.kind === 'zobo') {
      return state.zoboBySlug.has(occ.slug) ? { slug: occ.slug, player: 0, kind: 'zobo' } : null;
    }
    if (!active.includes(occ.player)) return null;
    if (!onBench(occ.slug, occ.player)) return null;
    if (placedPerPlayer[occ.player] >= fieldCap()) return null;
    placedPerPlayer[occ.player]++;
    return occ;
  });

  /*
   * A plan survives being taken off the field, and only dies when you stop
   * bringing the Tatari at all.
   *
   * This used to require a cell, which made the plan a property of a placement
   * rather than of a decision: lift a Tatari off the board for a moment to try
   * something and the order you had worked out for it was gone, with no warning
   * and no way back. Benching is the cheapest thing you do in this tool and it
   * was quietly the most expensive.
   *
   * The bench is the right test because it is what "I am bringing this" means,
   * and everything on the field is on a bench by invariant — so this only ever
   * keeps steps, never adds ones that were not valid before. Steps for a benched
   * Tatari are drawn as inactive in the plan; see renderPriority.
   */
  // Only one-Tatari steps are deduplicated - see alreadyPlanned().
  const seenSingles = new Set();
  formation.plan = formation.plan.map((s) => ({
    members: normalizeMembers(s.members)
      .filter((m) => active.includes(m.player) && onBench(m.slug, m.player)),
    level: normalizeLevel(s.level) ?? null,
    note: trimNote(s.note),
  })).filter((s) => {
    if (!s.members.length) return false;
    if (s.members.length > 1) return true;
    const key = `${memberKey(s.members[0])}:${s.level}`;
    if (seenSingles.has(key)) return false;
    seenSingles.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- persistence

function persist() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot()));
  } catch { /* private browsing, quota - not worth interrupting the user */ }
}

/**
 * The whole working state as one plain object - the shape persist() writes and
 * apply() reads back. Deep-copied, so a snapshot held by a caller does not
 * change under it when the formation does. The saved-formations list keeps
 * these in localStorage next to the autosave.
 */
export function snapshot() {
  return {
    mode: formation.mode,
    /*
     * Carried, and it has to be. A snapshot is what Undo restores and what the
     * autosave writes, and restoring a 30-strong Sandbox board into a formation
     * that had forgotten the caps were off would trim it on the way back in —
     * an Undo that loses half of what it was undoing.
     */
    sandbox: formation.sandbox,
    zoboGround: formation.zoboGround,
    pullRows: formation.pullRows,
    cells: formation.cells.map((o) => (o ? { ...o } : null)),
    bench: { 1: [...formation.bench[1]], 2: [...formation.bench[2]] },
    plan: formation.plan.map((s) => ({ ...s, members: s.members.map((m) => ({ ...m })) })),
    name: formation.name,
    lines: {
      lf: { wants: [...formation.lines.lf.wants], note: formation.lines.lf.note },
      have: { wants: [...formation.lines.have.wants], note: formation.lines.have.note },
    },
    lfMode: formation.lfMode,
  };
}

/** Loads a snapshot back. apply() enforces every invariant on the way in. */
export function applySnapshot(data) {
  if (!data || typeof data !== 'object') return false;
  apply(data);
  return true;
}

/** The formation left in localStorage. A shared link takes priority over it. */
export function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!saved || !Array.isArray(saved.cells)) return false;
    apply(saved);
    return true;
  } catch { return false; }
}

/** Loads a raw state blob, letting reconcile() enforce every invariant. */
function apply({ mode: m, sandbox, zoboGround, pullRows: rows, cells, bench, plan, name, lf, lfWants, lfMode, lines }) {
  formation.mode = MODES[m] ? m : 'solo';
  /*
   * Set before anything else reads a cap. reconcile() at the end of this
   * function is what cuts an over-cap bench, and it has to know whether the
   * caps are lifted before it decides there is anything to cut — a Sandbox
   * formation loaded from a link would otherwise be trimmed to 15 on arrival.
   */
  formation.sandbox = sandbox === true;
  formation.zoboGround = zoboGround === true;
  formation.pullRows = Math.max(0, Math.min(ENEMY_ROWS, Number(rows) || 0));
  formation.bench = {
    1: Array.isArray(bench?.[1]) ? [...bench[1]] : [],
    2: Array.isArray(bench?.[2]) ? [...bench[2]] : [],
  };
  formation.cells = Array(ALL_CELLS).fill(null);
  (Array.isArray(cells) ? cells : []).slice(0, ALL_CELLS).forEach((occ, i) => {
    if (!occ) return;
    const slug = typeof occ === 'string' ? occ : occ.slug;
    if (!slug) return;

    /*
     * A Zobo restores as itself and nothing else. The back-fill below exists
     * because a placed Tatari implies its owner brought it — which is exactly
     * what is not true here: nobody brings a Zobo, and pushing one onto a bench
     * would put an enemy in your 15 and then trip every family and cap check
     * downstream. Tested before the roster lookup so a Zobo never falls through
     * to the Tatari path.
     */
    if (state.zoboBySlug.has(slug)) {
      formation.cells[i] = { slug, player: 0, kind: 'zobo' };
      return;
    }

    const player = Number(typeof occ === 'string' ? 1 : occ.player) || 1;
    if (!state.bySlug.has(slug)) return;
    // A token implies its owner brought it, so back-fill the bench for older
    // saves and hand-written files that only list placements.
    if (!formation.bench[player].includes(slug)) formation.bench[player].push(slug);
    formation.cells[i] = { slug, player };
  });
  formation.plan = (Array.isArray(plan) ? plan : []).map(toStep).filter(Boolean);
  if (typeof name === 'string') formation.name = name;
  if (lfMode === 'lf' || lfMode === 'have') formation.lfMode = lfMode;

  const cleanLine = (raw) => ({
    wants: (Array.isArray(raw?.wants) ? raw.wants : [])
      .filter((slug) => typeof slug === 'string' && state.bySlug.has(slug))
      .slice(0, LF_WANTS_MAX),
    note: typeof raw?.note === 'string' ? raw.note.slice(0, LF_MAX) : '',
  });

  if (lines) {
    formation.lines = { lf: cleanLine(lines.lf), have: cleanLine(lines.have) };
  } else if (lf !== undefined || lfWants !== undefined) {
    // One line was all there used to be, and lfMode said which one it was.
    const side = formation.lfMode;
    formation.lines = { lf: cleanLine(null), have: cleanLine(null) };
    formation.lines[side] = cleanLine({ wants: lfWants, note: lf });
  }
  emit();
}

// ---------------------------------------------------------------- share links

/**
 * The whole formation as a link to this page.
 *
 * The grammar and both directions of it live in hash.js, because the community
 * gallery has to write one of these for a formation it is not editing. What is
 * left here is the part that is genuinely about this module: which formation
 * (the live one) and which page (this one).
 */
export function shareUrl() {
  const url = new URL(location.href);
  url.hash = toFragment(snapshot());
  return url.toString();
}

/** @returns {{unknown: string[]}|null} null when the hash held no formation */
export function fromHash() {
  const read = fromFragment(location.hash);
  if (!read) return null;
  apply(read.blob);
  return { unknown: read.unknown };
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
    version: 5,
    name: formation.name || 'Untitled formation',
    mode: formation.mode,
    lookingFor: ['lf', 'have'].reduce((out, side) => {
      const line = formation.lines[side];
      out[side] = {
        note: line.note || null,
        tatari: line.wants.map((slug) => ({ slug, name: state.bySlug.get(slug)?.name ?? slug })),
      };
      return out;
    }, {}),
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
    /**
     * Ordered level-ups: step 1 is the first one you take. A step names one or
     * more Tatari and an optional note; `level` is null when the note carries
     * the intent on its own. One-Tatari steps also repeat their slug at the top
     * level, which is where v4 files carried it.
     */
    levelPlan: formation.plan.map((s, i) => ({
      step: i + 1,
      level: s.level,
      note: s.note || null,
      tatari: s.members.map((m) => ({
        player: m.player, slug: m.slug, name: state.bySlug.get(m.slug)?.name ?? m.slug,
      })),
      ...(s.members.length === 1 ? {
        player: s.members[0].player,
        slug: s.members[0].slug,
        name: state.bySlug.get(s.members[0].slug)?.name ?? s.members[0].slug,
      } : {}),
    })),
    customTatari: state.all
      .filter((t) => t.custom && [1, 2].some((p) => onBench(t.slug, p)))
      .map(({ _search, ...rest }) => rest),
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Reads v5 and v4 files, and v1-v3 ones as a solo formation. Unknown slugs are reported
 * rather than swallowed - usually it means custom Tatari were not bundled along.
 * @returns {{ok: true, unknown: string[]} | {ok: false, reason: string}}
 */
export function fromJSON(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'Not a JSON object' };

  const unknown = [];
  const cells = Array(ALL_CELLS).fill(null);
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
    if (cell === null || cell < 0 || cell >= ALL_CELLS || cells[cell]) return;
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
    : [];

  apply({
    mode: MODES[data.mode] ? data.mode : 'solo',
    cells, bench, plan,
    name: typeof data.name === 'string' ? data.name : formation.name,
    // The old shape was a bare string plus a separate list and a mode.
    lf: typeof data.lookingFor === 'string' ? data.lookingFor : undefined,
    lfWants: Array.isArray(data.lookingForTatari)
      ? data.lookingForTatari.map((w) => (typeof w === 'string' ? w : w?.slug)).filter(Boolean)
      : undefined,
    lfMode: data.lookingForMode,
    lines: data.lookingFor && typeof data.lookingFor === 'object'
      ? {
        lf: {
          wants: (data.lookingFor.lf?.tatari ?? []).map((w) => w?.slug ?? w),
          note: data.lookingFor.lf?.note ?? '',
        },
        have: {
          wants: (data.lookingFor.have?.tatari ?? []).map((w) => w?.slug ?? w),
          note: data.lookingFor.have?.note ?? '',
        },
      }
      : undefined,
  });
  return { ok: true, unknown };
}
