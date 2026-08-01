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

/** Tatari cap out at level 7. */
export const MAX_LEVEL = 7;

export const MODES = {
  solo: { label: 'Solo', players: 1, bench: 15, field: 15 },
  coop: { label: 'Co-op', players: 2, bench: 15, field: 10 },
};

export const cellRow = (i) => Math.floor(i / COLS);
export const cellCol = (i) => i % COLS;
