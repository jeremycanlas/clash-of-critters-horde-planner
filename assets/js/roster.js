/** The searchable, filterable roster you draft from. */

import { state, matches } from './data.js';
import {
  boardFor, chipList, iconFor, keptBy, placeAt, scoreOne, toggleKept,
} from './chips.js';
import * as store from './store.js';
import { TYPES, ROLES } from './icons.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';
import { openDetail } from './detail.js';
import { measureDock } from './shell.js';
import {
  effectGroupsOf, effectsOf, helpFor, GROUP_LABELS,
  bringsTypeBy, bringsEffectBy, groupOf,
} from './effects.js';

const TIERS = [1, 2, 3, 4];

/** The three effect groups, as filter chips and as markers on each card. */
const EFFECTS = [
  { key: 'heal', glyph: '+', label: 'Heals' },
  { key: 'buff', glyph: '▲', label: 'Buffs' },
  { key: 'debuff', glyph: '▼', label: 'Debuffs' },
];

/*
 * What the last game update did, and why it cannot borrow the glyphs above.
 *
 * ▲ and ▼ are already spoken for on these cards: they mean this Tatari applies
 * buffs, this one applies debuffs, and they carry the horde level the effect
 * arrives at. Reusing them for "was buffed by the patch" would make every card
 * ambiguous -- a red ▼ would mean two unrelated things at once.
 *
 * So this marker differs on every axis available: line arrows rather than solid
 * triangles, a filled disc rather than an outlined rounded rect, the row under
 * the sprite rather than the corner of it, and never a number beside it.
 *
 * ± for adjusted, not a third arrow. "Some numbers up, some down" is the actual
 * fact and any single arrow would misreport it -- but ↕ was the first attempt
 * and it is one stroke from ↑, which blurs at the 15px these are drawn at.
 * Plus-minus shares no silhouette with either direction, so the odd one out
 * looks odd immediately, and it is the notation that already means this. The
 * heal badge is a bare + and lives in the other corner as a rounded rect, so
 * the two do not read as a family.
 *
 * Under the sprite because the note above .card__meta already settled that
 * question for tier, type and role, having measured that no corner of the art is
 * reliably empty across the roster. The reason bites harder here than there:
 * these cards get screenshotted and posted, so a badge sitting on a Tatari's
 * face travels with it.
 */
const PATCH_MARKS = {
  buff: { glyph: '↑', label: 'Buffed' },
  nerf: { glyph: '↓', label: 'Nerfed' },
  adjusted: { glyph: '±', label: 'Adjusted' },
};

export const filters = {
  query: '',
  types: new Set(),
  roles: new Set(),
  tiers: new Set(),
  effects: new Set(),
  /*
   * The specific effects, alongside the groups rather than instead of them.
   * "Brings a debuff" and "brings Stun" are different questions and a player
   * asks both, so the two sets are ANDed together the same way two group chips
   * already are -- picking Debuffs and Stun asks for Stun, picking Stun and
   * Shield asks for a Tatari carrying both.
   */
  effectTypes: new Set(),
  /*
   * How far you are willing to level, per group rather than for the roster.
   *
   * One ceiling for everything was the wrong shape. What you are levelling to is
   * a fact about each Tatari you are choosing, not about the search: a free heal
   * is easy to come by and a Stun almost never is, so "a healer that heals from
   * the start, and something that stuns by 7" is a real question and one global
   * number could not ask it. Three independent budgets can, and each one only
   * governs the effects in its own group.
   *
   * Still a single value per group, not a Set: a budget is one number, and "by
   * 5" already contains everything "by 3" would find.
   */
  effectBy: { heal: null, buff: null, debuff: null },
  /*
   * Which direction of the last update to show: one of them, or null.
   *
   * One value rather than a Set, because the three are what a Tatari can be
   * rather than things it can carry. Nothing was both buffed and nerfed -- that
   * is the whole reason "adjusted" exists, as the name for a line whose numbers
   * moved both ways -- so the three describe one state each and asking for two
   * at once is not a question anybody has.
   *
   * Every other group here is a Set and intersects. This one is not either: it
   * is a single choice, and it behaves like the level ceiling beside it, down to
   * clearing when you press the one already on.
   */
  changed: null,
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
  /*
   * Tier, for the chips tab only.
   *
   * It cannot reuse #filter-tiers: that one means T1 to T4 of a Tatari, and a
   * chip's tier is a different axis with three values. Two filters that both
   * say "tier" and mean different things would be worse than a second row that
   * only appears when it applies.
   */
  const chipTierHost = $('#filter-chip-tiers');
  if (chipTierHost) {
    /* Only the listener here. The buttons themselves are drawn by renderChips,
       because their counts come from data/chips.json and that arrives after the
       filters are built -- drawn once at boot, all three read "0" forever. */
    chipTierHost.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip--rarity');
      if (!btn) return;
      const t = Number(btn.dataset.tier);
      chipTier = chipTier === t ? null : t;
      onChange();
    });
  }

  const chipGroupHost = $('#filter-chip-groups');
  if (chipGroupHost) {
    chipGroupHost.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip--group');
      if (!btn) return;
      const k = btn.dataset.shape;
      chipShape = chipShape === k ? null : k;
      onChange();
    });
  }

  const viewHost = $('#chip-view');
  if (viewHost) {
    const draw = () => {
      viewHost.innerHTML = [
        ['list', 'List', 'Every chip with what it does'],
        ['grid', 'Grid', 'Just the tiles, as the gallery shows them'],
      ].map(([key, label, why]) => `
        <button class="segmented__btn" type="button" role="tab" data-view="${key}"
          aria-selected="${chipView === key}" title="${esc(why)}"
          aria-label="${esc(`${label} view: ${why.toLowerCase()}`)}"
          >${key === 'list' ? viewIconList() : viewIconGrid()}<span>${label}</span></button>`).join('');
    };
    draw();
    viewHost.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn || btn.dataset.view === chipView) return;
      chipView = btn.dataset.view;
      try { localStorage.setItem(VIEW_KEY, chipView); } catch { /* private */ }
      draw();
      onChange();
    });
  }

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
  buildEffectTypes(onChange);
  buildChangedChips(onChange);

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
  /*
   * The filters fold away on a phone.
   *
   * They are 225px of a 700px sheet and the sheet exists to show the roster:
   * three card rows of 230 Tatari, with more screen spent describing the list
   * than showing it. Closed by default, and the button carries a count so a
   * filter is never quietly on behind it.
   */
  const foldToggle = $('#filters-toggle');
  if (foldToggle) {
    foldToggle.addEventListener('click', () => {
      const open = document.body.dataset.filters !== 'open';
      if (open) document.body.dataset.filters = 'open';
      else delete document.body.dataset.filters;
      foldToggle.setAttribute('aria-expanded', String(open));
    });
  }

  $('#btn-reset-filters').addEventListener('click', () => {
    resetFilters();
    onChange();
  });

  // Clicking does whatever the host page wants. Dragging is for putting it
  // somewhere specific on the field.
  $('#roster').addEventListener('click', (e) => {
    /* A chip card is a different kind of card in the same grid, so it is
       answered before anything that assumes a slug. */
    const chipCard = e.target.closest('.card--chip');
    if (chipCard) {
      toggleKept(store.formation.activePlayer, chipCard.dataset.chip);
      onChange();
      return;
    }

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
 * What the last game update did, as three chips.
 *
 * No caret and no disclosure, unlike the effect groups: a Tatari has exactly one
 * direction, so there are only ever three of these and they fit standing up.
 * The glyphs are the card marker's, deliberately, so the chip you press and the
 * disc you then see on 46 cards are obviously the same statement.
 *
 * Absent entirely between patches. data/changes.json with an empty `lines` is a
 * coherent state -- it is how a fork that does not track updates behaves -- and
 * three chips that find nothing would be worse than no chips at all.
 */
function buildChangedChips(onChange) {
  const host = $('#filter-changed');
  if (!host || !state.changes.size) return;

  /*
   * Counted as Tatari, not as the evolution lines the file is written in, and
   * counted against whatever else is filtered rather than against the whole
   * roster. Press T2 and Water and these say how many of *those* the update
   * touched, the same way "Roster 22 of 230" says how many are left.
   *
   * The patch filter itself is left out of its own count -- see passes(). With
   * it applied, choosing Nerfed would leave Buffed reading 0, which is true and
   * tells you nothing about what pressing it would do.
   */
  const countFor = (dir) =>
    countIf('changed', (t) => state.changes.get(t.slug)?.direction === dir);

  // Which chips exist at all is decided once, from the unfiltered file: a chip
  // that vanished when its count hit zero would move the two beside it under
  // the pointer.
  const present = { buff: 0, nerf: 0, adjusted: 0 };
  for (const { direction } of state.changes.values()) present[direction] += 1;

  const label = state.patch?.label ? ` in the ${state.patch.label} update` : ' in the last update';
  const shown = Object.entries(PATCH_MARKS).filter(([key]) => present[key]);

  const draw = () => {
    const seeAll = `<a class="chips__seeall" href="changes.html"
      title="${esc(`Every line the ${state.patch?.label ?? 'last'} update moved, `
        + 'with the old and new numbers side by side')}"
      >See all<span aria-hidden="true"> ↗</span></a>`;

  host.innerHTML = `<span class="chips__label" aria-hidden="true">Patch</span>`
      + shown.map(([key, { glyph, label: word }], i) => `
        <button class="chip chip--changed" type="button" role="radio" data-changed="${key}"
          aria-checked="${filters.changed === key}" title="${esc(`${word}${label}`)}"
          tabindex="${filters.changed === key || (filters.changed === null && i === 0) ? 0 : -1}"
          ><span class="chip__glyph" data-patch="${key}" data-glyph="${glyph}" aria-hidden="true"></span>${
          word}<b>${countFor(key)}</b></button>`).join('')
      + seeAll;
  };

  host.hidden = false;
  /*
   * A radio group, not three toggles. The three are what a Tatari can be rather
   * than things it can carry, and nothing was both buffed and nerfed -- that is
   * what "adjusted" is for. Same contract as the level ceiling beside it, down
   * to the roving tabindex and clearing when you press the one already on.
   */
  host.setAttribute('role', 'radiogroup');
  host.setAttribute('aria-label',
    `Filter by what changed${label}. Pick the one already chosen to clear it.`);
  draw();

  const choose = (key) => {
    filters.changed = filters.changed === key ? null : key;
    draw();
    host.querySelector(`.chip--changed[data-changed="${key}"]`)?.focus();
    onChange();
  };

  host.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip--changed');
    if (chip) choose(chip.dataset.changed);
  });

  host.addEventListener('keydown', (e) => {
    const chip = e.target.closest('.chip--changed');
    if (!chip) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const all = [...host.querySelectorAll('.chip--changed')];
    choose(all[(all.indexOf(chip) + step + all.length) % all.length].dataset.changed);
  });

  countUpdaters.push(() => {
    for (const chip of host.querySelectorAll('.chip--changed')) {
      const n = countFor(chip.dataset.changed);
      chip.querySelector('b').textContent = String(n);
      chip.toggleAttribute('data-empty', n === 0);
    }
  });
}

/**
 * The caret on each effect group, and the row of specific effects it opens.
 *
 * Three chips answer "brings a debuff", which is the question you ask while
 * filling a bench. They cannot answer "brings Stun", which is the question you
 * ask after a wave has killed you twice and you have worked out why -- and the
 * data has carried the answer all along: 23 named effects across heals, buffs
 * and debuffs, counting what a Tatari starts with and what it gains by
 * levelling.
 *
 * All 23 standing up would double the filter block, on a phone, above a roster
 * that wants the room. So they arrive one group at a time, behind a caret. Not a
 * menu: the caret is visible, sits on the chip it belongs to, and what it opens
 * appears in place rather than floating over anything.
 *
 * The chips are built from a tally of the roster rather than from a list of
 * known tags, which is what keeps this honest as the game changes. A tag nothing
 * carries never becomes a chip that finds nothing, a new one appears the first
 * time a Tatari has it, and each chip can say how many it will find before you
 * spend a tap on it.
 */
/*
 * Set by buildEffectTypes so resetFilters can reach it. The counts on those
 * chips are computed under the current budget, so clearing the budget without
 * redrawing leaves the row quietly lying about how many of each there are.
 */
let redrawEffectTypes = () => {};

/*
 * The chips' counts, refreshed in place after every render.
 *
 * In place rather than by redrawing: the rows are full of focusable chips, and
 * rebuilding their markup on each keystroke in the search box would throw the
 * keyboard out of whatever it was on. Only the number and the dimmed state
 * change, so only those are written.
 */
const countUpdaters = [];
export function refreshChipCounts() {
  for (const update of countUpdaters) update();
}

function buildEffectTypes(onChange) {
  const host = $('#filter-effects');
  const sub = $('#filter-effect-types');
  if (!host || !sub) return;

  const tallies = effectsOf(state.all);
  let open = null;

  for (const { key } of EFFECTS) {
    if (!tallies[key]?.length) continue;
    const chip = host.querySelector(`.chip[data-value="${key}"]`);
    if (!chip) continue;
    const caret = document.createElement('button');
    caret.type = 'button';
    // Deliberately not a .chip: the generic chip handler above reads
    // dataset.value off anything wearing that class, and resetFilters unpresses
    // it. A caret is neither a filter nor something reset should touch.
    caret.className = 'fxcaret';
    caret.dataset.group = key;
    caret.setAttribute('aria-expanded', 'false');
    caret.setAttribute('aria-controls', 'filter-effect-types');
    caret.setAttribute('aria-label', `Show the specific ${GROUP_LABELS[key].toLowerCase()}`);
    caret.title = `The specific ${GROUP_LABELS[key].toLowerCase()} a Tatari brings`;
    chip.after(caret);
  }

  /*
   * How far you are willing to level, as chips at the head of the row.
   *
   * They live here rather than in a row of their own because the question is
   * meaningless on its own screen -- "by 3" is only ever asked about something,
   * and the something is right next to it. 7 is offered even though it finds
   * everything a blank budget would: pressing it is how you say "I am taking
   * this all the way", and its absence would read as an oversight.
   */
  const BUDGETS = [
    { value: 0, label: 'Start', title: 'Only what a Tatari already does, unlevelled' },
    { value: 3, label: 'By 3', title: 'What it does if you level it to 3' },
    { value: 5, label: 'By 5', title: 'What it does if you level it to 5' },
    { value: 7, label: 'By 7', title: 'What it does if you level it all the way' },
  ];

  /*
   * Counted under the current budget rather than read off the tally, so the
   * numbers answer the question actually on screen. Pressing Start and watching
   * Stun fall from 55 to 12 is the fastest way to learn that most of this
   * roster's crowd control has to be paid for.
   */
  const countFor = (type) =>
    countIf('effectTypes', (t) => bringsTypeBy(t, type, filters.effectBy[groupOf(type)]));

  /* Which groups are carrying a ceiling, so a closed caret can say so. */
  const markCarets = () => {
    for (const c of host.querySelectorAll('.fxcaret')) {
      const by = filters.effectBy[c.dataset.group];
      c.toggleAttribute('data-budgeted', by !== null);
      const label = BUDGETS.find((b) => b.value === by)?.label;
      c.title = by === null
        ? `The specific ${GROUP_LABELS[c.dataset.group].toLowerCase()} a Tatari brings`
        : `${GROUP_LABELS[c.dataset.group]}: ${label.toLowerCase()}`;
    }
  };

  const draw = () => {
    sub.hidden = !open;
    if (!open) { sub.innerHTML = ''; return; }

    /*
     * radio, not toggle. These four are mutually exclusive, and aria-pressed
     * says the opposite -- a screen reader reading "Start, toggle button, not
     * pressed" gives no hint that picking one un-picks the others. role=radio
     * with aria-checked carries the choose-one relationship, and the group's
     * own label carries the escape hatch, since clicking the checked one clears
     * it and that is not a thing radios normally do.
     */
    /*
     * Roving tabindex, because role=radio is a promise about the keyboard.
     *
     * The first version set the role and left four ordinary tab stops behind,
     * which is worse than the aria-pressed it replaced: a screen reader hears
     * "radio group" and reaches for the arrow keys, and nothing happens. One
     * stop into the group, arrows between the options, exactly as a native
     * radio behaves. Nothing checked yet means the first one holds the stop, so
     * the group is always reachable.
     */
    const stop = filters.effectBy[open];
    const budgets = BUDGETS.map((b, i) => `
      <button class="chip chip--budget" type="button" role="radio" data-budget="${b.value}"
        aria-checked="${stop === b.value}" title="${esc(b.title)}"
        tabindex="${stop === b.value || (stop === null && i === 0) ? 0 : -1}"
        >${b.label}</button>`).join('');

    const types = tallies[open].map((t) => {
      /*
       * The wiki's own sentence, verbatim, or no tooltip at all.
       *
       * It used to be that sentence with a dash and a tally welded on, which
       * repeated the number already printed on the chip and turned somebody
       * else's clean definition into a fragment. Now the description is either
       * the whole tooltip or there is no tooltip.
       *
       * Nothing invented for the tags the wiki has not written up yet -- 4 of
       * the 10 buffs and 6 of the 11 debuffs have a definition, and guessing at
       * the rest would be worse than silence. Paralyze is the proof: it reads
       * like a plain stun and is actually Lightning damage over time that
       * delays movement.
       *
       * Heals get none either way. "Heal" explains itself, and a tooltip that
       * says a heal heals is noise on a chip you are trying to read past.
       */
      const help = open === 'heal' ? null : helpFor(t.type);
      const count = countFor(t.type);
      return `<button class="chip chip--fxtype" type="button" data-type="${esc(t.type)}"
        aria-pressed="${filters.effectTypes.has(t.type)}" ${count ? '' : 'data-empty="true"'}
        ${help ? `title="${esc(help)}"` : ''}
        >${esc(t.type)}<b>${count}</b></button>`;
    }).join('');

    const group = GROUP_LABELS[open].toLowerCase();
    sub.setAttribute('aria-label', `Specific ${group}`);
    sub.innerHTML = `
      <span class="chips__group" role="radiogroup"
            aria-label="How far you will level, for ${esc(group)}. Pick the one already chosen to clear it.">
        <span class="chips__label" aria-hidden="true">Needs</span>${budgets}
      </span>
      <span class="chips__split" aria-hidden="true"></span>
      <span class="chips__group" role="group" aria-label="Which ${esc(group)}">${types}</span>`;
  };

  redrawEffectTypes = () => { draw(); markCarets(); };
  markCarets();

  countUpdaters.push(() => {
    for (const chip of sub.querySelectorAll('.chip--fxtype')) {
      const n = countFor(chip.dataset.type);
      chip.querySelector('b').textContent = String(n);
      chip.toggleAttribute('data-empty', n === 0);
    }
  });

  host.addEventListener('click', (e) => {
    const caret = e.target.closest('.fxcaret');
    if (!caret) return;
    open = open === caret.dataset.group ? null : caret.dataset.group;
    for (const c of host.querySelectorAll('.fxcaret')) {
      c.setAttribute('aria-expanded', String(c.dataset.group === open));
    }
    draw();
    markCarets();

    /*
     * Focus follows the disclosure, because the DOM cannot.
     *
     * The opened row is a sibling after the whole filter row, so tabbing on
     * from the caret walks T1, T2, T3, T4 before it reaches the thing the caret
     * just revealed. aria-controls says the two are related and no browser or
     * screen reader is obliged to act on it. Moving the row into the flex line
     * would fix the order and wrap the tiers onto a third line to do it, so the
     * focus moves instead: into the row on open, back to the caret on close,
     * which is the pattern every other disclosure in the world uses.
     */
    if (open) sub.querySelector('.chip')?.focus();
    else caret.focus();
  });

  /* Arrows move and choose, the way a radio does. Wrapping, because four chips
     in a row have no meaningful ends to stop at. */
  sub.addEventListener('keydown', (e) => {
    const radio = e.target.closest('.chip--budget');
    if (!radio) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const all = [...sub.querySelectorAll('.chip--budget')];
    const next = all[(all.indexOf(radio) + step + all.length) % all.length];
    next.click();                       // choosing is what an arrow does here
    sub.querySelector(`.chip--budget[data-budget="${next.dataset.budget}"]`)?.focus();
  });

  sub.addEventListener('click', (e) => {
    const budget = e.target.closest('.chip--budget');
    if (budget) {
      const value = Number(budget.dataset.budget);
      // Pressing the one already on clears it, so there is a way back to "any
      // level" without a fifth chip that only ever means "never mind".
      filters.effectBy[open] = filters.effectBy[open] === value ? null : value;
      draw();
      markCarets();
      // draw() replaced the node under the pointer, so put focus back on the
      // equivalent chip rather than dropping it to the body mid-interaction.
      sub.querySelector(`.chip--budget[data-budget="${value}"]`)?.focus();
      onChange();
      return;
    }
    const chip = e.target.closest('.chip--fxtype');
    if (!chip) return;
    const { type } = chip.dataset;
    if (filters.effectTypes.has(type)) filters.effectTypes.delete(type);
    else filters.effectTypes.add(type);
    chip.setAttribute('aria-pressed', String(filters.effectTypes.has(type)));
    onChange();
  });
}

/**
 * The heal / buff / debuff markers on a card, in a band across the top of the
 * art box with the sprite sized to sit below them.
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
  /*
   * The wrapper goes out even with nothing in it: it is the art box's first grid
   * row, so an absent one would hand its height to the sprite and leave the 34
   * Tatari with no effects wearing artwork a size larger than everyone else.
   */
  return `<span class="card__fxrow">${marks}</span>`;
}

/**
 * The patch marker, if the last update touched this Tatari's line.
 *
 * The tooltip carries the actual numbers rather than just the direction, since
 * "nerfed" on its own tells a player nothing they can act on -- whether Dewgrub
 * lost a tenth or three quarters of its damage is the entire question. Absent
 * for anything the update did not touch, which is most of the roster.
 */
function patchMark(t) {
  const change = state.changes.get(t.slug);
  if (!change) return '';
  const { glyph, label } = PATCH_MARKS[change.direction] ?? {};
  if (!glyph) return '';
  const title = [`${label} in the ${state.patch?.label ?? 'latest'} update`, ...change.changes].join('\n');
  return `<span class="card__patch" data-patch="${change.direction}" data-glyph="${glyph}"
    title="${esc(title)}" aria-label="${esc(label)} in the latest update"></span>`;
}

/**
 * How many questions you have asked, for the folded button to admit to.
 *
 * Counted rather than tracked as a flag: a count that says "3" is the
 * difference between "I forgot a filter is on" and "I know exactly how much is
 * hiding behind this button".
 */
export function activeFilterCount() {
  let n = filters.types.size + filters.roles.size + filters.tiers.size
    + filters.effects.size + filters.effectTypes.size;
  if (filters.changed) n += 1;
  if (filters.boss) n += 1;
  if (filters.hideBlocked) n += 1;
  if (filters.sort !== 'default') n += 1;
  for (const g of Object.keys(filters.effectBy)) if (filters.effectBy[g] !== null) n += 1;
  if (chipTier !== null) n += 1;
  if (chipShape !== null) n += 1;
  return n;
}

export function resetFilters() {
  filters.query = '';
  filters.types.clear();
  filters.roles.clear();
  filters.tiers.clear();
  filters.effects.clear();
  filters.effectTypes.clear();
  filters.changed = null;
  for (const g of Object.keys(filters.effectBy)) filters.effectBy[g] = null;
  filters.hideBlocked = false;
  filters.sort = 'default';
  /*
   * The chips tab's two filters, which Reset used to leave exactly where they
   * were -- and worse than untouched: the loop below unpresses every .chip on
   * the page, so the buttons went pale while the filter stayed on, and the next
   * redraw put them back. Pressing Reset appeared to do nothing because, on this
   * tab, it did nothing.
   */
  chipTier = null;
  chipShape = null;
  $('#search').value = '';
  $('#sort').value = 'default';
  $('#opt-hide-blocked').checked = false;
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', 'false');
  redrawEffectTypes();
}

/**
 * Whether one Tatari survives the filters, optionally with one of them ignored.
 *
 * `skip` is what makes the counts on the chips mean anything. A chip has to say
 * how many it would find if you pressed it, which is the roster narrowed by
 * every *other* filter but not by its own group -- count Nerfed with the patch
 * filter still applied and it reads 46 while Buffed reads 0, which is true and
 * useless. Leave its own group out and the three read 12, 6 and 0 against the
 * T2 Water you already picked, which is the number you wanted.
 */
function passes(t, player, skip) {
  if (filters.types.size && !filters.types.has(t.type)) return false;
  if (filters.roles.size && !filters.roles.has(t.role)) return false;
  if (filters.tiers.size && !filters.tiers.has(t.tier)) return false;
  if (skip !== 'changed' && filters.changed !== null
    && state.changes.get(t.slug)?.direction !== filters.changed) return false;

  // Every chosen effect, not any: picking Heals and Buffs together asks for one
  // Tatari that does both, which is the question worth asking of a 15-slot
  // bench. The type and role chips still read as "any". Each group answers under
  // its own ceiling, not whichever was set last.
  for (const group of ['heal', 'buff', 'debuff']) {
    const by = filters.effectBy[group];
    const named = skip === 'effectTypes' ? []
      : [...filters.effectTypes].filter((x) => groupOf(x) === group);
    // A budget with nothing picked under it still asks something worth asking:
    // "anything from this group by then". Once a type is named, that is the more
    // specific question and it wins.
    if ((filters.effects.has(group) || (by !== null && !named.length))
      && !bringsEffectBy(t, group, by)) return false;
    for (const type of named) if (!bringsTypeBy(t, type, by)) return false;
  }
  if (!matches(t, filters.query)) return false;
  // Only a per-Tatari reason hides a card. A full bench blocks every Tatari at
  // once, and collapsing the roster to the 15 already brought reads as the
  // filter being broken - the same call the card dimming makes below.
  if (filters.hideBlocked && store.familyConflict(t, player)) return false;
  return true;
}

/** How many Tatari a chip would find, counted against everything else you set. */
function countIf(skip, test) {
  const player = store.formation.activePlayer;
  let n = 0;
  for (const t of state.all) if (passes(t, player, skip) && test(t)) n += 1;
  return n;
}

function visible(player) {
  const list = state.all.filter((t) => passes(t, player, null));
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
           title="${esc(z.name)}${z.type ? `, ${z.type}` : ''}${z.boss ? ', Boss' : ''}${
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

/*
 * The chips, as a third list in the roster.
 *
 * They belong here for the same reason Zobos do: the roster is the list of
 * things you pick from, and a chip is a thing you pick. It also inherits the
 * search box and the card grid, which a panel of its own had to grow copies of.
 *
 * The card says the two things a card can say at 79px: which chip, and what it
 * would be worth to the board you have built. Which particular Tatari is in the
 * tooltip and on chips.html, both of which have the room for it.
 */
/*
 * One at a time, both rows.
 *
 * Multi-select was the wrong default here. "Tier II or III" reads like a real
 * question but the answer is 35 of 49, which is not a filter; and two rows
 * sitting next to each other behaving differently is worse than either
 * behaviour on its own. Pressing the one already on releases it, the same as
 * the Patch chips on the Tatari tab.
 */
let chipTier = null;
let chipShape = null;

/* The same names the page uses for its headings, minus the word "Chips" --
   printed on a chip, on a page of chips, it is the only word on the label that
   says nothing. */
const PER = 3;

/*
 * Grid or list, remembered.
 *
 * They answer different questions. The grid is for somebody who already knows
 * the chips and is looking for one by its face; the list is for somebody
 * deciding, who needs the rule. Neither is the beginner view and neither is the
 * advanced one, so the choice is kept rather than reset every visit.
 */
const VIEW_KEY = 'coc.chips.view';
let chipView = 'list';
try { chipView = localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { /* private */ }

const CHIP_GROUPS = {
  placement: 'Position',
  element: 'Element',
  level: 'Level up',
  economy: 'Energizer',
  capacity: 'More Tatari',
  stat: 'Flat Buff',
  map: 'Map',
};

/* Drawn rather than lettered: at 12px a glyph says list-or-grid faster than the
   word does, and the word is beside it anyway for anyone the shape fails. */
const viewIconList = () => `
  <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
    <rect x="0" y="1" width="3" height="3" rx=".6" fill="currentColor"/>
    <rect x="4.5" y="2" width="7.5" height="1.2" rx=".6" fill="currentColor"/>
    <rect x="0" y="7" width="3" height="3" rx=".6" fill="currentColor"/>
    <rect x="4.5" y="8" width="7.5" height="1.2" rx=".6" fill="currentColor"/>
  </svg>`;

const viewIconGrid = () => `
  <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
    <rect x="0" y="0" width="5" height="5" rx=".8" fill="currentColor"/>
    <rect x="7" y="0" width="5" height="5" rx=".8" fill="currentColor"/>
    <rect x="0" y="7" width="5" height="5" rx=".8" fill="currentColor"/>
    <rect x="7" y="7" width="5" height="5" rx=".8" fill="currentColor"/>
  </svg>`;

function drawChipTiers() {
  const host = $('#filter-chip-tiers');
  if (host) {
    host.innerHTML = `<span class="chips__label" aria-hidden="true">Tier</span>`
      + [1, 2, 3].map((t) => `
        <button class="chip chip--rarity" type="button" data-tier="${t}"
          aria-pressed="${chipTier === t}"
          title="${esc(`Show only tier ${'I'.repeat(t)} chips`)}"
          ><span class="chip__tier" data-tier="${t}" aria-hidden="true">${'I'.repeat(t)}</span
          >${chipList().filter((c) => c.tier === t).length}</button>`).join('');
  }

  /* Every category on a chip is also a category you can ask for. Nothing on a
     card in this app is decoration only. */
  const cats = $('#filter-chip-groups');
  if (!cats) return;
  cats.innerHTML = `<span class="chips__label" aria-hidden="true">Type</span>`
    + Object.entries(CHIP_GROUPS)
      .filter(([key]) => chipList().some((c) => c.shape === key))
      .map(([key, label]) => `
        <button class="chip chip--group" type="button" data-shape="${key}"
          aria-pressed="${chipShape === key}"
          title="${esc(`Show only ${label} chips`)}"
          >${esc(label)} <b>${chipList().filter((c) => c.shape === key).length}</b></button>`)
      .join('');
}

function renderChips() {
  drawChipTiers();
  const host = $('#roster');
  const q = filters.query.toLowerCase();
  const player = store.formation.activePlayer;
  const board = boardFor(player);
  const kept = keptBy(player);
  const mine = [...kept.main, ...kept.extra];

  /* The gallery's own order, which is not tier and not alphabetical and not
     anything this file could derive -- so it is copied into the data instead. */
  /*
   * What you keep rises to the top, then the gallery's own order.
   *
   * Forty-nine rows is a long scroll and the three you have chosen are the ones
   * you come back to; leaving them wherever the gallery put them means hunting
   * for your own picks. Within each half the game's order holds, so the list
   * still reads the way the gallery does.
   */
  const rank = (c) => {
    const i = kept.main.indexOf(c.name);
    if (i >= 0) return i;                       // your three, in your order
    if (kept.extra.includes(c.name)) return PER + kept.extra.indexOf(c.name);
    return 1e6 + (c.order ?? 0);
  };
  const list = chipList().slice().sort((a, b) => rank(a) - rank(b)).filter((c) => {
    if (chipTier !== null && c.tier !== chipTier) return false;
    if (chipShape !== null && c.shape !== chipShape) return false;
    return !q || `${c.name} ${c.text}`.toLowerCase().includes(q);
  });

  host.dataset.chipView = chipView;

  host.innerHTML = list.map((c) => {
    const score = board.length ? scoreOne(c, board) : null;
    const rank = kept.main.indexOf(c.name);
    const held = mine.includes(c.name);
    const badges = `
      <span class="chiptier" data-tier="${c.tier}"
        title="${esc(`Tier ${'I'.repeat(c.tier)}`)}">${'I'.repeat(c.tier)}</span>
      <span class="chiptype" data-shape="${c.shape}">${esc(CHIP_GROUPS[c.shape] ?? c.shape)}</span>`;

    /*
     * Faces, not a sentence. "3 of your 6 in your back 2 rows" made you go and
     * look at the board to find out which three; the sprites are the answer.
     * The count stays in front of them, since a capped row still has to say
     * when there are more.
     */
    const who = !score?.who?.length ? '' : `
      <p class="chipwho chipwho--row">
        <span class="chipwho__n">${score.n}</span>
        ${score.who.slice(0, 8).map((piece) => `
          <span class="chipwho__art" data-type="${esc(piece.type)}" title="${esc(piece.name)}"
            >${piece.t ? artHTML(piece.t, { priority: 'low' }) : esc(piece.name)}</span>`).join('')}
        ${score.who.length > 8 ? `<span class="chipwho__more">+${score.who.length - 8}</span>` : ''}
      </p>`;

    const empty = score && score.n === 0
      ? `<p class="chiprow__none">Nothing on your board qualifies</p>` : '';

    return `
      <div class="card card--chip${held ? ' is-benched' : ''}" role="listitem" tabindex="0"
           data-chip="${esc(c.name)}" data-tier="${c.tier}"
           title="${esc(`${c.name}
${c.text}`)}">
        <img class="chiprow__art" src="${esc(iconFor(c))}" alt="" loading="lazy" decoding="async">
        <div class="chiprow__body">
          <p class="chiprow__head"><b>${esc(c.name)}</b>${badges}</p>
          <p class="chiprow__text">${esc(c.text)}</p>
          ${who}${empty}
        </div>
        ${rank >= 0 ? `<span class="card__rank" title="${esc(`Your pick ${rank + 1}`)}">${rank + 1}</span>` : ''}
      </div>`;
  }).join('');

  /* Drag a chip straight from the roster into the dock, at the position you
     want it in rather than onto the end of whatever is there. */
  for (const card of host.children) bindChipDrag(card, card.dataset.chip);

  $('#roster-count').textContent = list.length === chipList().length
    ? `${list.length}`
    : `${list.length} of ${chipList().length}`;
}

/**
 * The chips you are bringing, docked under the bench.
 *
 * The bench answers "what am I bringing" for Tatari; this answers it for chips,
 * and it sits with the bench rather than in the roster so that one screenshot of
 * the field carries the board, the bench and the chips together. On a phone both
 * strips ride the same fixed shelf above the app bar for the same reason.
 *
 * Empty until something is kept: an always-visible row of three blank squares
 * would cost the field height on every formation, most of which never pick a
 * chip at all.
 */
/*
 * Dragging a chip into the dock, and dragging one within it.
 *
 * Clicking a chip already keeps it, and that is still the fast path. What
 * clicking cannot say is *where*: it appends, and the order of the three is the
 * whole point of the dock -- it is the order you take them in during a run. So
 * the drag exists for the thing the tap cannot express, which is the only good
 * reason to add a second way to do something.
 *
 * The dock reads left to right: the numbered three, a gap, then the shortlist.
 * A drop lands where it looks like it landed. Dropping onto a numbered chip
 * takes that number and pushes the rest along, which is the same rule the chips
 * page uses -- and when that pushes a fourth chip out of the three it drops into
 * the shortlist rather than being thrown away, because losing a pick you made
 * to a gesture you were still learning is the worst thing this could do.
 */
let chipZoneReady = false;
function readyChipZone() {
  if (chipZoneReady) return;
  chipZoneReady = true;
  dropZone({
    selector: '.chipbench__chip, .chipbench__slot, .chipbench__strip, .chiptray__zone',
    accepts: (target, payload) =>
      payload?.from === 'chip' && target.dataset.chip !== payload.name,
    onHover: (target, ok) => target.classList.toggle('is-over', ok),
    onDrop: (target, payload) => {
      const player = store.formation.activePlayer;
      const { main, extra } = keptBy(player);
      const onto = target.dataset.chip;

      if (onto) {
        /* A chip says exactly where: take its place. */
        const at = main.indexOf(onto);
        if (at >= 0) placeAt(player, payload.name, 'main', at);
        else placeAt(player, payload.name, 'extra', Math.max(0, extra.indexOf(onto)));
      } else if (target.dataset.list === 'extra') {
        placeAt(player, payload.name, 'extra', extra.length);
      } else {
        /* The strip itself, or the empty dock, says "in here somewhere", and
           the end of the three is where a new pick goes. placeAt spills into
           the shortlist by itself once the three are full. */
        placeAt(player, payload.name, 'main', main.length);
      }
      renderRoster();
    },
  });

  /*
   * And back out again: drop a kept chip anywhere on the list it came from and
   * it stops being kept.
   *
   * The way out has to be as obvious as the way in. Tapping the card toggles it
   * and always did, but somebody who learned "drag it in" will try "drag it
   * out" first, and a gesture that does nothing reads as a broken app rather
   * than as a gesture that was never offered.
   *
   * Only chips that are actually kept are accepted, so dragging a card around
   * the list it already lives in stays a no-op instead of a silent toggle.
   */
  dropZone({
    selector: '#roster',
    accepts: (target, payload) => {
      if (payload?.from !== 'chip') return false;
      const { main, extra } = keptBy(store.formation.activePlayer);
      return main.includes(payload.name) || extra.includes(payload.name);
    },
    onHover: (target, ok) => target.classList.toggle('is-dropping', ok),
    onDrop: (target, payload) => {
      toggleKept(store.formation.activePlayer, payload.name);
      renderRoster();
      toast(`${payload.name} dropped`);
    },
  });
}

/* The whole chip is the handle, the way a Tatari card already is.
 *
 * It was the sprite only, on the theory that a row which refuses to scroll under
 * a thumb is worse than a row that cannot be dragged. That is true, and it is
 * not what binding the whole card costs: a touch drag here waits out a short
 * hold and gives up the moment the finger travels, so a flick still scrolls the
 * list and a press still picks the chip up. Tatari cards have worked this way
 * the whole time. Grabbing a chip by its name and having nothing happen was the
 * bug -- the drop targets were fine, there was just no way to pick most of the
 * card up.
 *
 * `touch-action: none` stays on the sprite alone. That makes the sprite an
 * instant grip with no hold at all, the fast path once you know it is there,
 * while the rest of the card keeps its ability to scroll the list. */
function bindChipDrag(el, name) {
  if (el.dataset.dragBound) return;
  el.dataset.dragBound = '1';
  readyChipZone();
  const c = chipList().find((x) => x.name === name);
  draggable(
    el,
    () => ({ from: 'chip', name }),
    () => `<span class="chipghost">${c
      ? `<img src="${esc(iconFor(c))}" alt="">` : ''}${esc(name)}</span>`,
  );
}

/*
 * The chips' bench, inside the tab you pick them on.
 *
 * Two trays with a border round each, because they are two different promises:
 * the three you are taking, in the order you take them, and a shortlist of as
 * many as you like for whatever the run turns out to be. A border is doing real
 * work here -- it says where a chip can be dropped before you pick one up,
 * which a bare row of icons never did.
 *
 * The dock at the bottom of the app still exists and still shows the same three
 * chips. It is not a duplicate of this: it is what ends up in the screenshot,
 * next to the grid, and it is behind the roster sheet on a phone, which is why
 * it could never have been the place you edit.
 */
/*
 * The same reorder, from a keyboard.
 *
 * Dragging is the good way to say where a chip goes and for a while it was the
 * only way, which quietly made the order of your three something you needed a
 * pointer to set. Arrows move a chip one place; Delete drops it. Bound to the
 * container, which survives the re-render its own handler causes -- the chips
 * inside it do not.
 */
function bindChipKeys(host) {
  if (host.dataset.keysBound) return;
  host.dataset.keysBound = '1';
  host.addEventListener('keydown', (e) => {
    const el = e.target.closest?.('.chipbench__chip');
    if (!el) return;
    const name = el.dataset.chip;
    const p = store.formation.activePlayer;
    const lists = keptBy(p);
    const order = [...lists.main, ...lists.extra];
    const at = order.indexOf(name);
    if (at < 0) return;

    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (step) {
      const to = Math.max(0, Math.min(order.length - 1, at + step));
      if (to === at) return;
      e.preventDefault();
      placeAt(p, name, to < PER ? 'main' : 'extra', to < PER ? to : to - PER);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      toggleKept(p, name);
    } else {
      return;
    }
    renderRoster();
    /* Focus follows the chip, not the position. Moving something and then
       finding your focus on whatever slid into its place is how you move it
       twice by accident. */
    host.querySelector(`.chipbench__chip[data-chip="${CSS.escape(name)}"]`)?.focus();
  });
}

export function renderChipTray() {
  const host = $('#chiptray');
  if (!host) return;
  if (showing.value !== 'chips') { host.hidden = true; return; }
  host.hidden = false;

  const player = store.formation.activePlayer;
  const { main, extra } = keptBy(player);
  const byName = new Map(chipList().map((c) => [c.name, c]));

  const chip = (name, i) => {
    const c = byName.get(name);
    return `
      <span class="chipbench__chip" data-chip="${esc(name)}" tabindex="0" role="listitem"
        title="${esc(c ? `${name}: ${c.text}` : name)}"
        aria-label="${esc(i === null
          ? `${name}, shortlisted. Left and right arrows move it, Delete drops it.`
          : `${name}, pick ${i + 1} of ${PER}. Left and right arrows move it, Delete drops it.`)}">
        ${c ? `<img src="${esc(iconFor(c))}" alt="" loading="lazy" decoding="async">`
          : `<span class="chipbench__missing">?</span>`}
        ${i === null ? '' : `<span class="chipbench__n">${i + 1}</span>`}
      </span>`;
  };

  host.innerHTML = `
    <div class="chiptray__zone" data-list="main">
      <p class="chiptray__label">Your three</p>
      <div class="chiptray__row" role="list">
        ${main.map((n, i) => chip(n, i)).join('')}
        ${Array.from({ length: Math.max(0, PER - main.length) }, (_, i) => `
          <span class="chipbench__slot" data-list="main">${main.length + i + 1}</span>`).join('')}
      </div>
    </div>
    <div class="chiptray__zone chiptray__zone--extra" data-list="extra">
      <p class="chiptray__label">Shortlist</p>
      <div class="chiptray__row" role="list">
        ${extra.map((n) => chip(n, null)).join('')}
        ${extra.length ? '' : `<span class="chiptray__hint">Drop a chip here to keep it in mind</span>`}
      </div>
    </div>`;

  readyChipZone();
  for (const el of host.querySelectorAll('.chipbench__chip')) bindChipDrag(el, el.dataset.chip);
  bindChipKeys(host);
}

export function renderChipBench() {
  const host = $('#chipbench');
  if (!host) return;

  const player = store.formation.activePlayer;
  const { main, extra } = keptBy(player);
  const byName = new Map(chipList().map((c) => [c.name, c]));

  /*
   * An empty dock is still a dock while you are on the chips tab.
   *
   * It was hidden until the first chip was kept, which left the first drag with
   * nowhere to land -- the affordance appeared only after you had used the
   * thing it teaches. On any other tab it stays out of the way, and it is also
   * revealed by CSS for the length of any drag, so a chip dragged from a roster
   * you scrolled has somewhere to go.
   */
  const bare = !main.length && !extra.length;
  host.hidden = bare && showing.value !== 'chips';

  const chip = (name, i) => {
    const c = byName.get(name);
    return `
      <span class="chipbench__chip" data-chip="${esc(name)}" tabindex="0" role="listitem"
        title="${esc(c ? `${name}: ${c.text}` : name)}"
        aria-label="${esc(i === null
          ? `${name}, shortlisted. Left and right arrows move it, Delete drops it.`
          : `${name}, pick ${i + 1} of ${PER}. Left and right arrows move it, Delete drops it.`)}">
        ${c ? `<img src="${esc(iconFor(c))}" alt="" loading="lazy" decoding="async">`
          : `<span class="chipbench__missing">?</span>`}
        ${i === null ? '' : `<span class="chipbench__n">${i + 1}</span>`}
      </span>`;
  };

  host.innerHTML = `
    <div class="chipbench__head">
      <span class="chipbench__label">Chips</span>
      <span class="chipbench__count">${bare
        ? 'Tap a chip to keep it, or drag one here to set its order'
        : `<b>${main.length}</b>/${PER}${
          extra.length ? ` &middot; ${extra.length} shortlisted` : ''}`}</span>
    </div>
    <div class="chipbench__strip">
      ${main.map((n, i) => chip(n, i)).join('')}
      ${/* An outline for each pick you have not made yet: three boxes say the
            number is three far better than a sentence does, and each one is a
            target in its own right. */ ''}
      ${Array.from({ length: Math.max(0, PER - main.length) }, () => `
        <span class="chipbench__slot" data-list="main" aria-hidden="true"></span>`).join('')}
      ${extra.length ? `<span class="chipbench__gap" aria-hidden="true"></span>` : ''}
      ${extra.map((n) => chip(n, null)).join('')}
      ${extra.length ? '' : `
        <span class="chipbench__slot chipbench__slot--extra" data-list="extra">+</span>`}
    </div>`;

  readyChipZone();
  for (const el of host.querySelectorAll('.chipbench__chip')) {
    bindChipDrag(el, el.dataset.chip);
  }

  bindChipKeys(host);

  /* The dock just changed height, and on a phone the page's bottom padding is
     derived from it. Said directly rather than waited for: the observer that
     would notice is deferred while the tab is not being rendered. */
  measureDock();
}

export function renderRoster() {
  // Every path that changes what the roster shows comes through here, so this is
  // the one place the chips' counts have to be brought back into agreement with
  // it -- including the search box, which never touches a chip.
  refreshChipCounts();
  /* And the dock, for the same reason: keeping a chip calls onChange, which is
     renderRoster and not the whole app, so a dock drawn only from renderAll
     never hears about it. */
  renderChipBench();
  renderChipTray();

  const fold = $('#filters-toggle');
  if (fold) {
    const n = activeFilterCount();
    fold.innerHTML = `Filters${n ? ` <b>${n}</b>` : ''}`;
    fold.classList.toggle('is-on', n > 0);
  }
  /* data-chip-view belongs to the chips list and only to it: it decides the
     roster's grid columns, and left behind on the way back to Tatari it laid
     230 cards out one per row at full width. Cleared here rather than in each
     of the other two render paths, because there is no fourth list yet and
     there will be, and it would be forgotten. renderChips sets it again. */
  $('#roster').removeAttribute('data-chip-view');

  if (showing.value === 'zobos') { renderZobos(); return; }
  if (showing.value === 'chips') { renderChips(); return; }
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
           title="${esc(t.name)}: ${t.type} ${t.role}, T${t.tier}${
             state_ ? `\n${state_}` : ''}${clash ? `\nTap to switch from ${clash.name}, keeping its plan` : ''}">
        <!-- Last in the queue: 230 thumbnails will otherwise crowd out the
             dozen sprites the field and the benches are showing right now. -->
        <div class="card__art">${effectMarks(t)}${artHTML(t, { priority: 'low' })}</div>
        <div class="card__meta">
          ${patchMark(t)}<span class="card__tier">T${t.tier}</span>
          ${typeIcon(t.type)}${roleIcon(t.role)}
          ${otherPlayer.length
            ? `<span class="card__other" data-player="${otherPlayer[0]}"
                     title="P${otherPlayer[0]} is bringing this too">P${otherPlayer[0]}</span>` : ''}
        </div>
        <div class="card__name">${esc(t.name)}</div>
        ${clash ? `<span class="card__lock" aria-hidden="true">&#8646;</span>
        <span class="sr-only">Switch from ${esc(clash.name)}, keeping its plan</span>` : ''}
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
