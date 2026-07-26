/** The searchable, filterable roster you draft from. */

import { state, matches } from './data.js';
import * as store from './store.js';
import { TYPES, ROLES } from './icons.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast } from './ui.js';
import { draggable } from './dnd.js';
import { openDetail } from './detail.js';

const TIERS = [1, 2, 3, 4];

export const filters = {
  query: '',
  types: new Set(),
  roles: new Set(),
  tiers: new Set(),
  hideBlocked: false,
  sort: 'wiki',
};

const SORTS = {
  wiki: () => 0,
  name: (a, b) => a.name.localeCompare(b.name),
  type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  role: (a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name),
  tier: (a, b) => a.tier - b.tier || a.name.localeCompare(b.name),
};

export function buildFilters(onChange) {
  const chips = (host, values, set, kind, label) => {
    host.innerHTML = values.map((v) => `
      <button class="chip chip--${kind}" type="button" data-value="${esc(v)}"
              data-type="${kind === 'type' ? esc(v) : ''}"
              aria-pressed="false" title="${esc(label(v))}">
        ${kind === 'type' ? typeIcon(v, { badge: false })
          : kind === 'role' ? roleIcon(v, { badge: false })
            : `T${v}`}
      </button>`).join('');

    host.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const value = kind === 'tier' ? Number(chip.dataset.value) : chip.dataset.value;
      if (set.has(value)) set.delete(value); else set.add(value);
      chip.setAttribute('aria-pressed', String(set.has(value)));
      onChange();
    });
  };

  chips($('#filter-types'), TYPES, filters.types, 'type', (v) => `${v} type`);
  chips($('#filter-roles'), ROLES, filters.roles, 'role', (v) => `${v} role`);
  chips($('#filter-tiers'), TIERS, filters.tiers, 'tier', (v) => `Tier ${v}`);

  $('#search').addEventListener('input', (e) => {
    filters.query = e.target.value;
    onChange();
  });
  $('#sort').addEventListener('change', (e) => {
    filters.sort = e.target.value;
    onChange();
  });
  $('#opt-hide-blocked').addEventListener('change', (e) => {
    filters.hideBlocked = e.target.checked;
    onChange();
  });
  $('#btn-reset-filters').addEventListener('click', () => {
    resetFilters();
    onChange();
  });

  // Placing by click is the fast path; dragging is for arranging.
  $('#roster').addEventListener('click', (e) => {
    if (e.target.closest('.card__info')) {
      openDetail(e.target.closest('.card').dataset.slug);
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const slug = card.dataset.slug;
    if (store.cellOf(slug) !== null) { store.remove(slug); return; }
    const result = store.autoPlace(slug);
    if (!result.ok) toast(result.reason, 'error');
  });

  $('#roster').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    card.click();
  });
}

export function resetFilters() {
  filters.query = '';
  filters.types.clear();
  filters.roles.clear();
  filters.tiers.clear();
  filters.hideBlocked = false;
  filters.sort = 'wiki';
  $('#search').value = '';
  $('#sort').value = 'wiki';
  $('#opt-hide-blocked').checked = false;
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', 'false');
}

function visible() {
  const list = state.all.filter((t) => {
    if (filters.types.size && !filters.types.has(t.type)) return false;
    if (filters.roles.size && !filters.roles.has(t.role)) return false;
    if (filters.tiers.size && !filters.tiers.has(t.tier)) return false;
    if (!matches(t, filters.query)) return false;
    if (filters.hideBlocked && store.blockedReason(t) && store.cellOf(t.slug) === null) return false;
    return true;
  });
  return filters.sort === 'wiki' ? list : list.sort(SORTS[filters.sort]);
}

export function renderRoster() {
  const list = visible();
  const host = $('#roster');

  host.innerHTML = list.map((t) => {
    const deployed = store.cellOf(t.slug) !== null;
    const blocked = deployed ? null : store.blockedReason(t);

    // A full grid blocks everything at once; dimming all 200+ cards for that
    // just makes the roster look broken. The 15/15 counter already says it, so
    // only a per-Tatari reason (a sibling of the same line) is marked here.
    const clash = deployed ? null : store.familyConflict(t);
    const lock = clash ? `${clash.name} in use` : '';

    return `
      <div class="card${deployed ? ' is-deployed' : ''}${clash ? ' is-blocked' : ''}"
           role="listitem" tabindex="0" data-slug="${esc(t.slug)}" data-type="${t.type}"
           title="${esc(t.name)} — ${t.type} ${t.role}, T${t.tier}${blocked ? `\n${blocked}` : ''}">
        <div class="card__art">
          ${artHTML(t)}
          <span class="card__tier">T${t.tier}</span>
          <span class="card__badges">${typeIcon(t.type)}${roleIcon(t.role)}</span>
        </div>
        <div class="card__name">${esc(t.name)}</div>
        ${lock ? `<span class="card__lock">${esc(lock)}</span>` : ''}
        <button class="card__info" type="button" tabindex="-1"
                aria-label="Details for ${esc(t.name)}">i</button>
      </div>`;
  }).join('');

  for (const card of host.children) {
    const slug = card.dataset.slug;
    draggable(
      card,
      () => {
        const t = state.bySlug.get(slug);
        if (!t) return null;
        if (store.cellOf(slug) === null && store.blockedReason(t)) return null;
        return { slug, from: 'roster' };
      },
      () => {
        const t = state.bySlug.get(slug);
        return `<span class="token" data-type="${t.type}">${artHTML(t, { lazy: false })}</span>`;
      }
    );
  }

  $('#roster-count').textContent = list.length === state.all.length
    ? `${state.all.length}`
    : `${list.length} of ${state.all.length}`;
}
