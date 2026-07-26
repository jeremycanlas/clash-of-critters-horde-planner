/**
 * The shared field (6 wide, 6 deep), the bench strip beneath it, and the player
 * tabs above it.
 *
 * In co-op both players' tokens sit on the same field, so every occupant carries
 * its owner and tokens are badged P1 / P2. The bench strip shows the part of the
 * active player's 15 that has not landed yet.
 */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, roleIcon, typeIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';
import { quickAddStep } from './priority.js';
import { coveredFrom, coverage, hasRange } from './range.js';

const grid = $('#grid');
const benchHost = $('#bench');
const tabsHost = $('#player-tabs');

/** Cell the keyboard user has "picked up", if any. */
let carried = null;

export function buildGrid() {
  grid.innerHTML = '';
  for (let i = 0; i < store.CELLS; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.cell = String(i);
    cell.dataset.row = String(store.cellRow(i));
    cell.setAttribute('role', 'gridcell');
    cell.tabIndex = i === 0 ? 0 : -1;
    grid.append(cell);

    // Cell elements live for the whole session, so this binds exactly once.
    draggable(
      cell,
      () => {
        const occ = store.formation.cells[i];
        return occ ? { ...occ, from: 'field' } : null;
      },
      () => {
        const occ = store.formation.cells[i];
        return tokenGhost(state.bySlug.get(occ.slug), occ.player);
      }
    );
  }

  dropZone({
    selector: '.cell',
    accepts: (target, payload) => {
      if (!payload.slug) return false;
      const t = state.bySlug.get(payload.slug);
      if (!t) return false;
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
      const result = store.place(payload.slug, Number(target.dataset.cell), payload.player);
      if (!result.ok) toast(result.reason, 'error');
    },
  });

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
    const add = e.target.closest('[data-add-step]');
    if (!add) return;
    const occ = store.formation.cells[Number(add.closest('.cell').dataset.cell)];
    if (occ) quickAddStep(occ.slug, occ.player);
  });

  grid.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) store.unplaceAt(Number(cell.dataset.cell));
  });

  grid.addEventListener('keydown', onKeydown);

  benchHost.addEventListener('click', (e) => {
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

    const chip = e.target.closest('.benchchip');
    if (!chip) return;
    const { slug, player } = chip.dataset;
    if (e.target.closest('[data-unbench]')) {
      store.removeFromBench(slug, Number(player));
      return;
    }
    const result = store.autoPlace(slug, Number(player));
    if (!result.ok) toast(result.reason, 'error');
  });

  tabsHost.addEventListener('click', (e) => {
    const tab = e.target.closest('.ptab');
    if (tab) store.setActivePlayer(Number(tab.dataset.player));
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
  if (!slug || !hasRange(slug)) return;
  for (const i of coveredFrom(cell, slug)) {
    const el = grid.children[i];
    if (!el) continue;
    el.classList.add('is-inrange');
    previewed.push(el);
  }
}

/**
 * How many of the Tatari on the field can hit each tile. The gaps are the point:
 * a lane nothing covers is where the Zobos walk through.
 */
export function renderCoverage() {
  const on = coverageOn.value;
  grid.classList.toggle('shows-coverage', on);

  const { counts, known, unknown } = on
    ? coverage(store.allPlaced())
    : { counts: [], known: 0, unknown: 0 };

  for (const cell of grid.children) {
    const n = counts[Number(cell.dataset.cell)] ?? 0;
    if (on && n) cell.dataset.cover = Math.min(n, 4);
    else delete cell.dataset.cover;
  }

  const note = $('#coverage-note');
  note.hidden = !on;
  if (!on) return;
  const blind = counts.filter((n) => !n).length;
  note.textContent = known
    ? `${blind} of ${counts.length} tiles uncovered` +
      (unknown
        ? ` · ${unknown} on the field ${unknown === 1 ? 'has' : 'have'} no recorded range`
        : '')
    : 'None of the Tatari on the field have a recorded range yet.';
}

/** Whether the coverage view is on. Toggled from the formation panel. */
export const coverageOn = { value: false };

// ---------------------------------------------------------------- rendering

function ownerBadge(player) {
  return store.isCoop()
    ? `<span class="token__owner" data-player="${player}">P${player}</span>`
    : '';
}

function tokenGhost(t, player) {
  return `<span class="token" data-type="${t.type}" data-player="${player}">${
    artHTML(t, { lazy: false })}${ownerBadge(player)}</span>`;
}

export function renderGrid() {
  for (const cell of grid.children) {
    const i = Number(cell.dataset.cell);
    const occ = store.formation.cells[i];
    const t = occ ? state.bySlug.get(occ.slug) : null;
    const where = `Row ${store.cellRow(i) + 1}, column ${store.cellCol(i) + 1}`;

    cell.classList.toggle('is-filled', !!t);
    cell.classList.toggle('is-carried', carried === i);
    cell.classList.remove('is-over');

    if (!t) {
      cell.innerHTML = '';
      delete cell.dataset.type;
      delete cell.dataset.player;
      cell.setAttribute('aria-label', `${where}, empty`);
      continue;
    }

    // The badge is the level this one is planned to reach - the strategic
    // question at a glance. Step order is read from the plan panel.
    const levels = store.plannedLevels(occ.slug, occ.player);
    const target = levels.length ? levels[levels.length - 1] : null;
    const plan = levels.length ? `planned to level ${levels.join(', then ')}` : 'no level-ups planned';
    const who = store.isCoop() ? `player ${occ.player}, ` : '';

    cell.dataset.type = t.type;
    cell.dataset.player = String(occ.player);
    cell.innerHTML = `
      <span class="token" data-type="${t.type}" data-player="${occ.player}">
        ${artHTML(t)}
        <span class="token__tier">T${t.tier}</span>
        <span class="token__role">${roleIcon(t.role)}</span>
        ${ownerBadge(occ.player)}
        ${target
          ? `<span class="token__rank" title="${esc(t.name)} ${plan}">L${target}</span>`
          : '<button class="token__add" type="button" data-add-step ' +
            `aria-label="Plan a level-up for ${esc(t.name)}" title="Plan a level-up">+</button>`}
      </span>`;
    cell.setAttribute('aria-label',
      `${where}: ${t.name}, ${who}${t.type} ${t.role}, tier ${t.tier}, ${plan}`);
  }
  renderCoverage();
}

export function renderPlayerTabs() {
  const coop = store.isCoop();
  tabsHost.hidden = !coop;
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
          <span>bench <b>${bench}</b>/${store.benchCap()}</span>
        </span>
      </button>`;
  }).join('');
}

/**
 * Every player's bench, not just the active one, so a co-op planner can drag
 * either teammate's Tatari straight onto the field.
 */
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
              title="${esc(t.name)} — drag onto the field, or click to drop it in the back">
          ${artHTML(t)}
          ${coop ? `<span class="benchchip__owner" data-player="${player}">${player}</span>` : ''}
          <button class="benchchip__x" type="button" data-unbench
                  aria-label="Stop bringing ${esc(t.name)}${coop ? ` for P${player}` : ''}">&times;</button>
        </span>`;
    }).join('');

    const body = !bench.length
      ? `<p class="bench__empty">${
        coop ? `` : ''}</p>`
      : waiting.length
        ? `<div class="bench__strip">${chips}</div>`
        : '<p class="bench__empty">Everything brought is on the field.</p>';

    return `
      <div class="bench__player" data-player="${player}" data-active="${active}">
        <div class="bench__head">
          <span class="summary__label"${coop ? ` data-player="${player}"` : ''}>${
            coop ? `P${player} bench` : 'Bench'}</span>
          <span class="bench__count"><b>${bench.length}</b>/${store.benchCap()} on the bench,
            <b>${bench.length - waiting.length}</b>/${store.fieldCap()} on the field</span>
          <button class="btn btn--tiny btn--quiet" type="button" data-clear-bench="${player}"
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
}

// ---------------------------------------------------------------- keyboard

function onKeydown(e) {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const i = Number(cell.dataset.cell);

  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -store.COLS, ArrowDown: store.COLS }[e.key];
  if (step !== undefined) {
    const next = i + step;
    const staysInRow = Math.abs(step) !== 1 || store.cellRow(next) === store.cellRow(i);
    if (next >= 0 && next < store.CELLS && staysInRow) {
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
      toast('Picked up — arrow keys to move, Enter to drop');
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
  for (const cell of grid.children) cell.tabIndex = -1;
  grid.children[i].tabIndex = 0;
  grid.children[i].focus();
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
    return `<span class="tally" data-empty="${n === 0}" title="${esc(v)}: ${n}">${
      key === 'type' ? typeIcon(v) : roleIcon(v)}${n}</span>`;
  }).join('');

  $('#summary').innerHTML = groups.map(({ player, list }) => `
    <div class="summary__player">
      ${player ? `<span class="summary__label" data-player="${player}">P${player}</span>` : ''}
      <div class="summary__group"><span class="summary__label">Types</span>${
        tally(list, 'type', state.meta.types)}</div>
      <div class="summary__group"><span class="summary__label">Roles</span>${
        tally(list, 'role', state.meta.roles)}</div>
    </div>`).join('')
}

function fieldTatari(player) {
  return store.placedFor(player).map(({ slug }) => state.bySlug.get(slug)).filter(Boolean);
}
