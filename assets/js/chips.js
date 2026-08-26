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
import * as store from './store.js';
import { $, esc } from './ui.js';

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
      return t ? { cell, slug, name: t.name, type: t.type } : null;
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
    return {
      n: board.filter((p) => rule.test(p, board)).length,
      of: board.length,
      why: rule.why,
      assumes: rule.assumes ?? null,
    };
  }

  if (chip.element) {
    const n = board.filter((p) => p.type === chip.element).length;
    return { n, of: board.length, why: `${chip.element} Tatari`, assumes: null };
  }

  if (chip.name === 'Weakest Link') {
    const split = elementSplit(board);
    const least = split[split.length - 1];
    return {
      n: least?.count ?? 0,
      of: board.length,
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

const SHAPES = [
  { key: 'placement', title: 'Read your board', blurb: 'Worth different amounts depending on where things stand.' },
  { key: 'element', title: 'Read your elements', blurb: 'Worth what your split makes them worth.' },
  { key: 'level', title: 'Move your levels', blurb: 'These act on the level-up plan rather than the board.' },
  { key: 'economy', title: 'Energizers', blurb: 'Income. The same for any formation.' },
  { key: 'capacity', title: 'More bodies', blurb: 'Change how many you can field.' },
  { key: 'stat', title: 'Flat buffs', blurb: 'Everyone, everywhere.' },
  { key: 'map', title: 'Change the map', blurb: 'Nothing to do with your Tatari at all.' },
];

const TAKEN_KEY = 'coc.chips.taken';
const PER_PLAYER = 3;

/** What you kept this run, as { player: [name, …] }. Never more than three each. */
function taken() {
  try { return JSON.parse(localStorage.getItem(TAKEN_KEY) || '{}') || {}; } catch { return {}; }
}

function setTaken(next) {
  try { localStorage.setItem(TAKEN_KEY, JSON.stringify(next)); } catch { /* private window */ }
}

function takenBy(player) { return taken()[player] ?? []; }

function toggleTaken(player, name) {
  const all = taken();
  const mine = all[player] ?? [];
  all[player] = mine.includes(name)
    ? mine.filter((n) => n !== name)
    : [...mine, name].slice(-PER_PLAYER);   // the oldest drops out rather than refusing
  setTaken(all);
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

/* ------------------------------------------------------- the drafter panel */

/**
 * The live block, under the Summary.
 *
 * Deliberately only the chips that move as you drag. The other twenty-eight are
 * the same whatever you build, so putting them here would bury the six that are
 * not under twenty-eight that are -- and they are one tap away on the page.
 *
 * No sheet of its own on a phone: the app bar is already five buttons wide and a
 * sixth would take letters off the others. This sits inside the field panel, so
 * on a phone it arrives inside the Summary sheet, which is where you already go
 * to ask what the board adds up to.
 */
export function renderChips() {
  const host = $('#chips');
  if (!host || !BOOK?.chips?.length) return;

  const player = store.formation.activePlayer;
  const board = boardFor(player);

  if (!board.length) {
    host.innerHTML = `
      <h3 class="chipsblock__head">Chips</h3>
      <p class="chipsblock__empty">Put something on the field and this says what each chip
        would be worth to it. <a href="chips.html">All 49 chips</a></p>`;
    return;
  }

  const reads = rank(BOOK.chips.filter((c) => c.shape === 'placement'), board);
  const split = elementSplit(board);
  const mine = takenBy(player);

  host.innerHTML = `
    <h3 class="chipsblock__head">
      Chips
      <span class="chipsblock__sub">what an offer would be worth to these ${board.length}</span>
    </h3>
    <ul class="chipsblock__list">
      ${reads.map(({ chip, score }) => `
        <li class="chipbar${mine.includes(chip.name) ? ' is-taken' : ''}"
            style="--fill:${board.length ? Math.round((score.n / board.length) * 100) : 0}%"
            title="${esc(chip.text)}">
          <img class="chipbar__art" src="${esc(iconFor(chip))}" alt="" loading="lazy" decoding="async">
          <span class="chipbar__name">${esc(chip.name)}</span>
          <span class="chipbar__n"><b>${score.n}</b> of ${score.of}</span>
          <span class="chipbar__why">${esc(score.why)}</span>
        </li>`).join('')}
    </ul>
    <p class="chipsblock__split">
      ${split.map((e) => `<span class="chipsplit" data-type="${esc(e.type)}"
        title="${esc(`${e.type} Form is worth ${e.count} of your ${board.length}`)}"
        >${esc(e.type)} <b>${e.count}</b></span>`).join('')}
    </p>
    <p class="chipsblock__more">
      <a href="chips.html">All 49 chips${mine.length ? ` &middot; ${mine.length} of ${PER_PLAYER} kept` : ''} &rarr;</a>
    </p>`;
}

/* ------------------------------------------------------------- the page */

/** One chip as a card. `score` is null for the twenty-eight that read nothing. */
function card(chip, score, isTaken) {
  const scoreHTML = !score ? '' : `
    <p class="chipcard__score" data-empty="${score.n === 0}">
      <b>${score.n}</b> of your ${score.of} &mdash; ${esc(score.why)}
    </p>`;

  /* The two readings this file guesses at, and the four it suspects reach a
     co-op partner, are printed on the card rather than kept in a comment. A
     guess the reader can see is a guess they can correct after one run. */
  const doubt = [
    score?.assumes ? { kind: 'reading', text: score.assumes } : null,
    chip.scope === 'unknown'
      ? { kind: 'scope', text: `Might affect both players. ${chip.scopeNote}` }
      : null,
  ].filter(Boolean);

  return `
    <article class="chipcard${isTaken ? ' is-taken' : ''}" data-chip="${esc(chip.name)}">
      <button class="chipcard__keep" type="button" data-keep="${esc(chip.name)}"
        aria-pressed="${isTaken}"
        aria-label="${esc(isTaken ? `Stop counting ${chip.name} as kept` : `I kept ${chip.name}`)}"
        title="${esc(isTaken ? 'Kept this run' : 'Mark this as one of the three you kept')}"
        >${isTaken ? '&check;' : '+'}</button>
      <img class="chipcard__art" src="${esc(iconFor(chip))}" alt="" loading="lazy" decoding="async">
      <h3 class="chipcard__name">
        ${esc(chip.name)}
        <span class="chipcard__tier" data-tier="${chip.tier}"
          title="${esc(`Tier ${'I'.repeat(chip.tier)} in the gallery`)}">${'I'.repeat(chip.tier)}</span>
      </h3>
      <p class="chipcard__text">${esc(chip.text)}</p>
      ${scoreHTML}
      ${doubt.map((d) => `<p class="chipcard__doubt" data-kind="${d.kind}">${esc(d.text)}</p>`).join('')}
    </article>`;
}

function renderPage() {
  const chips = BOOK?.chips ?? [];
  const player = store.formation.activePlayer;
  const board = boardFor(player);
  const mine = takenBy(player);
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
  $('#chips-kept').innerHTML = `
    <div class="kept__head">
      <h2>What you kept${coop ? ` &mdash; P${player}` : ''}</h2>
      ${coop ? `<div class="kept__who" role="group" aria-label="Whose chips">
        ${store.players().map((p) => `
          <button class="btn btn--tiny${p === player ? ' is-on' : ''}" type="button"
            data-player="${p}" aria-pressed="${p === player}">P${p}</button>`).join('')}
      </div>` : ''}
    </div>
    <ol class="kept__slots">
      ${Array.from({ length: PER_PLAYER }, (_, i) => {
        const name = mine[i];
        const chip = chips.find((c) => c.name === name);
        return `<li class="kept__slot${name ? ' is-filled' : ''}">${
          name ? `<b>${esc(name)}</b><span>${esc(chip?.text ?? '')}</span>`
               : '<span class="kept__wait">Nothing yet</span>'}</li>`;
      }).join('')}
    </ol>
    ${coop ? `<p class="kept__total muted">${
      store.players().reduce((n, p) => n + takenBy(p).length, 0)} of
      ${PER_PLAYER * store.players().length} between you.</p>` : ''}`;

  $('#chips-body').innerHTML = SHAPES.map(({ key, title, blurb }) => {
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
        <p class="chgroup__blurb">${blurb}</p>
        <div class="chgroup__grid">
          ${scored.map(({ chip, score }) => card(chip, score, mine.includes(chip.name))).join('')}
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
      toggleTaken(store.formation.activePlayer, keep.dataset.keep);
      renderPage();
      return;
    }
    const who = e.target.closest('.kept__who [data-player]');
    if (who) {
      store.setActivePlayer(Number(who.dataset.player));
      renderPage();
    }
  });
}
