/**
 * The shared field (6 wide, 6 deep), the bench strip beneath it, and the player
 * tabs above it.
 *
 * In co-op both players' tokens sit on the same field, so every occupant carries
 * its owner and tokens are badged P1 / P2. The bench strip shows the part of the
 * active player's 15 that has not landed yet.
 */

import { state, matches, pieceBySlug } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, roleIcon, typeIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';
import { quickAddStep } from './priority.js';
import { coveredFrom, coverage, hasRange } from './range.js';
import { effectsOf, GROUP_LABELS, helpFor } from './effects.js';

const grid = $('#grid');
/** Sandbox's extra ground. Absent on pages that draw a field without one. */
const enemy = $('#enemy');
const benchHost = $('#bench');
const tabsHost = $('#player-tabs');

/**
 * Sprites that end up in the share card: the field, the benches and the co-op
 * lines. They load eagerly and ahead of the roster, because the card reuses the
 * images already on the page and anything still queued behind 218 thumbnails is
 * simply missing from the picture. There are at most a few dozen of these and
 * they are all on screen anyway.
 */
const ON_CARD = { lazy: false, priority: 'high' };

/** Cell the keyboard user has "picked up", if any. */
let carried = null;

/**
 * The 36 cell elements, in cell order.
 *
 * Cells used to be `grid.children`, and four call sites indexed them that way.
 * They are one level deeper now that each row of six is wrapped in a
 * `role="row"` — so the position in the DOM is no longer the position on the
 * board, and anything that assumed it was silently found rows instead of cells.
 */
const cellEls = [];

/**
 * One cell element, by cell number.
 *
 * Exported for session.js, which marks the square a peer is dragging over. It
 * has to reach the element rather than the index because renderGrid() rewrites
 * `cell.innerHTML` — so a remote highlight cannot be a child node that survives
 * the next paint, only a class on the cell itself.
 */
export const cellElement = (i) => cellEls[i] ?? null;

/**
 * The bench as somewhere you can drop things, which it was not.
 *
 * Both directions already existed as clicks and had no drag: the roster's cards
 * bring a Tatari when tapped, and a field token comes off when double-clicked.
 * But the bench is drawn as a strip of Tatari directly under the field, which
 * reads as a place, and dragging onto a place that ignores you is the kind of
 * dead end nobody reports — they just conclude it cannot be done. The roster
 * already accepts a drag *back* (see buildRosterDropZone), so the gesture was
 * half-implemented in one direction only.
 *
 * `.bench__player` rather than the whole dock, because in co-op there are two of
 * them side by side and the one you dropped on is the one you meant — the drop
 * ignores whose turn it is and reads the target's own data-player.
 *
 * From the field it is an unplace, not a re-bench: anything on the field is
 * already on its owner's bench (an invariant store.js enforces), so the drag
 * means "take this off the board" and the Tatari is kept. Only the owner's own
 * bench accepts it; dropping P1's token on P2's bench would be a change of
 * ownership, which is a different gesture and not one anybody asked for.
 */
function buildBenchDropZone() {
  const nameOf = (slug) => state.bySlug.get(slug)?.name ?? slug;

  dropZone({
    selector: '.bench__player',
    accepts: (target, payload) => {
      if (!payload.slug) return false;
      const player = Number(target.dataset.player);
      if (payload.from === 'field') return payload.player === player;
      if (payload.from !== 'roster') return false;      // bench -> bench is a no-op
      if (store.onBench(payload.slug, player)) return false;
      const t = state.bySlug.get(payload.slug);
      if (!t) return false;
      // Swapping a tier onto the bench it already occupies is a rename, not a
      // second Tatari, so the bench cap and the family rule do not apply.
      if (payload.swapFrom) return true;
      return !store.benchBlockedReason(t, player);
    },
    onHover: (target, ok) => target.classList.toggle('is-taking', ok),
    onDrop: (target, payload) => {
      const player = Number(target.dataset.player);
      const who = store.isCoop() ? ` (P${player})` : '';

      if (payload.from === 'field') {
        store.unplace(payload.slug, payload.player);
        toast(`${nameOf(payload.slug)}${who} off the field, still on the bench`);
        return;
      }

      if (payload.swapFrom) {
        const swapped = store.switchTier(payload.swapFrom, payload.slug, player);
        if (!swapped.ok) { toast(swapped.reason, 'error'); return; }
        toast(`Switched to ${nameOf(payload.slug)}${who}`);
        return;
      }

      const result = store.addToBench(payload.slug, player);
      if (!result.ok) { toast(result.reason, 'error'); return; }
      toast(`Bringing ${nameOf(payload.slug)}${who}`);
    },
  });
}

export function buildGrid() {
  grid.innerHTML = '';
  cellEls.length = 0;
  /*
   * ARIA requires a `row` between a `grid` and its `gridcell`s. Without it the
   * structure is invalid and a screen reader may drop or mis-report the whole
   * board — which the per-cell "Row 3, column 4" labels were quietly papering
   * over. `display: contents` means the rows exist for assistive technology and
   * not for layout, so the CSS grid still sees 36 cells.
   */
  const rows = [];
  for (let r = 0; r < store.ROWS; r++) {
    const row = document.createElement('div');
    row.className = 'grid__row';
    row.setAttribute('role', 'row');
    grid.append(row);
    rows.push(row);
  }

  /*
   * The Zobo rows are built here too, once, whether or not Sandbox is on. They
   * are 42 empty divs when it is off, which costs nothing and buys the thing
   * that matters: cellEls is complete and contiguous from 0 to 77 for the whole
   * session, so renderGrid(), the drag bindings, the keyboard focus ring and
   * the live-session cursor all address a cell the same way wherever it is.
   * Building them on toggle would mean re-binding drag handlers on a board
   * somebody may be mid-drag over.
   */
  if (enemy) {
    enemy.innerHTML = '';
    for (let r = 0; r < store.ENEMY_ROWS; r++) {
      const row = document.createElement('div');
      row.className = 'grid__row';
      row.setAttribute('role', 'row');
      enemy.append(row);
      rows.push(row);              // indices ROWS..ROWS+ENEMY_ROWS-1
    }
  }

  /** Which row element a cell belongs in, and which grid that row is in. */
  const rowOf = (i) => (store.isEnemyCell(i)
    ? store.ROWS + Math.floor((i - store.ENEMY_FIRST) / store.COLS)
    : store.cellRow(i));

  const total = enemy ? store.ALL_CELLS : store.CELLS;
  for (let i = 0; i < total; i++) {
    const beyond = store.isEnemyCell(i);
    const cell = document.createElement('div');
    cell.className = beyond ? 'cell cell--enemy' : 'cell';
    cell.dataset.cell = String(i);
    cell.dataset.row = String(store.cellDisplayRow(i));
    cell.setAttribute('role', 'gridcell');
    cell.tabIndex = i === 0 ? 0 : -1;
    rows[rowOf(i)].append(cell);
    cellEls[i] = cell;

    // Cell elements live for the whole session, so this binds exactly once.
    draggable(
      cell,
      () => {
        const occ = store.formation.cells[i];
        // `cell` is what makes a Zobo draggable at all: it is the only thing
        // that distinguishes this one from the five identical ones elsewhere
        // on the board. Harmless for a Tatari, which is unique anyway.
        return occ ? { ...occ, from: 'field', cell: i } : null;
      },
      () => {
        const occ = store.formation.cells[i];
        return tokenGhost(pieceBySlug(occ.slug), occ.player);
      }
    );
  }

  dropZone({
    selector: '.cell',
    accepts: (target, payload) => {
      if (!payload.slug) return false;
      /*
       * A tile showing a boss-dragged Tatari used to refuse drops, on the
       * grounds that it was not reporting its own contents. That protected a
       * board nobody could edit anyway, and the point of holding the pull still
       * is to edit underneath it — so the drop is allowed and lands where the
       * cell really is. The pulled marker on that tile belongs to a Tatari
       * standing somewhere else; it goes when its own source cell empties.
       */
      const t = pieceBySlug(payload.slug);
      if (!t) return false;
      /*
       * A Zobo is never blocked. It is not brought, so there is no bench to be
       * full and no evolution line to clash with, and any number may stand at
       * once — the only limit is that a tile holds one thing, which the drop
       * itself resolves by replacing what was there.
       */
      if (t.kind === 'zobo') return true;
      // A tier swap is allowed wherever the Tatari it replaces could go: it is
      // taking that one's place rather than joining it.
      if (payload.swapFrom) return true;
      // Already on the field for this player: a move or a swap, always allowed.
      if (store.isPlaced(payload.slug, payload.player)) return true;
      return !store.placeBlockedReason(t, payload.player);
    },
    // Only the valid state is signalled. An invalid target simply gets no
    // highlight - a red flash on every ineligible cell reads as an error.
    // Alongside it, the tiles this Tatari would cover from here light up, so
    // you can see what a placement buys before committing to it.
    onHover: (target, ok, payload) => {
      target.classList.toggle('is-over', ok);
      if (ok) previewRange(Number(target.dataset.cell), payload?.slug);
      else clearRangePreview();
    },
    onDrop: (target, payload) => {
      clearRangePreview();
      const to = Number(target.dataset.cell);

      /*
       * A Zobo already on the board moves; one from the roster is a new one.
       * Without this the drop wrote the destination and left the original where
       * it was, so dragging a Zobo across the field bred a second one — place()
       * cannot tell a move from a copy when the same Zobo may legitimately be
       * standing in six cells at once.
       */
      if (payload.kind === 'zobo' && payload.from === 'field') {
        const result = store.moveFrom(payload.cell, to);
        if (!result.ok) toast(result.reason, 'error');
        return;
      }

      /*
       * Dropping another tier of a line you already bring swaps the line to it
       * first, so what lands is the Tatari you dragged rather than a refusal.
       * The swap keeps the plan; the place that follows just moves it here.
       */
      if (payload.swapFrom) {
        const swapped = store.switchTier(payload.swapFrom, payload.slug, payload.player);
        if (!swapped.ok) { toast(swapped.reason, 'error'); return; }
      }

      /*
       * Sandbox: a roster or bench drop of a Tatari already on the field is
       * another copy, not a move of the one standing there. A field-origin drag
       * is still a move, and a tile that is already taken falls through to
       * place() so it can swap or reposition as before.
       */
      if (store.isSandbox() && payload.from !== 'field'
          && store.isPlaced(payload.slug, payload.player)) {
        const copy = store.placeCopy(payload.slug, to, payload.player);
        if (copy.ok) return;
      }

      const result = store.place(payload.slug, to, payload.player);
      if (!result.ok) toast(result.reason, 'error');
    },
  });

  buildBenchDropZone();

  // A cancelled drag never reaches onDrop, so the preview is cleared here too.
  window.addEventListener('pointerup', clearRangePreview);
  window.addEventListener('pointercancel', clearRangePreview);

  // Hovering a token isolates its own range, which is how you read one Tatari
  // out of the coverage shading.
  grid.addEventListener('pointerover', (e) => {
    const cell = e.target.closest('.cell.is-filled');
    if (!cell || document.body.classList.contains('is-dragging-active')) return;
    const occ = store.formation.cells[Number(cell.dataset.cell)];
    if (occ) previewRange(Number(cell.dataset.cell), occ.slug);
  });
  grid.addEventListener('pointerout', (e) => {
    if (!e.target.closest('.cell')) return;
    clearRangePreview();
  });

  grid.addEventListener('click', (e) => {
    /*
     * While the switch mode is armed a tap changes sides and does nothing else —
     * before the add-step button and before the armed-chip picker, both of which
     * would otherwise fire on the same tap.
     */
    if (switchingPlayers.value) {
      const cell = e.target.closest('.cell');
      const occ = cell && store.formation.cells[Number(cell.dataset.cell)];
      if (occ && occ.player > 0) { e.preventDefault(); switchOwner(occ.slug, occ.player); return; }
      if (occ) { toast('A Zobo belongs to nobody', 'error'); return; }
    }

    const add = e.target.closest('[data-add-step]');
    if (add) {
      const occ = store.formation.cells[Number(add.closest('.cell').dataset.cell)];
      if (occ) quickAddStep(occ.slug, occ.player);
      return;
    }

    // With a chip armed, the field is a picker: the tapped cell wins over the
    // one the preview suggested.
    if (!armed) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;
    commit(Number(cell.dataset.cell));
  });

  grid.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) store.unplaceAt(Number(cell.dataset.cell));
  });

  grid.addEventListener('keydown', onKeydown);

  // Escape backs out of an armed chip wherever focus happens to be. The sheet
  // handler in shell.js also listens, but a sheet and an armed chip cannot be
  // open at once — arming happens on the field, with every sheet dismissed.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && armed) disarm();
  });

  /*
   * A bench chip is a `role="button"` span, and a span does not synthesise a
   * click from Enter or Space the way a real <button> does — so pressing either
   * on a benched Tatari did nothing at all.
   *
   * That was the last link in the only keyboard chain to the field. The roster
   * card's Enter benches rather than places; an empty cell's Enter returns
   * early because picking up needs an occupant; drag is pointer-only; and the
   * detail sheet's "Place on the field" sat behind a tabindex="-1" trigger. So
   * a keyboard-only player could bring fifteen Tatari and never put one down —
   * the whole point of the tool, unreachable.
   *
   * Forwarding to the click handler keeps one implementation of arming and
   * placing rather than a second that can drift from it.
   */
  benchHost.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target.closest('.benchchip');
    if (!chip || e.target.closest('[data-unbench]')) return;
    e.preventDefault();          // Space would otherwise scroll the page
    chip.click();
  });

  benchHost.addEventListener('click', (e) => {
    // Same as the field: while armed, a tap on a chip hands it over instead of
    // doing what it usually does (dropping it in the back).
    if (switchingPlayers.value) {
      const chip = e.target.closest('.benchchip');
      if (chip) { e.preventDefault(); switchOwner(chip.dataset.slug, Number(chip.dataset.player)); return; }
    }

    const clear = e.target.closest('[data-clear-bench]');
    if (clear) {
      const player = Number(clear.dataset.clearBench);
      const n = store.benchOf(player).length;
      if (!n) return;
      store.clearBench(player);
      toast(store.isCoop()
        ? `Cleared P${player}'s bench (${n} Tatari)`
        : `Cleared the bench (${n} Tatari)`);
      return;
    }

    /*
     * Either bench switches to its owner. The player tabs above the field could
     * already do this, but the bench is where you are looking when you notice
     * you are adding to the wrong teammate — so the whole block is the target,
     * not just the label on it. The label is a real button so the same thing is
     * reachable from a keyboard.
     */
    const swap = e.target.closest('[data-switch-player]');
    if (swap) {
      store.setActivePlayer(Number(swap.dataset.switchPlayer));
      return;
    }

    const chip = e.target.closest('.benchchip');
    if (!chip) {
      const block = e.target.closest('.bench__player');
      if (block && store.isCoop()) {
        const owner = Number(block.dataset.player);
        if (owner !== store.formation.activePlayer) store.setActivePlayer(owner);
      }
      return;
    }
    const { slug, player } = chip.dataset;
    if (e.target.closest('[data-unbench]')) {
      store.removeFromBench(slug, Number(player));
      return;
    }
    // A mouse can drag a chip onto the exact cell it wants, so a click there is
    // unambiguously "just put it somewhere". A thumb cannot, so on a phone the
    // tap shows where it would land first and waits to be told yes.
    if (!PHONE.matches) {
      const result = store.autoPlace(slug, Number(player));
      if (!result.ok) toast(result.reason, 'error');
      return;
    }
    arm(slug, Number(player));
  });

  tabsHost.addEventListener('click', (e) => {
    if (e.target.closest('#btn-switch-players')) {
      switchingPlayers.value = !switchingPlayers.value;
      renderPlayerTabs();
      return;
    }
    const tab = e.target.closest('.ptab');
    if (tab) store.setActivePlayer(Number(tab.dataset.player));
  });

  $('#summary').addEventListener('click', (e) => {
    const info = e.target.closest('[data-help]');
    if (info) {
      helpOpen = helpOpen === info.dataset.help ? null : info.dataset.help;
      renderSummary();
      return;
    }
    const pick = e.target.closest('[data-pick]');
    if (!pick) return;
    const player = store.isCoop()
      ? Number(pick.closest('.summary__player--effects')
          .previousElementSibling?.querySelector('[data-player]')?.dataset.player) || null
      : null;
    const next = { player, group: pick.dataset.group, type: pick.dataset.pick };
    const same = openEffect?.player === next.player
      && openEffect.group === next.group && openEffect.type === next.type;
    openEffect = same ? null : next;
    helpOpen = null;
    renderSummary();
  });
}

// ---------------------------------------------------------------- range

/** Cells currently lit by a preview, so only those need clearing again. */
let previewed = [];

function clearRangePreview() {
  for (const cell of previewed) cell.classList.remove('is-inrange');
  previewed = [];
}

/**
 * Lights the tiles `slug` would cover from `cell`. Silent for a Tatari whose
 * range nobody has recorded — better nothing than a shape that is made up.
 */
function previewRange(cell, slug) {
  clearRangePreview();
  if (!rangesOn.value) return;
  if (!slug || !hasRange(slug)) return;
  for (const i of coveredFrom(cell, slug)) {
    const el = cellEls[i];
    if (!el) continue;
    el.classList.add('is-inrange');
    previewed.push(el);
  }
}

/**
 * How many of the Tatari on the field can hit each tile. The gaps are the point:
 * a lane nothing covers is where the Zobos walk through.
 */
export function renderRanges() {
  const on = rangesOn.value;
  grid.classList.toggle('shows-coverage', on);
  if (!on) clearRangePreview();

  const { counts } = on
    ? coverage(store.allPlaced())
    : { counts: [] };

  for (const cell of cellEls) {
    const n = counts[Number(cell.dataset.cell)] ?? 0;
    if (on && n) {
      cell.dataset.cover = Math.min(n, 4);
      /*
       * The number, not just the shade.
       *
       * Four levels of a translucent yellow are about 1.45:1 apart, so "one
       * Tatari reaches here" and "nothing reaches here" were nearly the same
       * colour -- which is the one question the overlay exists to answer. The
       * count is already computed; printing it costs nothing and means the
       * answer does not depend on distinguishing four tints.
       */
      cell.dataset.coverN = String(n);
      cell.setAttribute('aria-description', `${n} can reach this tile`);
    } else {
      delete cell.dataset.cover;
      delete cell.dataset.coverN;
      cell.removeAttribute('aria-description');
    }
  }

  renderRangeGap(on);
}

/**
 * Why the shading has holes in it, and who can close them.
 *
 * The overlay is honest about being incomplete (it draws nothing for a Tatari
 * whose range nobody has measured) but "nothing drawn" and "reaches nothing"
 * look identical on a grid, and the only place that difference was stated was the
 * `title` on the Ranges checkbox. Three quarters of this audience is holding a
 * phone and cannot open a `title` at all, so for them the overlay simply had gaps
 * and no explanation.
 *
 * It counts the Tatari on this field rather than quoting the roster total. A
 * player looking at their own formation is owed a fact about their own formation,
 * and "four of these fifteen are not drawn" is the one that makes the gap real.
 * Shown only while the overlay is on: the rest of the time this is a solicitation
 * nobody asked for.
 */
function renderRangeGap(on) {
  const box = $('#range-gap');
  if (!box) return;

  const placed = store.allPlaced();
  const missing = placed.filter((p) => !hasRange(p.slug));
  const known = state.all.filter((t) => hasRange(t.slug)).length;

  box.hidden = !on;
  if (!on) return;

  const roster = `Reach is recorded for ${known} of ${state.all.length} Tatari.`;
  const yours = !placed.length
    ? 'Nothing is on the field yet.'
    : missing.length
      ? `${missing.length} on your field ${missing.length === 1 ? 'has' : 'have'} none, so ${
        missing.length === 1 ? 'its' : 'their'} reach is not drawn — ${
        missing.map((p) => esc(state.bySlug.get(p.slug)?.name ?? p.slug)).join(', ')}.`
      : 'Every Tatari on your field has one.';

  box.innerHTML = `<span>${roster} ${yours}</span>`
    + '<a class="rangegap__go" href="contribute.html">Record a range</a>';
}

/**
 * Whether the range overlays are on. Off by default, and labelled WIP in the
 * UI, because the tile patterns are read off in-game screenshots by hand and
 * only some of the roster has been done — see data/ranges.json.
 */
export const rangesOn = { value: false };

// ---------------------------------------------------------------- boss pull

/**
 * Whether to show the boss dragging your backline forward.
 *
 * Nothing is moved for real. The pull is drawn as a row of its own above the
 * field and the vacated cells render empty, so turning it off puts everyone
 * back exactly where they were — the formation, the share link and the saved
 * file never knew about it. That matters: this is a question you ask of a
 * formation ("what happens when it grabs them"), not an edit you make to one.
 */
export const bossPullOn = { value: false };

/**
 * A second helping of the same pull.
 *
 * Available whatever else is on. Each round moves one Tatari to just in front of
 * its lane's front rank, so a lane two deep on the field takes both rounds
 * without ever reaching the line — and a lane whose front rank is already at row
 * 0 simply opens a second row past it, the same way the first round opened the
 * first. See planPull().
 */
export const secondPullOn = { value: false };

/**
 * Whether tapping a Tatari hands it to the other player.
 *
 * A mode rather than a per-token control, because the alternative is another
 * button on every token in a co-op formation — thirty of them, for something
 * done once or twice a session. Arm it, tap what is on the wrong side, turn it
 * off. Co-op only: with one player there is nowhere to switch to.
 *
 * Not in the formation. It is a thing the editor is doing, not a fact about the
 * board, and a share link that arrived armed would be a link that rewrites
 * itself the moment somebody taps a sprite.
 */
export const switchingPlayers = { value: false };

/**
 * The pull, as an actual move that is undone when you switch it off.
 *
 * Three versions of this were wrong before it settled here, and the reasons are
 * worth keeping:
 *
 *   1. Recomputed every render, so the board argued with you — drop a Tatari in
 *      a lane and the boss instantly grabbed a different one.
 *   2. Held still, but as an overlay: the source cell only *looked* empty, so
 *      placing into it evicted the Tatari that was supposedly standing further
 *      forward, and the pull vanished.
 *   3. Drawn past the line in a strip outside the grid, which meant the Tatari
 *      out there were in no cell at all — undraggable, unaddressable, and
 *      unable to hold a second row when a second pull needed one.
 *
 * So the pull moves them for real, into real cells, and remembers where each one
 * came from. Everything else follows: the vacated cell is genuinely free, the
 * moved Tatari drags like any other, and the rows past the line are ordinary
 * ground that the store opens one at a time as the pull needs them.
 *
 * @type {{from: number, to: number, slug: string, player: number}[]}
 */
let pullMoves = [];

/** A display row back to a cell index; the inverse of store.cellDisplayRow. */
const cellAtRow = (row, col) => (row >= 0
  ? row * store.COLS + col
  : store.ENEMY_FIRST + (row + store.ENEMY_ROWS) * store.COLS + col);

/**
 * Works out the moves without making them, so the store can be told how much
 * ground to open before anything is placed on it.
 *
 * Per lane the boss takes whoever is furthest back and drops them immediately in
 * front of that lane's front rank; a second round then runs on the board the
 * first one left, so a different Tatari moves and lands a row further forward.
 *
 * A lane may reach past the contact line, and how far it may go depends on what
 * can exist out there: all seven rows when the Zobo ground is open, and
 * otherwise as many as the rounds themselves can justify — one round can open
 * one row, two rounds two. That is the answer to "it should create a second row
 * above": the ground is not fixed at one row, it is however many the pull needs.
 */
function planPull(rounds) {
  const open = store.isZoboGround();
  const reach = open ? store.ENEMY_ROWS : rounds;
  const frontmostRow = open ? -store.ENEMY_ROWS : 0;
  const floor = -reach;

  const moves = [];
  let deepest = 0;

  for (let col = 0; col < store.COLS; col++) {
    let lane = [];
    for (let row = frontmostRow; row < store.ROWS; row++) {
      const cell = cellAtRow(row, col);
      const occ = store.formation.cells[cell];
      if (occ) lane.push({ row, occ, home: cell });
    }
    if (!lane.length) continue;

    for (let r = 0; r < rounds; r++) {
      const destRow = lane[0].row - 1;
      if (destRow < floor) break;
      const back = lane[lane.length - 1];
      lane = [{ ...back, row: destRow }, ...lane.slice(0, -1)];
      if (destRow < 0) deepest = Math.max(deepest, -destRow);
      // A Tatari moved twice keeps one move, from its original cell.
      const already = moves.find((m) => m.from === back.home);
      if (already) already.to = cellAtRow(destRow, col);
      else {
        moves.push({
          from: back.home,
          to: cellAtRow(destRow, col),
          slug: back.occ.slug,
          player: back.occ.player,
        });
      }
    }
  }
  return { moves, deepest };
}

/** The cells the pull dropped somebody into, for marking them. */
const pullDestinations = () => pullMoves.map((m) => m.to);

/** Puts everything the pull moved back where it came from. */
export function releasePull() {
  const moves = pullMoves;
  pullMoves = [];
  if (moves.length) store.restorePositions(moves);
  /*
   * Then clear out whatever is left past the line, which restorePositions
   * deliberately will not touch: anything you moved yourself is no longer the
   * pull's to put back, but it is standing on ground that only exists while the
   * pull is on. Unconditional rather than guarded on `moves`, because the thing
   * being cleaned up is by definition not in that list.
   */
  store.evacuatePullRows();
}

/**
 * Takes the pull. Called when a pull toggle changes, and nowhere else — which is
 * what keeps it still while you edit underneath it.
 */
export function refreshPull() {
  releasePull();
  if (!bossPullOn.value) return;

  const { moves, deepest } = planPull(secondPullOn.value ? 2 : 1);
  if (!moves.length) return;

  // The ground and the move together: see movePositions().
  pullMoves = store.movePositions(moves, deepest);
}

// ---------------------------------------------------------------- arming

/**
 * Placing by thumb, on a phone.
 *
 * Tapping a bench chip does not place it. It shows where that Tatari would land
 * and, when its range is recorded, which tiles it would cover from there, and
 * waits. Tapping the chip again keeps that cell; tapping any cell takes that one
 * instead.
 *
 * The cost of a wrong tap used to be a token appearing somewhere you were not
 * looking, then a drag to fix it. The cost now is a second tap. It also answers
 * "what does this one actually reach" for someone who does not know the roster
 * by heart, which is most of the people this is for.
 */
const PHONE = matchMedia('(max-width: 760px)');

/** @type {null | {slug: string, player: number, cell: number}} */
let armed = null;

/** Said once per session. After that the preview speaks for itself. */
let taughtArming = false;

function arm(slug, player) {
  // A second tap on the same chip means "yes, there".
  if (armed && armed.slug === slug && armed.player === player) {
    commit(armed.cell);
    return;
  }

  const t = state.bySlug.get(slug);
  if (!t) return;

  const reason = store.placeBlockedReason(t, player);
  if (reason) { toast(reason, 'error'); return; }

  const cell = store.firstFreeCell();
  if (cell === null) { toast('No empty cell', 'error'); return; }

  armed = { slug, player, cell };
  renderArmed();

  // Only if the proposed cell is actually hidden, and only by as much as it
  // takes. The cells carry a scroll-margin the height of the dock and the app
  // bar, so "nearest" knows the bottom strip is spoken for; centring it instead
  // hauled the whole page and pushed the top of the field off the screen.
  cellEls[cell]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  if (!taughtArming) {
    taughtArming = true;
    toast('Tap again to place it there, or tap the cell you want');
  }
}

function commit(cell) {
  if (!armed) return;
  const { slug, player } = armed;
  disarm();
  const result = store.place(slug, cell, player);
  if (!result.ok) toast(result.reason, 'error');
}

function disarm() {
  armed = null;
  renderArmed();
}

/**
 * Draws the armed state. Called from both renderers because each of them
 * rewrites the elements this marks.
 */
function renderArmed() {
  // The suggested cell can be taken by the time this runs again (a co-op
  // partner's token, an import, an undo), so it is re-checked rather than
  // trusted.
  if (armed && store.formation.cells[armed.cell]) {
    const next = store.firstFreeCell();
    if (next === null) armed = null;
    else armed.cell = next;
  }

  for (const cell of cellEls) cell.classList.remove('is-target');
  for (const chip of benchHost.querySelectorAll('.benchchip')) chip.classList.remove('is-armed');

  if (!armed) { clearRangePreview(); return; }

  cellEls[armed.cell]?.classList.add('is-target');
  benchHost
    .querySelector(`.benchchip[data-slug="${CSS.escape(armed.slug)}"][data-player="${armed.player}"]`)
    ?.classList.add('is-armed');
  previewRange(armed.cell, armed.slug);
}

// ---------------------------------------------------------------- rendering

function ownerBadge(player) {
  return store.isCoop()
    ? `<span class="token__owner" data-player="${player}">P${player}</span>`
    : '';
}

/**
 * The element as a letter, for anyone who cannot read it off the tint.
 *
 * A token says which element it is in exactly one way: a coloured wash and a
 * coloured ring. That is one channel, and it fails — Fire #e8453c and Rock
 * #a2762f simulate to the same muddy orange for a deuteranope, dE 8.9, where
 * anything under about 15 has stopped being two colours. Grass/Lightning and
 * Water/Grass are nearly as bad for the other two dichromacies.
 *
 * So: a shape, in neutral ink, saying the same fact without hue. Not instead of
 * the colour — alongside it, because two weak channels beat one.
 *
 * The initial is enough while there are five elements and no two share one.
 * A sixth that collided would need a table here; the type chart in meta.json is
 * the thing to check first.
 *
 * aria-hidden because every cell's own label already names the element in full,
 * and a screen reader reading "W" after "Water" is noise.
 *
 * Always in the markup, shown by CSS. The toggle then costs no re-render, and
 * the board does not permanently gain a badge most people did not ask for.
 */
function elemGlyph(type) {
  return type ? `<span class="token__elem" aria-hidden="true">${type[0]}</span>` : '';
}

function tokenGhost(t, player) {
  return `<span class="token" data-type="${t.type}" data-player="${player}">${
    artHTML(t, { lazy: false })}${elemGlyph(t.type)}${ownerBadge(player)}</span>`;
}

export function renderGrid() {
  /*
   * How much ground past the line is drawn. The Zobo toggle shows all seven; a
   * boss pull shows only the rows it opened, counting outwards from the line, so
   * a single-round pull adds one row and a second round adds another.
   *
   * Row visibility rather than one flag on the whole grid, because the two
   * sources disagree about how much to show and the store already knows the
   * answer per cell.
   */
  const openRows = store.isZoboGround() ? store.ENEMY_ROWS : store.pullRows();
  if (enemy) {
    enemy.hidden = openRows === 0;
    // Rows are laid out outermost first, so the open ones are the last N.
    [...enemy.children].forEach((row, r) => {
      const shown = r >= store.ENEMY_ROWS - openRows;
      row.hidden = !shown;
      row.classList.toggle('grid__row--pull', shown && !store.isZoboGround());
    });
  }

  // Where the boss put things, so those cells can be marked. Nothing is drawn
  // from this — the Tatari really are in these cells now.
  const landed = new Set(pullDestinations());

  for (const cell of cellEls) {
    const i = Number(cell.dataset.cell);
    const occ = store.formation.cells[i];
    const t = occ ? pieceBySlug(occ.slug) : null;
    const isZobo = occ?.kind === 'zobo';
    cell.classList.toggle('is-pulled', !!t && landed.has(i));
    // Beyond the line the rows run outwards from the field, so they are named
    // for what they are rather than given a row number that collides with the
    // field's own: "Zobo row 3" and "Row 3" are different places.
    const where = store.isEnemyCell(i)
      ? `Zobo row ${-store.cellDisplayRow(i)}, column ${store.cellCol(i) + 1}`
      : `Row ${store.cellRow(i) + 1}, column ${store.cellCol(i) + 1}`;

    cell.classList.toggle('is-filled', !!t);
    cell.classList.toggle('is-carried', carried === i);
    cell.classList.remove('is-over');

    if (!t) {
      cell.innerHTML = '';
      delete cell.dataset.type;
      delete cell.dataset.player;
      delete cell.dataset.zobo;
      cell.setAttribute('aria-label', `${where}, empty`);
      continue;
    }

    // The badge is the level this one is planned to reach - the strategic
    // question at a glance. Step order is read from the plan panel.
    const levels = store.plannedLevels(occ.slug, occ.player);
    const target = levels.length ? levels[levels.length - 1] : null;
    const plan = levels.length ? `planned to level ${levels.join(', then ')}` : 'no level-ups planned';
    const who = store.isCoop() ? `player ${occ.player}, ` : '';

    // The step this one is taken at, so the field shows the plan has an order
    // and not just a set of target levels.
    const seat = store.planPositionOf(occ.slug, occ.player);
    const order = seat
      ? `<b class="token__seq">${seat}</b>`
      : '';

    if (isZobo) {
      /*
       * No tier, no role, no owner badge and no plan button: a Zobo has none of
       * those, and the ones it does not have are exactly the controls that would
       * offer to level it up or file it under a player. What is worth showing is
       * that it is an enemy and which element, so the type still drives the tint
       * and `data-zobo` carries the rest.
       */
      cell.dataset.zobo = '1';
      if (t.type) cell.dataset.type = t.type; else delete cell.dataset.type;
      delete cell.dataset.player;
      cell.innerHTML = `
        <span class="token token--zobo"${t.type ? ` data-type="${t.type}"` : ''}>
          ${artHTML(t, ON_CARD)}
          ${elemGlyph(t.type)}
          ${t.boss ? '<span class="token__boss" title="Boss">★</span>' : ''}
        </span>`;
      cell.setAttribute('aria-label',
        `${where}: ${t.name}, Zobo${t.type ? `, ${t.type}` : ''}${t.boss ? ', boss' : ''}`);
      continue;
    }
    delete cell.dataset.zobo;

    cell.dataset.type = t.type;
    cell.dataset.player = String(occ.player);
    cell.innerHTML = `
      <span class="token" data-type="${t.type}" data-player="${occ.player}">
        ${artHTML(t, ON_CARD)}
        ${elemGlyph(t.type)}
        <span class="token__tier">T${t.tier}</span>
        <span class="token__role">${roleIcon(t.role)}</span>
        ${ownerBadge(occ.player)}
        ${seat || target
          ? `<span class="token__rank" title="${esc(t.name)}${
            seat ? `, step ${seat} of the plan` : ''}, ${plan}">${order}${
            target ? `L${target}` : ''}</span>`
          : '<button class="token__add" type="button" data-add-step ' +
            `aria-label="Plan a level-up for ${esc(t.name)}" title="Plan a level-up">+</button>`}
      </span>`;
    cell.setAttribute('aria-label',
      `${where}${landed.has(i) ? ', dragged here by the boss' : ''}: ${t.name}, ${who}${t.type} ${t.role}, tier ${t.tier}, ${plan}${
        seat ? `, step ${seat} of the plan` : ''}`);
  }
  renderRanges();
  renderArmed();
}

/**
 * The "looking for" line: the editable field above, and the copy of it drawn
 * inside the frame so it survives a screenshot of the grid.
 *
 * Co-op only, because it is an ask aimed at the other player.
 */
export function renderLF() {
  const coop = store.isCoop();
  const side = store.formation.lfMode;
  const line = store.lfLine(side);

  $('#lf-field').hidden = !coop;

  // The pair carries a count, so the line you are not editing still shows that
  // it has something on it — otherwise the other half is invisible.
  for (const btn of $('#lf-mode').children) {
    const its = store.lfLine(btn.dataset.side);
    const n = its.wants.length + (its.note.trim() ? 1 : 0);
    btn.setAttribute('aria-pressed', String(btn.dataset.side === side));
    btn.innerHTML = `${store.LF_LABELS[btn.dataset.side].replace(':', '')}${
      n ? `<span class="lf-mode__n">${n}</span>` : ''}`;
  }

  const note = $('#lf');
  if (note.value !== line.note) note.value = line.note;
  note.placeholder = side === 'have'
    ? '…or anything else you bring'
    : '…or anything else, e.g. a healer';
  $('#lf-pick').placeholder = side === 'have' ? 'Add a Tatari you have…' : 'Add a Tatari…';

  const chips = line.wants.map((slug) => state.bySlug.get(slug)).filter(Boolean);
  $('#lf-wants').innerHTML = chips.map((t) => `
    <span class="want" data-slug="${esc(t.slug)}" data-type="${esc(t.type)}">
      ${artHTML(t, ON_CARD)}<span class="want__name">${esc(t.name)}</span>
      <button class="want__x" type="button" data-drop-want="${esc(t.slug)}"
        aria-label="Take ${esc(t.name)} off this line">×</button>
    </span>`).join('');

  // On the field, both lines are drawn, which is the whole point of splitting
  // them, with HAVE first, because it reads as the offer before the ask.
  const filled = store.filledLines();
  const shown = $('#field-lf');
  shown.hidden = !coop || !filled.length;
  shown.innerHTML = filled.map((l) => {
    const named = l.wants.map((slug) => state.bySlug.get(slug)).filter(Boolean);
    return `<span class="field-lf__line" data-mode="${l.side}">
      <span class="field-lf__tag">${esc(store.LF_LABELS[l.side])}</span>${
      named.map((t) => `<span class="field-lf__want" data-type="${esc(t.type)}">${
        artHTML(t, ON_CARD)}<span>${esc(t.name)}</span></span>`).join('')
    }${l.note.trim() ? `<span class="field-lf__note">${esc(l.note.trim())}</span>` : ''}
    </span>`;
  }).join('');
}

/**
 * The roster's own search, narrowed to a short list and drawn with sprites.
 * Reusing `matches` means an alias like "toucan" or "panda" finds the Tatari
 * here exactly as it does in the roster, which is where people learn it.
 */
export function renderLfSuggestions(query) {
  const box = $('#lf-suggest');
  const q = query.trim();
  const already = store.lfLine().wants;
  const hits = q
    ? state.all.filter((t) => matches(t, q) && !already.includes(t.slug))
      .slice(0, LF_SUGGESTIONS)
    : [];

  box.innerHTML = hits.map((t, i) => `
    <li role="option" id="lf-opt-${i}" aria-selected="false"
        data-slug="${esc(t.slug)}" data-type="${esc(t.type)}">
      ${artHTML(t)}
      <span class="lf-suggest__name">${esc(t.name)}</span>
      <span class="lf-suggest__meta">${typeIcon(t.type)}${roleIcon(t.role)}T${t.tier}</span>
    </li>`).join('');

  const open = hits.length > 0;
  box.hidden = !open;
  $('#lf-pick').setAttribute('aria-expanded', String(open));
  return hits.length;
}

/** Long enough to be useful, short enough not to cover the field on a phone. */
const LF_SUGGESTIONS = 7;

export function renderPlayerTabs() {
  const coop = store.isCoop();
  tabsHost.hidden = !coop;
  renderLF();
  if (!coop) return;

  tabsHost.innerHTML = store.players().map((player) => {
    const field = store.placedCount(player);
    const bench = store.benchOf(player).length;
    const active = player === store.formation.activePlayer;
    return `
      <button class="ptab" type="button" data-player="${player}"
              data-active="${active}" aria-pressed="${active}">
        <span class="ptab__who" data-player="${player}">P${player}</span>
        <span class="ptab__nums">
          <span>field <b>${field}</b>/${store.fieldCap()}</span>
          <span>bench <b>${bench}</b>${capOf(store.benchCap())}</span>
        </span>
      </button>`;
  }).join('') + `
      <button id="btn-switch-players" class="btn btn--tiny ptabs__switch" type="button"
              aria-pressed="${switchingPlayers.value}"
              title="Hand a Tatari to the other player, keeping its level-up plan. Tap this, then tap a Tatari on the field or a bench.">
        ${switchingPlayers.value ? 'Tap a Tatari…' : '⇄ Switch player'}
      </button>`;

  document.body.dataset.switching = String(switchingPlayers.value);
}

/**
 * Hands one Tatari to the other player, and says what happened.
 *
 * Shared by the field and the bench because both are places you notice the
 * mistake from, and both should answer the same way.
 */
function switchOwner(slug, player) {
  const result = store.switchPlayer(slug, player);
  if (!result.ok) { toast(result.reason, 'error'); return; }
  const name = state.bySlug.get(slug)?.name ?? slug;
  const to = player === 1 ? 2 : 1;
  toast(result.swapped
    ? `${name} swapped — P${to} and P${player} traded, plans included`
    : `${name} is P${to}'s now, plan and all`);
}

/**
 * Every player's bench, not just the active one, so a co-op planner can drag
 * either teammate's Tatari straight onto the field.
 */
/**
 * "6/15" normally, and just "6" when there is no ceiling.
 *
 * Sandbox lifts the bench cap to Infinity, which is the right value to compute
 * with and the wrong one to print — the count read "6/Infinity brought". A
 * missing denominator says "no limit" better than any symbol would, and better
 * than picking a large number to pretend there is one.
 */
const capOf = (cap, sep = '/') => (Number.isFinite(cap) ? `${sep}${cap}` : '');

export function renderBench() {
  const coop = store.isCoop();

  benchHost.innerHTML = store.players().map((player) => {
    const bench = store.benchOf(player);
    const waiting = store.unplacedBench(player);
    const active = player === store.formation.activePlayer;

    const chips = waiting.map((slug) => {
      const t = state.bySlug.get(slug);
      return `
        <span class="benchchip" data-slug="${esc(slug)}" data-player="${player}"
              data-type="${t.type}" tabindex="0" role="button"
              title="${esc(t.name)}: drag onto the field, or click to drop it in the back">
          ${artHTML(t, ON_CARD)}
          ${coop ? `<span class="benchchip__owner" data-player="${player}">${player}</span>` : ''}
          <button class="benchchip__x" type="button" data-unbench
                  aria-label="Stop bringing ${esc(t.name)}${coop ? ` for P${player}` : ''}">&times;</button>
        </span>`;
    }).join('');

    const body = !bench.length
      /*
       * Real copy, not an empty <p>. Both branches of the ternary that used to
       * be here produced the empty string, so the one surface where a first-time
       * player is looking -- the dock, right above the button they need -- said
       * nothing at all. PRODUCT.md names that player as an intended user the
       * interface has to carry.
       */
      ? `<p class="bench__empty">Nothing brought yet. Press <b>Add</b> to pick from the
           ${state.all.length} Tatari${coop ? `, for P${player}` : ''}.</p>`
      : waiting.length
        ? `<div class="bench__strip">${chips}</div>`
        : '<p class="bench__empty">Everything brought is on the field.</p>';

    return `
      <div class="bench__player" data-player="${player}" data-active="${active}">
        <div class="bench__head">
          ${coop
    ? `<button class="summary__label" type="button" data-player="${player}"
                     data-switch-player="${player}" aria-pressed="${active}"
                     title="Plan for P${player}">P${player} bench</button>`
    : '<span class="summary__label">Bench</span>'}
          <span class="bench__count"
                title="${bench.length}${capOf(store.benchCap(), ' of ')} on the bench, ${
  bench.length - waiting.length} of ${store.fieldCap()} on the field"><b>${
  bench.length}</b>${capOf(store.benchCap())} brought,
            <b>${bench.length - waiting.length}</b>/${store.fieldCap()} placed</span>
          ${active
    ? `<button class="btn btn--tiny bench__clean" type="button" data-clean
                     title="Hide everything else so the field is all that is on screen">⛶ Just the grid</button>`
    : ''}
          <button class="btn btn--tiny btn--quiet" type="button" data-clear-bench="${player}"
                  aria-label="Clear ${coop ? `P${player}'s bench` : 'the bench'}"
                  ${bench.length ? '' : 'disabled'}>Clear bench</button>
        </div>
        ${body}
      </div>`;
  }).join('');

  for (const chip of benchHost.querySelectorAll('.benchchip')) {
    const slug = chip.dataset.slug;
    const player = Number(chip.dataset.player);
    draggable(
      chip,
      () => ({ slug, player, from: 'bench' }),
      () => tokenGhost(state.bySlug.get(slug), player)
    );
  }
  renderArmed();
}

// ---------------------------------------------------------------- keyboard

/*
 * One top-to-bottom sequence over whatever is on screen: the Zobo rows first
 * when Sandbox is on, then the field. Outside Sandbox the sequence is just the
 * field, so nothing can be focused that is not drawn.
 */
const toDisplay = (i) => (store.isEnemyCell(i)
  ? i - store.ENEMY_FIRST
  : i + (store.isZoboGround() ? store.ENEMY_CELLS : 0));

function fromDisplay(d) {
  const offset = store.isZoboGround() ? store.ENEMY_CELLS : 0;
  if (d < 0) return null;
  if (d < offset) return store.ENEMY_FIRST + d;
  const cell = d - offset;
  return cell < store.CELLS ? cell : null;
}

function onKeydown(e) {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const i = Number(cell.dataset.cell);

  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -store.COLS, ArrowDown: store.COLS }[e.key];
  if (step !== undefined) {
    /*
     * Navigated in display order, not in index order, because in Sandbox the two
     * disagree. The Zobo rows are drawn above the field and numbered after it,
     * so Up from the field's front row is not `i - 6` — it is the last row of a
     * block 36 higher. Mapping both blocks onto one top-to-bottom sequence makes
     * every arrow a step of 1 or COLS again, and the seam between the two grids
     * stops being a special case.
     */
    const next = fromDisplay(toDisplay(i) + step);
    const staysInRow = Math.abs(step) !== 1
      || (next !== null && Math.floor(toDisplay(next) / store.COLS) === Math.floor(toDisplay(i) / store.COLS));
    if (next !== null && staysInRow) {
      e.preventDefault();
      focusCell(next);
    }
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    store.unplaceAt(i);
    return;
  }

  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (carried === null) {
      if (!store.formation.cells[i]) return;
      carried = i;
      renderGrid();
      toast('Picked up. Arrow keys to move, Enter to drop');
    } else {
      const occ = store.formation.cells[carried];
      carried = null;
      const result = store.place(occ.slug, i, occ.player);
      if (!result.ok) toast(result.reason, 'error');
      renderGrid();
    }
    return;
  }

  if (e.key === 'Escape' && carried !== null) {
    carried = null;
    renderGrid();
  }
}

export function focusCell(i) {
  for (const cell of cellEls) cell.tabIndex = -1;
  cellEls[i].tabIndex = 0;
  cellEls[i].focus();
}

// ---------------------------------------------------------------- summary

/** Type and role spread of everything on the field, per player in co-op. */
export function renderSummary() {
  const groups = store.isCoop()
    ? store.players().map((p) => ({ player: p, list: fieldTatari(p) }))
    : [{ player: null, list: fieldTatari(1) }];

  const total = groups.reduce((n, g) => n + g.list.length, 0);
  if (!total) {
    $('#summary').innerHTML =
      '<p class="summary__note">No Tatari on the field yet. Click a Tatari in the roster to get started.</p>';
    return;
  }

  const tally = (list, key, values) => values.map((v) => {
    const n = list.filter((t) => t[key] === v).length;
    // title on a bare <span> is not exposed by most screen readers, so the
    // type and role breakdown read as "3 5 2 1 0 4" with nothing to attach the
    // numbers to. role="img" plus a label makes each one a sentence.
    return `<span class="tally" role="img" aria-label="${esc(v)}: ${n}"
      data-empty="${n === 0}" title="${esc(v)}: ${n}">${
      key === 'type' ? typeIcon(v) : roleIcon(v)}${n}</span>`;
  }).join('');

  $('#summary').innerHTML = groups.map(({ player, list }) => `
    <div class="summary__player">
      ${player ? `<span class="summary__label" data-player="${player}">P${player}</span>` : ''}
      <div class="summary__group"><span class="summary__label">Types</span>${
        tally(list, 'type', state.meta.types)}</div>
      <div class="summary__group"><span class="summary__label">Roles</span>${
        tally(list, 'role', state.meta.roles)}</div>
    </div>
    ${effectRows(list, player)}`).join('')
}

/**
 * What this half of the field brings besides damage: who heals, what it buffs,
 * what it inflicts. Grouped rather than listed flat, because "do we have a heal
 * and a slow" is the question, not "how many skills mention Fragile".
 *
 * Each one opens to name who brings it. That was a tooltip, which meant it did
 * not exist on a phone — and "who is my only healer" is exactly the question
 * you ask while rearranging the field with your thumb.
 */
function effectRows(list, player) {
  const found = effectsOf(list);
  const rows = ['heal', 'buff', 'debuff'].filter((g) => found[g].length).map((g) => `
    <div class="summary__group">
      <span class="summary__label">${GROUP_LABELS[g]}</span>
      ${found[g].map((e) => effectTally(g, e, player)).join('')}
    </div>`).join('');

  if (!rows) {
    return `<p class="summary__note">Nothing on the field has a heal, buff or debuff${
      found.untagged ? ` — ${found.untagged} of them are untagged on the wiki` : ''}.</p>`;
  }

  /*
   * The sources go in a slot of their own, always present and always the same
   * height, rather than opening inside the row of tallies. Expanding in place
   * re-wrapped the row and shoved every other effect sideways, so reading the
   * second one meant hunting for where it had moved to.
   */
  const chosen = openEffect?.player === player
    ? found[openEffect.group]?.find((e) => e.type === openEffect.type)
    : null;

  return `<div class="summary__player summary__player--effects">${rows}</div>
    <div class="effect__panel" data-empty="${!chosen}">${
      chosen ? effectSourceList(chosen) : 'Tap an effect to see who brings it.'}</div>`;
}

/**
 * Who brings the selected effect, and what levelling it costs.
 *
 * Sprites rather than names alone: you picked these Tatari by their art, and
 * that is how you recognise them again. The info toggle explains the effect
 * itself, since the wiki tags skills with these words but never says what any
 * of them do.
 */
function effectSourceList(e) {
  const help = helpFor(e.type);
  return `<div class="effect__panelhead">
      <b>${esc(e.type)}</b>
      <button class="fx-info" type="button" data-help="${esc(e.type)}"
        aria-expanded="${helpOpen === e.type}"
        aria-label="What does ${esc(e.type)} do?">i</button>
    </div>
    ${helpOpen === e.type
    ? `<p class="effect__help"${help ? '' : ' data-missing="true"'}>${
      help
        ? `${esc(help)}<span class="effect__helpnote">From the wiki's ${esc(e.type)} category.</span>`
        : `The wiki does not describe ${esc(e.type)} yet.<span class="effect__helpnote">Its category page is empty or still says TBA.</span>`
    }</p>`
    : ''}
    <ul class="effect__who">${
  e.sources.map((s) => {
    const t = state.bySlug.get(slugOfName(s.name));
    return `<li>${t ? `<span class="who__art">${artHTML(t)}</span>` : ''}${esc(s.name)}${
      s.level === null
        ? ' <span class="who__lv">from the start</span>'
        : ` <span class="who__lv">at level ${s.level}${
          s.skillName ? ` · ${esc(s.skillName)}` : ''}</span>`
    }</li>`;
  }).join('')}</ul>`;
}

/** Sources carry the display name, and the sprite needs the slug behind it. */
function slugOfName(name) {
  return state.all.find((t) => t.name === name)?.slug ?? '';
}

/** Which effect's plain-words description is showing, if any. */
let helpOpen = null;

/**
 * One effect, openable to show its sources.
 *
 * The level badge is the point of the whole thing: an effect that only arrives
 * with a level-5 skill is not something the formation has, it is something the
 * formation could have, and those read very differently when you are deciding
 * whether you still need a healer.
 */
function effectTally(group, e, player) {
  const only = e.fromLevel && !e.fromBase;
  const badge = e.fromLevel
    ? `<span class="tally__lv" title="${only
        ? `Only from a level-up skill: needs levelling to ${e.minLevel}`
        : `Also gained from a level-up skill, from level ${e.minLevel}`}">${
        only ? '' : '+'}L${e.minLevel}</span>`
    : '';

  const on = openEffect?.player === player
    && openEffect.group === group && openEffect.type === e.type;

  return `<button class="tally tally--effect" type="button" data-effect="${group}"
    data-only-level="${only}" data-pick="${esc(e.type)}" data-group="${group}"
    aria-pressed="${on}">${esc(e.type)}<b>${e.count}</b>${badge}</button>`;
}

/**
 * Which effect's sources are showing. Kept out here because renderSummary()
 * rewrites the whole block on every change to the field, and losing your place
 * every time you moved a token would make it useless.
 * @type {null | {player: number|null, group: string, type: string}}
 */
let openEffect = null;

function fieldTatari(player) {
  return store.placedFor(player).map(({ slug }) => state.bySlug.get(slug)).filter(Boolean);
}
