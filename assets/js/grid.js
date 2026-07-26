/** Your half of the battlefield (6 wide, 5 deep): rendering, drops, keyboard. */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, roleIcon, typeIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';

const grid = $('#grid');

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
        const slug = store.formation.cells[i];
        return slug ? { slug, from: 'grid' } : null;
      },
      () => {
        const t = state.bySlug.get(store.formation.cells[i]);
        return `<span class="token" data-type="${t.type}">${artHTML(t, { lazy: false })}</span>`;
      }
    );
  }

  dropZone({
    selector: '.cell',
    accepts: (target, payload) => {
      // Anything already deployed is just being moved or swapped, whether it was
      // picked up from the field or from the priority list.
      if (store.cellOf(payload.slug) !== null) return true;
      const t = state.bySlug.get(payload.slug);
      return !!t && !store.blockedReason(t);
    },
    onHover: (target, ok) => {
      target.classList.toggle('is-over', ok);
      target.classList.toggle('is-invalid', !ok);
    },
    onDrop: (target, payload) => {
      const result = store.place(payload.slug, Number(target.dataset.cell));
      if (!result.ok) toast(result.reason, 'error');
    },
  });

  grid.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) store.removeAt(Number(cell.dataset.cell));
  });

  grid.addEventListener('keydown', onKeydown);
}

export function renderGrid() {
  for (const cell of grid.children) {
    const i = Number(cell.dataset.cell);
    const slug = store.formation.cells[i];
    const t = slug ? state.bySlug.get(slug) : null;
    const where = `Row ${store.cellRow(i) + 1}, column ${store.cellCol(i) + 1}`;

    cell.classList.toggle('is-filled', !!t);
    cell.classList.toggle('is-carried', carried === i);
    cell.classList.remove('is-over', 'is-invalid');

    if (!t) {
      cell.innerHTML = '';
      delete cell.dataset.type;
      cell.setAttribute('aria-label', `${where}, empty`);
      continue;
    }

    const rank = store.formation.priority.indexOf(slug) + 1;
    cell.dataset.type = t.type;
    cell.innerHTML = `
      <span class="token" data-type="${t.type}">
        ${artHTML(t)}
        <span class="token__tier">T${t.tier}</span>
        <span class="token__role">${roleIcon(t.role)}</span>
        ${rank ? `<span class="token__rank" title="Level-up priority ${rank}">${rank}</span>` : ''}
      </span>`;
    cell.setAttribute('aria-label',
      `${where}: ${t.name}, ${t.type} ${t.role}, tier ${t.tier}, level-up priority ${rank}`);
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
    store.removeAt(i);
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
      const slug = store.formation.cells[carried];
      carried = null;
      const result = store.place(slug, i);
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

/** Type/role spread plus any front/back-row placements the wiki disagrees with. */
export function renderSummary() {
  const deployed = store.deployedSlugs().map((s) => state.bySlug.get(s)).filter(Boolean);

  if (!deployed.length) {
    $('#summary').innerHTML =
      '<p class="summary__note">Nothing deployed yet — pick 15 from the roster.</p>';
    return;
  }

  const tally = (key, values) => values.map((v) => {
    const n = deployed.filter((t) => t[key] === v).length;
    const icon = key === 'type' ? typeIcon(v) : roleIcon(v);
    return `<span class="tally" data-empty="${n === 0}" title="${esc(v)}: ${n}">${icon}${n}</span>`;
  }).join('');

  const misplaced = deployed.filter((t) => {
    const row = store.cellRow(store.cellOf(t.slug));
    return (t.battleRow === 'front' && row > 2) || (t.battleRow === 'back' && row < 2);
  });

  const notes = [`<b>${deployed.length}</b> deployed — <b>${
    new Set(deployed.map((t) => t.type)).size}</b> of 5 types, <b>${
    new Set(deployed.map((t) => t.role)).size}</b> of 6 roles.`];
  if (misplaced.length) {
    notes.push(`The wiki lists ${misplaced.map((t) =>
      `<b>${esc(t.name)}</b> as ${t.battleRow}-row`).join(', ')} — sitting on the far side of the field right now.`);
  }

  $('#summary').innerHTML = `
    <div class="summary__group"><span class="summary__label">Types</span>${
      tally('type', state.meta.types)}</div>
    <div class="summary__group"><span class="summary__label">Roles</span>${
      tally('role', state.meta.roles)}</div>
    ${notes.map((n) => `<p class="summary__note">${n}</p>`).join('')}`;
}
