/**
 * The shared field (6 wide, 6 deep), the bench strip beneath it, and the player
 * tabs above it.
 *
 * In co-op both players' tokens sit on the same field, so every occupant carries
 * its owner and tokens are badged P1 / P2. The bench strip shows the part of the
 * active player's 15 that has not landed yet.
 */

import { state, matches } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, roleIcon, typeIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';
import { quickAddStep } from './priority.js';
import { coveredFrom, coverage, hasRange } from './range.js';
import { effectsOf, GROUP_LABELS, helpFor } from './effects.js';

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
export function renderRanges() {
  const on = rangesOn.value;
  grid.classList.toggle('shows-coverage', on);
  if (!on) clearRangePreview();

  const { counts } = on
    ? coverage(store.allPlaced())
    : { counts: [] };

  for (const cell of grid.children) {
    const n = counts[Number(cell.dataset.cell)] ?? 0;
    if (on && n) cell.dataset.cover = Math.min(n, 4);
    else delete cell.dataset.cover;
  }
}

/**
 * Whether the range overlays are on. Off by default, and labelled WIP in the
 * UI, because the tile patterns are read off in-game screenshots by hand and
 * only some of the roster has been done — see data/ranges.json.
 */
export const rangesOn = { value: false };

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
  renderRanges();
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
      ${artHTML(t)}<span class="want__name">${esc(t.name)}</span>
      <button class="want__x" type="button" data-drop-want="${esc(t.slug)}"
        aria-label="Take ${esc(t.name)} off this line">×</button>
    </span>`).join('');

  // On the field, both lines are drawn — that is the whole point of splitting
  // them — with HAVE first, because it reads as the offer before the ask.
  const filled = store.filledLines();
  const shown = $('#field-lf');
  shown.hidden = !coop || !filled.length;
  shown.innerHTML = filled.map((l) => {
    const named = l.wants.map((slug) => state.bySlug.get(slug)).filter(Boolean);
    return `<span class="field-lf__line" data-mode="${l.side}">
      <span class="field-lf__tag">${esc(store.LF_LABELS[l.side])}</span>${
      named.map((t) => `<span class="field-lf__want" data-type="${esc(t.type)}">${
        artHTML(t)}<span>${esc(t.name)}</span></span>`).join('')
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
        ? `Only from a level-up skill — needs levelling to ${e.minLevel}`
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
