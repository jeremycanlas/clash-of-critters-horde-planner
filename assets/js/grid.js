/**
 * The shared field (6 wide, 5 deep), the bench strip beneath it, and the player
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
    onHover: (target, ok) => target.classList.toggle('is-over', ok),
    onDrop: (target, payload) => {
      const result = store.place(payload.slug, Number(target.dataset.cell), payload.player);
      if (!result.ok) toast(result.reason, 'error');
    },
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

  // Bench strip: drag a benched Tatari onto the field, or drop it to unbench.
  benchHost.addEventListener('click', (e) => {
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

export function renderBench() {
  const player = store.formation.activePlayer;
  const waiting = store.unplacedBench(player);
  const bench = store.benchOf(player);

  if (!bench.length) {
    benchHost.innerHTML =
      `<p class="bench__empty">Nothing on ${store.isCoop() ? `P${player}'s` : 'the'} bench yet
       — click a Tatari in the roster to bring it, or drag it straight onto the field.</p>`;
    return;
  }

  benchHost.innerHTML = `
    <div class="bench__head">
      <span class="summary__label">${store.isCoop() ? `P${player} bench` : 'Bench'}</span>
      <span class="bench__count"><b>${bench.length}</b>/${store.benchCap()} brought,
        <b>${bench.length - waiting.length}</b>/${store.fieldCap()} on the field</span>
    </div>
    ${waiting.length ? `<div class="bench__strip">${waiting.map((slug) => {
      const t = state.bySlug.get(slug);
      return `
        <span class="benchchip" data-slug="${esc(slug)}" data-player="${player}"
              data-type="${t.type}" tabindex="0" role="button"
              title="${esc(t.name)} — click to place on the field">
          ${artHTML(t)}
          <button class="benchchip__x" type="button" data-unbench
                  aria-label="Stop bringing ${esc(t.name)}">&times;</button>
        </span>`;
    }).join('')}</div>`
      : '<p class="bench__empty">Every Tatari on this bench is on the field.</p>'}`;

  for (const chip of benchHost.querySelectorAll('.benchchip')) {
    const { slug, player: p } = chip.dataset;
    draggable(
      chip,
      () => ({ slug, player: Number(p), from: 'bench' }),
      () => tokenGhost(state.bySlug.get(slug), Number(p))
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
      '<p class="summary__note">Nothing on the field yet — bring some Tatari and place them.</p>';
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
    </div>`).join('') + groups.map(({ player, list }) => {
    if (!list.length) return '';
    const label = player ? `P${player}: ` : '';
    return `<p class="summary__note">${label}<b>${list.length}</b> on the field — <b>${
      new Set(list.map((t) => t.type)).size}</b> of 5 types, <b>${
      new Set(list.map((t) => t.role)).size}</b> of 6 roles.</p>`;
  }).join('');
}

function fieldTatari(player) {
  return store.placedFor(player).map(({ slug }) => state.bySlug.get(slug)).filter(Boolean);
}
