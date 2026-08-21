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
  /*
   * Zobos only. A plain boolean rather than a Set like the others, because there
   * is nothing to pick *between*: the roster is bosses and not-bosses, and the
   * chip asks for the first. Off means everything, the same as an empty Set.
   */
  boss: false,
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
        // By cell for a Zobo: unplace() finds the first cell holding that slug,
        // which for an enemy standing in several places is rarely the one you
        // dragged. Nothing is kept either — a Zobo has no bench to return to.
        if (payload.kind === 'zobo') {
          store.unplaceAt(payload.cell);
          toast(`${state.zoboBySlug.get(payload.slug)?.name ?? 'Zobo'} off the field`);
          return;
        }
        store.unplace(payload.slug, payload.player);
        toast(`${nameOf(payload.slug)}${who} off the field, still on the bench`);
      } else {
        store.removeFromBench(payload.slug, payload.player);
        toast(`Stopped bringing ${nameOf(payload.slug)}${who}`);
      }
    },
  });
}

/**
 * The drafter's own answer to a card being picked: bring it, or stop bringing
 * it.
 *
 * Injectable because the range recorder hosts this same roster, where a click
 * means "record this one" instead. The roster should not have to know which
 * page it is sitting on, and neither page should need its own copy of the
 * search, the filters or the cards.
 */
function bringToBench(slug) {
  const result = store.toggleBench(slug);
  if (!result.ok) toast(result.reason, 'error');
}

export function buildFilters(onChange, { onPick = bringToBench } = {}) {
  buildRosterDropZone();

  /*
   * The two lists share the search box and the element chips, because both
   * questions apply to both halves — "show me the Lightning ones" is as useful
   * against Zobos as for Tatari. Everything else in the filter block is about
   * drafting (role, tier, what a Tatari brings, whose bench is full) and has no
   * meaning for an enemy, so the body carries a flag and the CSS hides them
   * rather than each control learning about tabs.
   */
  const tabs = $('#roster-tabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.segmented__btn');
      if (!btn || btn.dataset.list === showing.value) return;
      showing.value = btn.dataset.list;
      for (const b of tabs.children) {
        b.setAttribute('aria-selected', String(b.dataset.list === showing.value));
      }
      document.body.dataset.rosterList = showing.value;
      onChange();
    });
    document.body.dataset.rosterList = showing.value;
  }

  /*
   * The boss chip. Twenty of the fifty are bosses, and they are the ones a
   * formation is actually built against — the star was worth adding to the card
   * and is worth being able to ask for.
   */
  const bossHost = $('#filter-boss');
  if (bossHost) {
    bossHost.innerHTML = `
      <button class="chip chip--boss" type="button" aria-pressed="false"
              title="Show only bosses">★<span>Bosses</span></button>`;
    bossHost.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      filters.boss = !filters.boss;
      chip.setAttribute('aria-pressed', String(filters.boss));
      onChange();
    });
  }

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
    (v) => `${EFFECTS.find((e) => e.key === v).label}, from the base skill or a level-up`);

  /*
   * Debounced. Every keystroke rebuilds 218 cards and rebinds 218 drag handlers,
   * which on a phone -- three quarters of the traffic -- is felt as the search
   * box lagging behind the thumb. 120ms is under the ~150ms that reads as
   * instant, so nothing feels slower and the work happens once per word rather
   * than once per letter.
   */
  let queryTimer;
  $('#search').addEventListener('input', (e) => {
    filters.query = e.target.value;
    clearTimeout(queryTimer);
    queryTimer = setTimeout(onChange, 120);
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

  // Clicking does whatever the host page wants. Dragging is for putting it
  // somewhere specific on the field.
  $('#roster').addEventListener('click', (e) => {
    if (e.target.closest('.card__info')) {
      openDetail(e.target.closest('.card').dataset.slug);
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;

    /*
     * A tapped Zobo goes straight to the field, because there is nowhere else
     * for it to go: onPick brings a Tatari to the bench, and a Zobo has no
     * bench — which is why tapping one used to answer "Unknown Tatari" from
     * deep inside toggleBench().
     *
     * This is the only way onto the board for most phone users. Dragging a card
     * from the roster to the field is a gesture that barely exists on a screen
     * where the two are in separate sheets.
     */
    /*
     * Tapping a dimmed card switches the line to that tier rather than doing
     * nothing. Read off the card so the roster does not have to re-derive which
     * member of the line is the one being replaced.
     */
    const switchFrom = card.dataset.switchFrom;
    if (switchFrom) {
      const player = store.formation.activePlayer;
      const result = store.switchTier(switchFrom, card.dataset.slug, player);
      if (!result.ok) { toast(result.reason, 'error'); return; }
      const to = state.bySlug.get(card.dataset.slug);
      toast(`Switched to ${to?.name ?? card.dataset.slug}${store.isCoop() ? ` (P${player})` : ''}`);
      return;
    }

    if (card.classList.contains('card--zobo')) {
      const z = state.zoboBySlug.get(card.dataset.slug);
      if (!z) return;
      const cell = store.firstFreeZoboCell();
      if (cell === null) { toast('No empty tile for it', 'error'); return; }
      const result = store.place(z.slug, cell);
      if (!result.ok) { toast(result.reason, 'error'); return; }
      toast(`${z.name} on the field`);
      return;
    }

    onPick(card.dataset.slug);
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

/**
 * Which of the two lists the roster is showing.
 *
 * Not persisted and not in the formation: it is a view of the panel, like the
 * search box, and a share link that silently reopened somebody on the Zobo tab
 * would be answering a question they did not ask.
 */
export const showing = { value: 'tatari' };

/**
 * The Zobo list.
 *
 * Drawn from the same card markup deliberately — same size, same drag, same
 * search — because the field takes both and a second visual language for the
 * half you are placing against would make the board harder to read, not easier.
 * What the card drops is everything a Zobo has no answer for: tier, role,
 * bench state, evolution clash and the effect marks. What it gains is the boss
 * star, which is the one thing that changes how you draft against one.
 */
function renderZobos() {
  const host = $('#roster');
  const q = filters.query;
  const list = state.zobos.filter((z) => {
    if (filters.boss && !z.boss) return false;
    if (filters.types.size && !filters.types.has(z.type)) return false;
    return !q || z._search.includes(q.toLowerCase());
  });

  host.innerHTML = list.map((z) => `
      <div class="card card--zobo" role="listitem" tabindex="0"
           data-slug="${esc(z.slug)}"${z.type ? ` data-type="${z.type}"` : ''}
           title="${esc(z.name)}${z.type ? ` — ${z.type}` : ''}${z.boss ? ' — Boss' : ''}${
  z.skill?.name ? `
${esc(z.skill.name)}` : ''}">
        <div class="card__art">${artHTML(z, { priority: 'low' })}</div>
        <div class="card__meta">
          ${z.boss ? '<span class="card__boss" title="Boss">★</span>' : ''}
          ${z.type ? typeIcon(z.type) : ''}
        </div>
        <div class="card__name">${esc(z.name)}</div>
      </div>`).join('');

  for (const card of host.children) {
    const slug = card.dataset.slug;
    draggable(
      card,
      () => ({ slug, player: 0, from: 'roster', kind: 'zobo' }),
      () => {
        const z = state.zoboBySlug.get(slug);
        return `<span class="token token--zobo"${z.type ? ` data-type="${z.type}"` : ''}>${
          artHTML(z, { lazy: false })}</span>`;
      }
    );
  }

  $('#roster-count').textContent = list.length === state.zobos.length
    ? `${state.zobos.length}`
    : `${list.length} of ${state.zobos.length}`;
}

export function renderRoster() {
  if (showing.value === 'zobos') { renderZobos(); return; }
  const player = store.formation.activePlayer;
  const list = visible(player);
  const host = $('#roster');
  host.dataset.player = String(player);

  host.innerHTML = list.map((t) => {
    const benched = store.onBench(t.slug, player);
    const placed = benched && store.isPlaced(t.slug, player);

    // A full bench blocks everything at once; dimming all 200+ cards for that
    // just makes the roster look broken. Only a per-Tatari reason is marked.
    // Sandbox brings a whole line at once, so a sibling tier is a normal pick
    // there, not a swap. Everywhere else it stays a switch — see card--swap.
    const clash = (benched || store.isSandbox()) ? null : store.familyConflict(t, player);
    const otherPlayer = store.isCoop()
      ? store.players().filter((p) => p !== player && store.onBench(t.slug, p))
      : [];

    const state_ = placed ? 'on the field' : benched ? 'on the bench' : null;
    /*
     * Another tier of a line you already bring is a switch, not a wall.
     *
     * It used to be flatly blocked, which was true to the rule — one per line —
     * and wrong about what people wanted: the only way to change your mind about
     * a tier was to remove the one you had, which threw away its cell and its
     * level-up plan, neither of which was ever about the tier. The card is
     * dimmed to say "you already have one of these" and tapping it swaps them.
     */
    return `
      <div class="card${benched ? ' is-benched' : ''}${placed ? ' is-deployed' : ''}${
        clash ? ' is-swap' : ''}"
           role="listitem" tabindex="0" data-slug="${esc(t.slug)}" data-type="${t.type}"${
        clash ? ` data-switch-from="${esc(clash.slug)}"` : ''}
           title="${esc(t.name)} — ${t.type} ${t.role}, T${t.tier}${
             state_ ? `\n${state_}` : ''}${clash ? `\nTap to switch from ${clash.name}, keeping its plan` : ''}">
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
        ${clash ? `<span class="card__lock">Switch from ${esc(clash.name)}</span>` : ''}
        <!-- Focusable. It was tabindex="-1", which took the detail sheet — and
             with it "Place on the field" — off the keyboard entirely. The
             reveal already handles :focus-visible, so it appears when tabbed
             to exactly as it does on hover. -->
        <button class="card__info" type="button"
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
        // A card that would swap a tier is draggable: the drop resolves it.
        const swapFrom = store.isSandbox() ? null : (store.familyConflict(t, p)?.slug ?? null);
        if (!swapFrom && !store.onBench(slug, p) && store.placeBlockedReason(t, p)) return null;
        return { slug, player: p, from: 'roster', swapFrom };
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
