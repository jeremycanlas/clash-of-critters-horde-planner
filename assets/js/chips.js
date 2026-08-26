/**
 * Horde Invasion chips, scored against the board you actually built.
 *
 * You never choose a loadout. During a run you are offered chips at random and
 * keep three, so the question is never "which three do I want" -- it is "this one
 * is on screen right now, is it any good for the board I brought". That is a
 * question about placement, and placement is the one thing this tool already
 * knows.
 *
 * Twenty-one of the forty-nine can be answered that way: six read the board and
 * fifteen read your element split. The other twenty-eight are economy, levelling
 * and map effects that do not care where anything stands. They are listed with
 * their text and no number, because a number there would be invented.
 *
 * Everything in data/chips.json was read off the in-game gallery by hand. The
 * wiki has no chip pages at all.
 */

import { load, state } from './data.js';
import { applyPrefs } from './prefs.js';
import { draggable, dropZone } from './dnd.js';
import * as store from './store.js';
import { $, artHTML, esc } from './ui.js';

const { COLS, ROWS } = store;

const rowOf = (cell) => Math.floor(cell / COLS);
const colOf = (cell) => cell % COLS;

/*
 * Row 0 is the front row -- the one nearest the enemy, drawn at the top -- and
 * row 5 is the back, against your base.
 *
 * Worth stating plainly because "front" reads as "the bottom of the screen, my
 * side" if you think of the board as yours, and every rule below would then be
 * upside down: Barricade would armour the wrong two rows and Rear Guard would
 * speed up the two rows taking the hits.
 */
const DEPTH = 2;

/*
 * The two readings this file is guessing at.
 *
 * Both tooltips are one sentence and neither says which it means, so rather than
 * pick quietly, each rule carries the reading it used and the UI prints it. If a
 * run proves one wrong it is one line to change and the page stops lying in the
 * same edit.
 */
const ORTHOGONAL = [[0, -1], [0, 1], [-1, 0], [1, 0]];

function hasNeighbour(piece, all) {
  const r = rowOf(piece.cell);
  const c = colOf(piece.cell);
  return ORTHOGONAL.some(([dc, dr]) => {
    const nc = c + dc;
    const nr = r + dr;
    if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) return false;
    return all.some((o) => o.cell === nr * COLS + nc);
  });
}

/** How many of your own stand between this one and the enemy, in its own column. */
function aheadInLane(piece, all) {
  const c = colOf(piece.cell);
  const r = rowOf(piece.cell);
  return all.filter((o) => colOf(o.cell) === c && rowOf(o.cell) < r).length;
}

const BOARD_RULES = {
  'Barricade': {
    why: 'in your front 2 rows',
    test: (p) => rowOf(p.cell) < DEPTH,
  },
  'First-Aid Kit': {
    why: 'in your front 2 rows',
    test: (p) => rowOf(p.cell) < DEPTH,
  },
  'Rear Guard': {
    why: 'in your back 2 rows',
    test: (p) => rowOf(p.cell) >= ROWS - DEPTH,
  },
  'Center Spotlight': {
    why: 'in the middle 2 columns',
    /* Counted as "your Tatari standing where the bosses will be", which is what
       the chip is worth to you -- it does not buff anyone, it moves the enemy. */
    test: (p) => colOf(p.cell) === 2 || colOf(p.cell) === 3,
  },
  'The Exile': {
    why: 'with nobody beside, above or below them',
    assumes: 'Counted on the four squares that touch. If diagonals count as adjacent too, this number is too high.',
    test: (p, all) => !hasNeighbour(p, all),
  },
  'Backend Support': {
    why: 'with exactly 1 of yours ahead in the same column',
    assumes: 'Counted down the column. If "in front" means anywhere ahead rather than in the same lane, this number is too high.',
    test: (p, all) => aheadInLane(p, all) === 1,
  },
};

/**
 * The board as these rules want to read it: cell, and what is standing on it.
 *
 * Zobos are left out on purpose. They are nobody's, they are not what a chip
 * saying "your Tatari" means, and counting them would quietly inflate every
 * number on this page.
 */
export function boardFor(player) {
  return store.placedFor(player)
    .map(({ cell, slug }) => {
      const t = state.bySlug.get(slug);
      return t ? { cell, slug, name: t.name, type: t.type, t } : null;
    })
    .filter(Boolean);
}

/** Your element split, biggest first. Only elements you actually brought. */
export function elementSplit(board) {
  const n = new Map();
  for (const p of board) n.set(p.type, (n.get(p.type) ?? 0) + 1);
  return [...n.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/**
 * What one chip is worth to one board, or null if the chip does not care.
 *
 * `n` of `of`, never a score out of ten. The reader is deciding under an offer
 * with a few seconds to think, and "4 of your 6" answers that faster than any
 * rating could -- it is also the only thing here that is a fact rather than an
 * opinion about how good four is.
 */
export function scoreOne(chip, board) {
  const rule = BOARD_RULES[chip.name];
  if (rule) {
    const who = board.filter((p) => rule.test(p, board));
    return { n: who.length, of: board.length, who, why: rule.why, assumes: rule.assumes ?? null };
  }

  if (chip.element) {
    const who = board.filter((p) => p.type === chip.element);
    return { n: who.length, of: board.length, who, why: `${chip.element} Tatari`, assumes: null };
  }

  if (chip.name === 'Weakest Link') {
    const split = elementSplit(board);
    const least = split[split.length - 1];
    const who = least ? board.filter((p) => p.type === least.type) : [];
    return {
      n: who.length,
      of: board.length,
      who,
      why: least ? `${least.type}, your smallest element` : 'your smallest element',
      assumes: split.length > 1 && least && split[split.length - 2].count === least.count
        ? 'Two of your elements are tied for smallest, and the tooltip does not say which one wins.'
        : null,
    };
  }

  return null;
}

/** Every chip that reads this board, best first. Ties keep the file's order. */
export function rank(chips, board) {
  return chips
    .map((chip) => ({ chip, score: scoreOne(chip, board) }))
    .filter((r) => r.score)
    .sort((a, b) => b.score.n - a.score.n);
}

/* ==========================================================================
 * The two surfaces
 *
 * One engine above, drawn twice: a live block under the Summary in the drafter,
 * and a page of its own you can send someone. The panel is what you glance at
 * while dragging; the page is where all forty-nine live and where you record
 * what a run actually handed you.
 * ========================================================================== */

/*
 * The headings, and nothing under them.
 *
 * Each group used to carry a sentence explaining itself. On a page where every
 * card already prints what its chip does, that sentence was a paragraph between
 * you and the chips, seven times over.
 *
 * `faces` marks the two groups that answer with sprites instead of a sentence:
 * a Position or Element chip touches particular Tatari, and showing which ones
 * says it faster and more exactly than any wording of "3 of your 5".
 */
const SHAPES = [
  { key: 'placement', title: 'Position Chips', faces: true },
  { key: 'element', title: 'Element Chips', faces: true },
  { key: 'level', title: 'Level up Chips' },
  { key: 'economy', title: 'Energizer Chips' },
  { key: 'capacity', title: 'More Tatari Chips' },
  { key: 'stat', title: 'Flat Buff Chips' },
  { key: 'map', title: 'Map Chips' },
];

/*
 * Which tiers to show. Empty means all of them, the same contract every filter
 * in the roster uses: nothing pressed is not an empty result, it is no question
 * asked.
 *
 * Tier is what the game calls rarity. The gallery says it twice, as a numeral on
 * the name and as the colour of the tile, and this page says it twice too.
 */
const tiers = new Set();

const TAKEN_KEY = 'coc.chips.taken';
const PER_PLAYER = 3;

/*
 * Two lists, not one.
 *
 * A run gives you three, and which three is a decision you make in order --
 * first pick, second, third -- so those three are ranked and can be moved. But
 * the useful thinking happens before the offer: "against this formation these
 * nine are worth taking, and these three are the ones I want most". The second
 * list has no limit because that thinking has no limit; it is a shortlist for a
 * board, not a loadout.
 *
 * Stored per player, since co-op is three each and six between you.
 *
 *   { "1": { main: [name, name, name], extra: [name, ...] } }
 */
function readAll() {
  let raw;
  try { raw = JSON.parse(localStorage.getItem(TAKEN_KEY) || '{}') || {}; } catch { return {}; }
  const out = {};
  for (const [player, value] of Object.entries(raw)) {
    // The first version of this stored a bare array. Anybody who used it keeps
    // what they marked, as their main three, rather than losing it silently.
    if (Array.isArray(value)) out[player] = { main: value.slice(0, PER_PLAYER), extra: [] };
    else out[player] = { main: value?.main ?? [], extra: value?.extra ?? [] };
  }
  return out;
}

function writeAll(next) {
  try { localStorage.setItem(TAKEN_KEY, JSON.stringify(next)); } catch { /* private window */ }
}

export function keptBy(player) { return readAll()[player] ?? { main: [], extra: [] }; }

/** Both lists at once, for "is this chip spoken for". */
function allKept(player) {
  const { main, extra } = keptBy(player);
  return [...main, ...extra];
}

function update(player, fn) {
  const all = readAll();
  const mine = all[player] ?? { main: [], extra: [] };
  all[player] = fn({ main: [...mine.main], extra: [...mine.extra] });
  writeAll(all);
}

/**
 * Keeping a chip, and letting go of it.
 *
 * One button on the card rather than two. It fills the three first because that
 * is what a run asks for, and once they are full it goes on the shortlist --
 * which is the honest answer to a fourth press, rather than refusing or silently
 * pushing the first pick out.
 */
export function toggleKept(player, name) {
  update(player, ({ main, extra }) => {
    if (main.includes(name)) return { main: main.filter((n) => n !== name), extra };
    if (extra.includes(name)) return { main, extra: extra.filter((n) => n !== name) };
    if (main.length < PER_PLAYER) return { main: [...main, name], extra };
    return { main, extra: [...extra, name] };
  });
}

/** Moves one of the three up or down. `step` is -1 or 1. */
function reorder(player, name, step) {
  update(player, ({ main, extra }) => {
    const i = main.indexOf(name);
    const j = i + step;
    if (i < 0 || j < 0 || j >= main.length) return { main, extra };
    const next = [...main];
    [next[i], next[j]] = [next[j], next[i]];
    return { main: next, extra };
  });
}

/** Shortlist to the three, and back. */
function promote(player, name) {
  update(player, ({ main, extra }) => (main.length >= PER_PLAYER
    ? { main, extra }
    : { main: [...main, name], extra: extra.filter((n) => n !== name) }));
}

/**
 * Drops `name` into `list` at `index`, taking it out of wherever it was.
 *
 * One function for all four directions a drag can go -- within the three,
 * within the shortlist, and either way between them -- because they are the
 * same operation and writing them as four was how the button versions ended up
 * with four slightly different ideas of what "remove first" means.
 *
 * The three still cap at three. A drag into a full set of slots pushes the one
 * it lands on down rather than refusing, since the drag already said where it
 * wanted to go; the displaced chip goes to the shortlist rather than nowhere.
 */
export function moveInto({ main, extra }, name, list, index, cap = PER_PLAYER) {
  let m = main.filter((n) => n !== name);
  let x = extra.filter((n) => n !== name);
  if (list === 'main') {
    m.splice(Math.max(0, Math.min(index, m.length)), 0, name);
    while (m.length > cap) x = [m.pop(), ...x];
  } else {
    x.splice(Math.max(0, Math.min(index, x.length)), 0, name);
  }
  return { main: m, extra: x };
}

/*
 * Exported and pure, so chipstest.html can drive it with plain arrays.
 *
 * The gesture underneath it is dnd.js, which the field and the plan already
 * prove; what is new here is where a chip ends up, and that is arithmetic on two
 * lists. Testing it through a synthetic pointer would be testing the browser.
 */
function placeAt(player, name, list, index) {
  update(player, (lists) => moveInto(lists, name, list, index));
}

function demote(player, name) {
  update(player, ({ main, extra }) => ({
    main: main.filter((n) => n !== name),
    extra: [...extra, name],
  }));
}

/**
 * A chip's icon, cut out of the in-game gallery by tools/cut_chips.py.
 *
 * The same slug rule as the tool, and it has to stay the same: the tool checks
 * its output against every name in chips.json, so a rename breaks the build
 * loudly there rather than quietly here. Nothing on the wiki, nothing to fetch
 * -- these exist only because somebody screenshotted the gallery.
 */
export const iconFor = (chip) =>
  `data/images/chips/${chip.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`;

let BOOK = null;

/** Every chip, once loadChips() has run. Empty before that, never null. */
export const chipList = () => BOOK?.chips ?? [];

/** Loads chips.json once. Safe to call twice; the second call is the same promise. */
let loading = null;
export function loadChips() {
  loading ??= fetch('data/chips.json')
    .then((r) => r.json())
    // A copy without the file draws no panel at all rather than an empty one.
    .catch(() => ({ chips: [] }))
    .then((book) => { BOOK = book; return book; });
  return loading;
}

/**
 * The Tatari a score is talking about, as sprites.
 *
 * A bar answered "how much of your board" and this answers "which ones", which
 * is the question actually being asked. Deciding under an offer, "Rear Guard: 4
 * of 6" still leaves you looking back at the field to work out whether those
 * four are the ones you care about; four faces do not.
 *
 * Capped, because Sandbox lifts the deployment limit and a 36-Tatari board would
 * otherwise draw 36 sprites on every one of 21 cards. The count beside them is
 * the whole number either way, so the cap never hides the answer.
 */
const SHOWN = 8;

function whoRow(score) {
  if (!score.who?.length) return '';
  const shown = score.who.slice(0, SHOWN);
  const rest = score.who.length - shown.length;
  return `<span class="chipwho">${
    shown.map((p) => `<span class="chipwho__art" data-type="${esc(p.type)}" title="${esc(p.name)}"
      >${p.t ? artHTML(p.t, { priority: 'low' }) : esc(p.name)}</span>`).join('')
  }${rest > 0 ? `<span class="chipwho__more">+${rest}</span>` : ''}</span>`;
}

/* ------------------------------------------------------------- the page */

/** One chip as a card. `score` is null for the twenty-eight that read nothing. */
/**
 * One chip as a card.
 *
 * Position and Element chips answer in faces: the sprites of the Tatari the
 * chip would touch, and no sentence at all. Everything else answers with a
 * count, because "11 energizers every 5 seconds" is not about anybody in
 * particular and there is nobody to draw.
 */
function card(chip, score, isTaken, faces) {
  const scoreHTML = !score ? '' : (faces
    ? (score.n ? `<div class="chipcard__score" data-faces="true">${whoRow(score)}</div>` : '')
    : `<div class="chipcard__score" data-empty="${score.n === 0}">
        <p class="chipcard__count"><b>${score.n}</b> of your ${score.of} ${esc(score.why)}</p>
      </div>`);

  return `
    <article class="chipcard${isTaken ? ' is-taken' : ''}" data-chip="${esc(chip.name)}">
      <button class="chipcard__keep" type="button" data-keep="${esc(chip.name)}"
        aria-pressed="${isTaken}"
        aria-label="${esc(isTaken ? `Stop counting ${chip.name} as kept` : `I kept ${chip.name}`)}"
        title="${esc(isTaken ? 'Keeping this' : 'Keep this: one of your three, or the shortlist once they are full')}"
        >${isTaken ? '&check;' : '+'}</button>
      <img class="chipcard__art" src="${esc(iconFor(chip))}" alt="" loading="lazy" decoding="async">
      <h3 class="chipcard__name">
        ${esc(chip.name)}
        <span class="chipcard__tier" data-tier="${chip.tier}"
          title="${esc(`Tier ${'I'.repeat(chip.tier)} in the gallery`)}">${'I'.repeat(chip.tier)}</span>
      </h3>
      <p class="chipcard__text">${esc(chip.text)}</p>
      ${scoreHTML}
    </article>`;
}

const TIERS = [
  { tier: 1, label: 'I' },
  { tier: 2, label: 'II' },
  { tier: 3, label: 'III' },
];

function renderFilters(all) {
  const host = $('#chips-filters');
  if (!host) return;

  const present = TIERS.filter(({ tier }) => all.some((c) => c.tier === tier));
  // One tier is not a choice, so there is nothing to offer.
  host.hidden = present.length < 2;
  if (host.hidden) return;

  const shown = tiers.size ? all.filter((c) => tiers.has(c.tier)).length : all.length;
  host.innerHTML = `
    <span class="chipfilters__label">Tier</span>
    ${present.map(({ tier, label }) => `
      <button class="chip chip--rarity" type="button" data-tier="${tier}"
        aria-pressed="${tiers.has(tier)}"
        title="${esc(`Show only tier ${label} chips. Press again to stop filtering by it.`)}"
        ><span class="chip__tier" data-tier="${tier}" aria-hidden="true">${label}</span
        >${all.filter((c) => c.tier === tier).length}</button>`).join('')}
    <span class="chipfilters__n">${shown === all.length
      ? `all ${all.length}`
      : `${shown} of ${all.length}`}</span>`;
}

/*
 * Dragging the rows, on top of the buttons rather than instead of them.
 *
 * The buttons stay because they are the keyboard path and the screen-reader
 * path, and because on a phone two taps beats a hold-and-drag for moving one
 * row one place. Drag is for the case the buttons are bad at: taking the third
 * pick and putting it first, or pulling something off the shortlist straight
 * into slot 1.
 *
 * The grip is the sprite, not the row. `.prio` shipped in DRAG_SURFACES with no
 * `touch-action: none` anywhere, so the browser had claimed the gesture as a
 * scroll long before the hold fired and reordering the plan by touch simply did
 * not happen. The whole row cannot take `touch-action: none` either -- this is a
 * page you scroll, and rows that refuse to scroll under a thumb are worse than
 * rows that do not drag. So the sprite is the handle, the way the rank number is
 * on the plan.
 */
let zoneReady = false;
function readyZone() {
  if (zoneReady) return;
  zoneReady = true;
  dropZone({
    selector: '.keptrow, .kept__slot, .kept__extra',
    accepts: (target, payload) =>
      payload?.from === 'kept' && target.dataset.name !== payload.name,
    onHover: (target, ok) => target.classList.toggle('is-over', ok),
    onDrop: (target, payload) => {
      const player = store.formation.activePlayer;
      const { main, extra } = keptBy(player);

      // A row says exactly where; a container says "somewhere in here", which
      // for the shortlist means the end and for an empty slot means the end of
      // the three.
      if (target.classList.contains('keptrow')) {
        const name = target.dataset.name;
        const inMain = main.indexOf(name);
        if (inMain >= 0) placeAt(player, payload.name, 'main', inMain);
        else placeAt(player, payload.name, 'extra', extra.indexOf(name));
      } else if (target.classList.contains('kept__extra')) {
        placeAt(player, payload.name, 'extra', extra.length);
      } else {
        placeAt(player, payload.name, 'main', main.length);
      }
      renderPage();
    },
  });
}

function bindDrag() {
  readyZone();
  for (const el of $$('.keptrow')) {
    if (el.dataset.dragBound) continue;
    el.dataset.dragBound = '1';
    draggable(
      el.querySelector('.keptrow__art') ?? el,
      () => ({ from: 'kept', name: el.dataset.name }),
      () => `<span class="keptghost">${esc(el.dataset.name)}</span>`,
    );
  }
}

const $$ = (sel) => [...document.querySelectorAll(sel)];

function renderPage() {
  const all = BOOK?.chips ?? [];
  renderFilters(all);
  const chips = tiers.size ? all.filter((c) => tiers.has(c.tier)) : all;
  const player = store.formation.activePlayer;
  const board = boardFor(player);
  const { main, extra } = keptBy(player);
  const kept = [...main, ...extra];
  const coop = store.isCoop();

  $('#chips-patch').textContent = board.length
    ? `scored against the ${board.length} on your field`
    : 'nothing on the field yet';

  $('#chips-intro').innerHTML = board.length ? '' : `
    Nothing is on the field, so nothing below has a number against it. Build a
    formation in <a href="index.html">the drafter</a> and every chip that reads a
    board will say what it would be worth to yours.`;

  /*
   * The three you kept, at the top, because that is the thing you come back to
   * mid-run. In co-op it is three each and six between you, which is why the
   * tabs exist -- the tool already knows whose board is whose.
   */
  /*
   * The row's contents, not the row. Both callers are already inside an <li> --
   * the three slots and the shortlist are both lists -- and returning another
   * one nested li inside li, which is invalid, so the browser closed the outer
   * one early and hoisted every row out of the slot it belonged to. The slots
   * still said is-filled and had nothing in them.
   */
  const row = (name, controls) => {
    const chip = all.find((c) => c.name === name);
    return `
      <img class="keptrow__art" src="${esc(chip ? iconFor(chip) : '')}" alt=""
           loading="lazy" decoding="async">
      <span class="keptrow__name">${esc(name)}</span>
      <span class="keptrow__ctl">${controls}</span>`;
  };

  const btn = (act, name, glyph, label, off = false) => `
    <button class="keptrow__btn" type="button" data-act="${act}" data-name="${esc(name)}"
      ${off ? 'disabled' : ''} aria-label="${esc(label)}" title="${esc(label)}">${glyph}</button>`;

  $('#chips-kept').innerHTML = `
    <div class="kept__head">
      <h2>${coop ? `P${player}` : 'The three you keep'}</h2>
      ${coop ? `<div class="kept__who" role="group" aria-label="Whose chips">
        ${store.players().map((p) => `
          <button class="btn btn--tiny${p === player ? ' is-on' : ''}" type="button"
            data-player="${p}" aria-pressed="${p === player}">P${p}</button>`).join('')}
      </div>` : ''}
    </div>

    <ol class="kept__slots">
      ${Array.from({ length: PER_PLAYER }, (_, i) => {
        const name = main[i];
        if (!name) return '<li class="kept__slot"><span class="kept__wait">Nothing yet</span></li>';
        return `<li class="kept__slot is-filled keptrow" data-name="${esc(name)}">${row(name, [
          btn('up', name, '&uarr;', `Move ${name} up`, i === 0),
          btn('down', name, '&darr;', `Move ${name} down`, i === main.length - 1),
          btn('demote', name, '&darr;&darr;', `Move ${name} to the shortlist`),
          btn('drop', name, '&times;', `Stop keeping ${name}`),
        ].join(''))}</li>`;
      }).join('')}
    </ol>

    <div class="kept__extra">
      <h3>Also worth taking
        <span class="kept__hint">${extra.length
          ? `${extra.length} shortlisted for this formation`
          : 'as many as you like'}</span>
      </h3>
      ${extra.length ? `<ul class="kept__list">
        ${extra.map((name) => `<li class="keptrow" data-name="${esc(name)}">${row(name, [
          btn('promote', name, '&uarr;', `Move ${name} into the three`, main.length >= PER_PLAYER),
          btn('drop', name, '&times;', `Take ${name} off the shortlist`),
        ].join(''))}</li>`).join('')}
      </ul>` : `<p class="kept__none">Keep a fourth chip and it lands here. Nothing on this
        list is a commitment; it is what you would take if the run offered it.</p>`}
    </div>

    ${coop ? `<p class="kept__total muted">${
      store.players().reduce((n, p) => n + keptBy(p).main.length, 0)} of
      ${PER_PLAYER * store.players().length} kept between you.</p>` : ''}`;

  // Bound after the rows exist, and every render, because renderPage() replaces
  // them all and a handler on a detached node drags nothing.
  bindDrag();

  if (!chips.length) {
    $('#chips-body').innerHTML = `
      <p class="chipspage__none">No chips at that tier. The tiers you have not
        pressed are still there, and pressing a tier again releases it.</p>`;
    return;
  }

  $('#chips-body').innerHTML = SHAPES.map(({ key, title, faces }) => {
    const group = chips.filter((c) => c.shape === key);
    if (!group.length) return '';
    /* Placement and element groups lead with whatever is worth most to this
       board. The rest keep the file's order, which has no meaning to sort by. */
    const scored = group.map((chip) => ({ chip, score: board.length ? scoreOne(chip, board) : null }));
    if (key === 'placement' || key === 'element') {
      scored.sort((a, b) => (b.score?.n ?? 0) - (a.score?.n ?? 0));
    }
    return `
      <section class="chgroup" data-shape="${key}">
        <h2 class="chgroup__head">${title}
          <span class="chgroup__count">${group.length}</span>
        </h2>
        <div class="chgroup__grid">
          ${scored.map(({ chip, score }) => card(chip, score, kept.includes(chip.name), faces)).join('')}
        </div>
      </section>`;
  }).join('');
}

/*
 * Only boot when this really is the page.
 *
 * The engine above is exported so chipstest.html can check the six board rules
 * against boards it builds itself, and importing a module runs everything at its
 * top level. Without this guard the test page would try to draw a page that is
 * not there. The drafter never matches it either, which is what keeps one file
 * serving both surfaces.
 */
if ($('#chips-body')) {
  applyPrefs();
  await load();
  store.restore();
  await loadChips();
  renderPage();

  document.addEventListener('click', (e) => {
    const keep = e.target.closest('[data-keep]');
    if (keep) {
      toggleKept(store.formation.activePlayer, keep.dataset.keep);
      renderPage();
      return;
    }

    const act = e.target.closest('.keptrow__btn');
    if (act) {
      const player = store.formation.activePlayer;
      const { act: what, name } = act.dataset;
      if (what === 'up') reorder(player, name, -1);
      else if (what === 'down') reorder(player, name, 1);
      else if (what === 'promote') promote(player, name);
      else if (what === 'demote') demote(player, name);
      else if (what === 'drop') toggleKept(player, name);
      renderPage();
      /* Focus follows the row, or every reorder throws you back to the top of
         the page and the second press has to be aimed all over again. */
      $(`.keptrow[data-name="${CSS.escape(name)}"] [data-act="${what}"]`)?.focus()
        ?? $(`.keptrow[data-name="${CSS.escape(name)}"] .keptrow__btn`)?.focus();
      return;
    }
    const tier = e.target.closest('.chip--rarity');
    if (tier) {
      const n = Number(tier.dataset.tier);
      if (tiers.has(n)) tiers.delete(n); else tiers.add(n);
      renderPage();
      $(`.chip--rarity[data-tier="${n}"]`)?.focus();
      return;
    }
    const who = e.target.closest('.kept__who [data-player]');
    if (who) {
      store.setActivePlayer(Number(who.dataset.player));
      renderPage();
    }
  });
}
