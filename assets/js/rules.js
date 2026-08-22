/**
 * The shape of a Horde run: how big the field is, how many you bring, how far
 * a Tatari levels.
 *
 * Lifted out of store.js so a page that draws a formation without editing one
 * (the community gallery) can size a grid without pulling in the whole state
 * machine behind it. store.js imports and re-exports every one of these, so
 * `store.COLS` still resolves everywhere it always did.
 *
 * These mirror `hordeGrid` in data/meta.json. They are duplicated rather than
 * read from it because the grid has to exist before any fetch resolves.
 */

/** Your half of the Horde field: 6 tiles across, 6 deep. Zobos spawn beyond row 0. */
export const COLS = 6;
export const ROWS = 6;
export const CELLS = COLS * ROWS;

/**
 * The ground beyond the contact line, which only Sandbox can reach.
 *
 * Seven rows, the same count contribute.js draws when it records how far an
 * attack reaches — the two are the same piece of ground, so they agree on its
 * size rather than each picking a number.
 *
 * ## Why these are numbered after the field and not before it
 *
 * The obvious layout puts them first, since they are drawn above: rows -7..-1,
 * or 0..41 with the field pushed to 42..77. Both renumber the field, and the
 * field's numbers are not private — they are in every share link anyone has
 * ever posted, in every saved formation in localStorage, and in the community
 * database. `@12` has to keep meaning the tile it has always meant.
 *
 * So the field keeps 0..35 and the Zobo rows are appended at 36..77, drawn
 * above the field but numbered below it. Nothing that reads a formation needs
 * to know they exist: a link without them decodes as it always did, and the
 * card renderer and the gallery still walk 0..CELLS.
 */
export const ENEMY_ROWS = 7;
export const ENEMY_CELLS = COLS * ENEMY_ROWS;
export const ENEMY_FIRST = CELLS;
export const ALL_CELLS = CELLS + ENEMY_CELLS;

/** True for a cell index that lies beyond the contact line. */
export const isEnemyCell = (i) => i >= ENEMY_FIRST && i < ALL_CELLS;

/** Tatari cap out at level 7. */
export const MAX_LEVEL = 7;

export const MODES = {
  solo: { label: 'Solo', players: 1, bench: 15, field: 15 },
  coop: { label: 'Co-op', players: 2, bench: 15, field: 10 },
};

/**
 * Sandbox is not a third mode, it is a flag over the top of one.
 *
 * A run is Solo or Co-op; that is the game's own distinction and it decides how
 * many players there are and whose bench is whose. Sandbox says nothing about
 * that — it says the caps are off and the whole board is reachable, which is a
 * question you can ask of either. Making it a mode would have meant a
 * `sandbox-coop`, and then two ways to say the same thing.
 *
 * `bench: Infinity` is deliberate rather than a large number. The bench is a
 * shortlist you are thinking with, and any finite ceiling here is a number
 * somebody hits while doing exactly what the toggle invited them to do.
 */
export const SANDBOX = { label: 'Sandbox', bench: Infinity, field: ALL_CELLS };

/** The caps in force: Sandbox's when it is on, the mode's own when it is not. */
export function capsFor(mode, sandbox = false) {
  const base = MODES[mode] ?? MODES.solo;
  return sandbox
    ? { label: base.label, players: base.players, bench: SANDBOX.bench, field: SANDBOX.field }
    : base;
}

/**
 * How many cells a formation can use, which is its own question.
 *
 * Opening the ground past the contact line and taking the caps off started as
 * one switch and should not have been. They answer different things — "how much
 * board is there" against "how much may I bring" — and wanting one is no reason
 * to be given the other: laying six Tatari out across the Zobo rows to see how a
 * range reads is a normal thing to want inside a legal 15.
 *
 * So this takes the Zobo flag and capsFor() takes the Sandbox one, and neither
 * consults the other.
 */
export const cellCountFor = (zoboGround = false) => (zoboGround ? ALL_CELLS : CELLS);

export const cellRow = (i) => Math.floor(i / COLS);
export const cellCol = (i) => i % COLS;

/**
 * Where a cell sits on screen, which for the Zobo rows is not where its index
 * suggests. Row 0 is the field's front row as always; the rows beyond the line
 * count backwards from it, so -1 is the row a Zobo reaches first and -7 the
 * furthest out. Same convention contribute.js records ranges in.
 */
export const cellDisplayRow = (i) => (isEnemyCell(i)
  ? Math.floor((i - ENEMY_FIRST) / COLS) - ENEMY_ROWS
  : cellRow(i));
