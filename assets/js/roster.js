/** The searchable, filterable roster you draft from. */

import { state, matches } from './data.js';
import * as store from './store.js';
import { TYPES, ROLES } from './icons.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';
import { openDetail } from './detail.js';
import { effectGroupsOf, bringsEffect } from './effects.js';

const TIERS = [1, 2, 3, 4];

/** The three effect groups, as filter chips and as markers on each card. */
const EFFECTS = [
  { key: 'heal', glyph: '+', label: 'Heals' },
  { key: 'buff', glyph: '▲', label: 'Buffs' },
  { key: 'debuff', glyph: '▼', label: 'Debuffs' },
];

export const filters = {
  query: '',
  types: new Set(),
  roles: new Set(),
  tiers: new Set(),
  effects: new Set(),
  hideBlocked: false,
  sort: 'default',
};

// 'default' is the wiki's own order, which runs family by family - the most
// useful reading order there is, so it sorts by not sorting.
const SORTS = {
  default: () => 0,
  name: (a, b) => a.name.localeCompare(b.name),
  type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  role: (a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name),
  tier: (a, b) => a.tier - b.tier || a.name.localeCompare(b.name),
};

/**
 * The roster is where a Tatari came from, so dragging one back to it puts it
 * back: off the field if it was on the field, off the bench entirely if it was
 * waiting on the bench.
 */
function buildRosterDropZone() {
  const nameOf = (slug) => state.bySlug.get(slug)?.name ?? slug;

  dropZone({
    selector: '.panel--roster',
    accepts: (target, payload) =>
      (payload.from === 'field' || payload.from === 'bench') && !!payload.slug,
    onHover: (target, ok) => target.classList.toggle('is-returning', ok),
    onDrop: (target, payload) => {
      const who = store.isCoop() ? ` (P${payload.player})` : '';
      if (payload.from === 'field') {
        store.unplace(payload.slug, payload.player);
        toast(`${nameOf(payload.slug)}${who} off the field — still on the bench`);
      } else {
        store.removeFromBench(payload.slug, payload.player);
        toast(`Stopped bringing ${nameOf(payload.slug)}${who}`);
      }
    },
  });
}

export function buildFilters(onChange) {
  buildRosterDropZone();

  const chips = (host, values, set, kind, label) => {
    host.innerHTML = values.map((v) => `
      <button class="chip chip--${kind}" type="button" data-value="${esc(v)}"
              data-type="${kind === 'type' ? esc(v) : ''}"
              aria-pressed="false" title="${esc(label(v))}">
        ${kind === 'type' ? typeIcon(v, { badge: false })
          : kind === 'role' ? roleIcon(v, { badge: false })
            : kind === 'effect'
              ? `${EFFECTS.find((e) => e.key === v).glyph}<span>${
                EFFECTS.find((e) => e.key === v).label}</span>`
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
  chips($('#filter-effects'), EFFECTS.map((e) => e.key), filters.effects, 'effect',
    (v) => `${EFFECTS.find((e) => e.key === v).label} — from the base skill or a level-up`);

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

  // Clicking toggles whether the active player brings this Tatari. Dragging is
  // for putting it somewhere specific on the field.
  $('#roster').addEventListener('click', (e) => {
    if (e.target.closest('.card__info')) {
      openDetail(e.target.closest('.card').dataset.slug);
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const result = store.toggleBench(card.dataset.slug);
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

/**
 * The heal / buff / debuff markers on a card.
 *
 * A solid mark is something the Tatari has from the start. A hollow one with a
 * level number only arrives once you have levelled it that far, and a solid one
 * carrying a level number means it has the effect already and gains more later.
 * That distinction is the whole reason these are here rather than a plain dot:
 * "brings a heal" and "could bring a heal at 5" are different picks.
 */
function effectMarks(t) {
  const groups = effectGroupsOf(t);
  const marks = EFFECTS.map(({ key, glyph, label }) => {
    const g = groups[key];
    if (!g.base && g.level === null) return '';
    const title = g.base
      ? `${label} from the start${g.level !== null ? `, and more at level ${g.level}` : ''}`
      : `${label} only once levelled to ${g.level}`;
    return `<span class="card__fx" data-fx="${key}" data-base="${g.base}" title="${esc(title)}"
      >${glyph}${g.level !== null ? `<b>${g.level}</b>` : ''}</span>`;
  }).filter(Boolean).join('');
  return marks ? `<span class="card__fxrow">${marks}</span>` : '';
}

export function resetFilters() {
  filters.query = '';
  filters.types.clear();
  filters.roles.clear();
  filters.tiers.clear();
  filters.effects.clear();
  filters.hideBlocked = false;
  filters.sort = 'default';
  $('#search').value = '';
  $('#sort').value = 'default';
  $('#opt-hide-blocked').checked = false;
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', 'false');
}

function visible(player) {
  const list = state.all.filter((t) => {
    if (filters.types.size && !filters.types.has(t.type)) return false;
    if (filters.roles.size && !filters.roles.has(t.role)) return false;
    if (filters.tiers.size && !filters.tiers.has(t.tier)) return false;
    // Every chosen effect, not any: picking Heals and Buffs together asks for
    // one Tatari that does both, which is the question worth asking of a
    // 15-slot bench. The type and role chips still read as "any".
    if (filters.effects.size
      && ![...filters.effects].every((group) => bringsEffect(t, group))) return false;
    if (!matches(t, filters.query)) return false;
    // Only a per-Tatari reason hides a card. A full bench blocks every Tatari
    // at once, and collapsing the roster to the 15 already brought reads as the
    // filter being broken - the same call the card dimming makes below.
    if (filters.hideBlocked && store.familyConflict(t, player)) return false;
    return true;
  });
  return filters.sort === 'default' ? list : list.sort(SORTS[filters.sort]);
}

export function renderRoster() {
  const player = store.formation.activePlayer;
  const list = visible(player);
  const host = $('#roster');
  host.dataset.player = String(player);

  host.innerHTML = list.map((t) => {
    const benched = store.onBench(t.slug, player);
    const placed = benched && store.isPlaced(t.slug, player);

    // A full bench blocks everything at once; dimming all 200+ cards for that
    // just makes the roster look broken. Only a per-Tatari reason is marked.
    const clash = benched ? null : store.familyConflict(t, player);
    const otherPlayer = store.isCoop()
      ? store.players().filter((p) => p !== player && store.onBench(t.slug, p))
      : [];

    const state_ = placed ? 'on the field' : benched ? 'on the bench' : null;
    return `
      <div class="card${benched ? ' is-benched' : ''}${placed ? ' is-deployed' : ''}${
        clash ? ' is-blocked' : ''}"
           role="listitem" tabindex="0" data-slug="${esc(t.slug)}" data-type="${t.type}"
           title="${esc(t.name)} — ${t.type} ${t.role}, T${t.tier}${
             state_ ? `\n${state_}` : ''}${clash ? `\n${clash.name} from the same line is brought` : ''}">
        <!-- Last in the queue: 218 thumbnails will otherwise crowd out the
             dozen sprites the field and the benches are showing right now. -->
        <div class="card__art">${artHTML(t, { priority: 'low' })}${effectMarks(t)}</div>
        <div class="card__meta">
          <span class="card__tier">T${t.tier}</span>
          ${typeIcon(t.type)}${roleIcon(t.role)}
          ${otherPlayer.length
            ? `<span class="card__other" data-player="${otherPlayer[0]}"
                     title="P${otherPlayer[0]} is bringing this too">P${otherPlayer[0]}</span>` : ''}
        </div>
        <div class="card__name">${esc(t.name)}</div>
        ${clash ? `<span class="card__lock">${esc(clash.name)} in use</span>` : ''}
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
        const p = store.formation.activePlayer;
        if (!store.onBench(slug, p) && store.placeBlockedReason(t, p)) return null;
        return { slug, player: p, from: 'roster' };
      },
      () => {
        const t = state.bySlug.get(slug);
        return `<span class="token" data-type="${t.type}" data-player="${
          store.formation.activePlayer}">${artHTML(t, { lazy: false })}</span>`;
      }
    );
  }

  $('#roster-count').textContent = list.length === state.all.length
    ? `${state.all.length}`
    : `${list.length} of ${state.all.length}`;
}
