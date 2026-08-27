/**
 * The level-up plan: an ordered list of steps to read top-down mid-run.
 *
 * Horde offers three cards each round and any of them may be a level-up for
 * something already on the field, so the useful artefact is a running sequence.
 * A step names one Tatari most of the time - "Sealing to 3" - but it can name
 * several and carry a note, which is how you write down the things a single
 * level number cannot say: three tanks and "max one of these first".
 *
 * A Tatari appears once per level it should hit, so a plan legitimately reads:
 * Sealing 3, Cheerling 3, Frugagon 3, Sealing 5.
 *
 * In co-op each player runs their own board, so each keeps their own plan and
 * the tabs switch between them. A step never mixes the two.
 */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';

const host = $('#priority');
const adder = $('#step-adder');
const picker = $('#step-picker');
const tabsHost = $('#plan-tabs');

/** `player:slug` of every Tatari selected in the adder. */
const chosen = new Set();

/** The level the adder offers: a select value, or null to follow the suggestion. */
let chosenLevel = null;

export function buildPriority() {
  dropZone({
    selector: '.prio',
    accepts: (target, payload) =>
      payload.from === 'plan' && Number(target.dataset.index) !== payload.index,
    onHover: (target, ok) => target.classList.toggle('is-over', ok),
    onDrop: (target, payload) => store.moveStep(payload.index, Number(target.dataset.index)),
  });

  // Delegated so re-renders need no rebinding.
  host.addEventListener('change', (e) => {
    const li = e.target.closest('.prio');
    if (!li) return;
    const index = Number(li.dataset.index);

    if (e.target.closest('.prio__level')) {
      const result = store.setStepLevel(index, e.target.value === '' ? null : Number(e.target.value));
      if (!result.ok) { toast(result.reason, 'error'); renderPriority(); }
      return;
    }
    // Notes commit on change rather than on input: a re-render mid-word would
    // take the caret with it.
    if (e.target.closest('.prio__note')) store.setStepNote(index, e.target.value);
  });

  host.addEventListener('click', (e) => {
    const li = e.target.closest('.prio');
    if (!li) return;
    const index = Number(li.dataset.index);

    if (e.target.closest('[data-drop-step]')) { store.removeStep(index); return; }

    const member = e.target.closest('[data-drop-member]');
    if (member) {
      store.removeStepMember(index, member.dataset.dropMember, Number(member.dataset.memberPlayer));
      return;
    }

    // Opening the note editor is a view change, so it stays in the DOM rather
    // than going through the store and re-rendering the list.
    if (!e.target.closest('[data-note-toggle]')) return;
    li.classList.toggle('is-noting');
    if (li.classList.contains('is-noting')) li.querySelector('.prio__note').focus();
  });

  host.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.prio__note')) { e.target.blur(); return; }

    const li = e.target.closest('.prio');
    if (!li || !(e.ctrlKey || e.metaKey)) return;
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    const from = Number(li.dataset.index);
    store.moveStep(from, from + delta);
    requestAnimationFrame(() => host.querySelector(`[data-index="${from + delta}"]`)?.focus());
  });

  tabsHost.addEventListener('click', (e) => {
    const tab = e.target.closest('.ptab');
    if (tab) store.setActivePlayer(Number(tab.dataset.player));
  });

  picker.addEventListener('click', (e) => {
    const opt = e.target.closest('.step-pick');
    if (!opt) return;
    const key = opt.dataset.key;
    if (chosen.has(key)) chosen.delete(key); else chosen.add(key);
    renderAdder();
  });

  adder.addEventListener('change', (e) => {
    if (e.target.name === 'level') chosenLevel = e.target.value;
  });

  adder.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!chosen.size) { toast('Pick at least one Tatari'); return; }
    const level = adder.elements.level.value;
    const result = store.addStep(
      [...chosen].map(splitKey),
      level === '' ? null : Number(level),
      adder.elements.note.value
    );
    if (!result.ok) { toast(result.reason, 'error'); return; }
    resetAdder();
  });
}

/**
 * A finished step leaves the adder empty, ready for the next one. The store has
 * already re-rendered by the time this runs - adding a step is what triggered
 * it - so the cleared state needs painting again.
 */
function resetAdder() {
  chosen.clear();
  chosenLevel = null;
  adder.elements.note.value = '';
  renderAdder();
}

const makeKey = (slug, player) => `${player}:${slug}`;
const splitKey = (key) => {
  const i = key.indexOf(':');
  return { player: Number(key.slice(0, i)), slug: key.slice(i + 1) };
};

/** Adds a one-Tatari step at the next sensible level. Used by the + on grid tokens. */
export function quickAddStep(slug, player) {
  const level = store.suggestedLevel(slug, player);
  const name = state.bySlug.get(slug)?.name ?? slug;
  if (level === null) {
    toast(`${name} is already planned to level ${store.MAX_LEVEL}`);
    return;
  }
  const result = store.addStep([{ slug, player }], level);
  if (!result.ok) toast(result.reason, 'error');
  else {
    resetAdder();
    toast(`${name} to level ${level}`, 'ok');
  }
}

// ---------------------------------------------------------------- rendering

/**
 * Levels 1..MAX, plus "any". For a lone Tatari everything up to the level it is
 * already planned to reach is out of reach - the level-up passes through those
 * on the way. For a group the level is an instruction about whichever of them
 * comes up, so nothing is ruled out.
 */
function levelOptions(members, selected, { compact = false, ignoreIndex = -1 } = {}) {
  const reached = members.length === 1
    ? store.topLevel(members[0].slug, members[0].player, ignoreIndex) ?? 0
    : 0;

  const options = Array.from({ length: store.MAX_LEVEL }, (_, i) => i + 1)
    .map((level) => `<option value="${level}"${level === selected ? ' selected' : ''}${
      level <= reached && level !== selected ? ' disabled' : ''}>Lv ${level}</option>`);
  // A select is as wide as its longest option, and a step row has no width to
  // spare, so the label there is the short one.
  options.unshift(`<option value=""${selected === null ? ' selected' : ''}>${
    compact ? 'Any' : 'Any level'}</option>`);
  return options.join('');
}

/** The active player's Tatari on the field, in cell order. */
function levelable() {
  const player = store.formation.activePlayer;
  return store.allPlaced()
    .filter((occ) => !store.isCoop() || occ.player === player)
    .map(({ slug, player: p }) => ({
      key: makeKey(slug, p), slug, player: p,
      tatari: state.bySlug.get(slug),
      next: store.suggestedLevel(slug, p),
    })).filter((x) => x.tatari);
}

const nameOf = (m) => state.bySlug.get(m.slug)?.name ?? m.slug;

/**
 * What a step actually buys. Levels 3, 5 and 7 teach a new Horde skill, so a
 * step targeting one of them can say which — the reason to plan that level at
 * all. Only when every member learns the same thing, which is the usual case
 * within a line but not across one.
 */
function unlockedSkill(members, level) {
  if (![3, 5, 7].includes(level)) return null;
  const named = members.map((m) => state.bySlug.get(m.slug)?.hordeSkills?.[`level${level}`]);
  if (named.some((s) => !s?.name)) return null;
  const unique = [...new Set(named.map((s) => s.name))];
  return unique.length === 1 ? unique[0] : null;
}

/** "Sealing", "Sealing and Frugagon", "Sealing, Frugagon and 2 more". */
function summarize(members) {
  const names = members.map(nameOf);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function renderPlanTabs() {
  const coop = store.isCoop();
  tabsHost.hidden = !coop;
  if (!coop) return;

  tabsHost.innerHTML = store.players().map((player) => {
    const n = store.planFor(player).length;
    const active = player === store.formation.activePlayer;
    return `
      <button class="ptab" type="button" data-player="${player}"
              data-active="${active}" aria-pressed="${active}">
        <span class="ptab__who" data-player="${player}">P${player}</span>
        <span class="ptab__nums"><span><b>${n}</b> step${n === 1 ? '' : 's'}</span></span>
      </button>`;
  }).join('');
}

export function renderAdder() {
  const options = levelable();
  adder.hidden = options.length === 0;
  if (!options.length) { picker.innerHTML = ''; chosen.clear(); return; }

  const live = new Set(options.map((o) => o.key));
  for (const key of chosen) if (!live.has(key)) chosen.delete(key);

  picker.innerHTML = options.map(({ key, tatari, player, next }) => `
    <button class="step-pick" type="button" data-key="${esc(key)}"
            data-type="${tatari.type}" data-player="${player}"
            aria-pressed="${chosen.has(key)}"
            title="${esc(tatari.name)}${next === null ? ', planned to level 7 already' : ''}">
      ${artHTML(tatari)}
      ${next === null ? '<span class="step-pick__done">7</span>' : ''}
    </button>`).join('');

  const members = [...chosen].map(splitKey);
  const single = members.length === 1 ? members[0] : null;

  $('#step-adder-name').textContent = !members.length
    ? 'Pick one or more'
    : single ? nameOf(single) : `${members.length} selected · ${summarize(members)}`;
  adder.querySelector('[type="submit"]').disabled = members.length === 0;

  // One Tatari picks up where its own plan left off. A group has no such
  // sequence, so it starts at "any level" and the note does the talking.
  const suggested = single ? store.suggestedLevel(single.slug, single.player) : null;
  const value = chosenLevel !== null ? chosenLevel : suggested === null ? '' : String(suggested);

  const levelSelect = adder.elements.level;
  levelSelect.innerHTML = levelOptions(members, value === '' ? null : Number(value));
  levelSelect.value = value;
}

export function renderPriority() {
  renderPlanTabs();

  const visible = store.isCoop()
    ? store.planFor(store.formation.activePlayer)
    : store.formation.plan.map((step, index) => ({ step, index }));

  host.innerHTML = visible.map(({ step, index }, position) => {
    const members = step.members.filter((m) => state.bySlug.get(m.slug));
    if (!members.length) return '';
    const single = members.length === 1 ? members[0] : null;
    const lead = state.bySlug.get(members[0].slug);
    const ordinal = single ? nthForStep(index) : 0;
    const unlocks = unlockedSkill(members, step.level);

    /*
     * A step whose Tatari are brought but not standing anywhere.
     *
     * The plan outlives being taken off the field now, which is the point — but
     * a plan that looks identical whether or not it can happen is a plan you
     * cannot read. Inactive steps stay in place, keep their order and stay fully
     * interactable: you can still set the level, write the note, drag them
     * around. They are only drawn quieter, because the thing they describe is
     * not on the board at the moment.
     */
    const inactive = members.every((m) => !store.isPlaced(m.slug, m.player));

    /*
     * The element letter, the same one the field tokens carry.
     *
     * A plan step says which element it is the same single way a token used to:
     * the sprite's tint and the stripe down the note. Both are hue, and hue is
     * exactly what fails for the reader this is for — see elemGlyph in grid.js
     * for the measurements. Hidden by CSS unless High contrast is on.
     *
     * aria-hidden: the step's own label already names every member in full.
     */
    const arts = members.map((m) => `
      <span class="prio__art" data-type="${state.bySlug.get(m.slug).type}">
        ${artHTML(state.bySlug.get(m.slug))}
        <span class="prio__elem" aria-hidden="true">${state.bySlug.get(m.slug).type[0]}</span>
        ${single ? '' : `<button class="prio__artx" type="button"
                data-drop-member="${esc(m.slug)}" data-member-player="${m.player}"
                title="Take ${esc(nameOf(m))} out of this step"
                aria-label="Take ${esc(nameOf(m))} out of step ${position + 1}">&times;</button>`}
      </span>`).join('');

    return `
      <li class="prio${single ? '' : ' prio--group'}${step.note ? ' has-note' : ''}${
        inactive ? ' is-benched' : ''}"
          data-index="${index}" data-type="${lead.type}" data-player="${members[0].player}"
          tabindex="0" aria-label="${esc(stepLabel(step, members, position, visible.length))}${
        inactive ? ', on the bench' : ''}">
        <span class="prio__rank">${position + 1}</span>
        <span class="prio__arts">${arts}</span>
        <span class="prio__name">
          <span class="prio__label">${esc(summarize(members))}</span>
          ${ordinal > 1 ? `<span class="prio__repeat" title="${
            ordinal}${suffix(ordinal)} step for this Tatari">&times;${ordinal}</span>` : ''}
          ${unlocks ? `<span class="prio__unlock" title="Learns ${esc(unlocks)} at level ${
            step.level}">${esc(unlocks)}</span>` : ''}
        </span>
        <label class="prio__levelwrap">
          <span class="sr-only">Level for this step</span>
          <select class="prio__level field field--select">${
            levelOptions(members, step.level, { compact: true, ignoreIndex: index })}</select>
        </label>
        <button class="prio__notebtn" type="button" data-note-toggle
                aria-label="${step.note ? 'Edit the note on' : 'Add a note to'} step ${position + 1}"
                title="${step.note ? 'Edit note' : 'Add a note'}">&#9998;</button>
        <button class="prio__drop" type="button" data-drop-step
                aria-label="Remove step ${position + 1}">&times;</button>
        <input class="prio__note" type="text" maxlength="${store.MAX_NOTE}" autocomplete="off"
               value="${esc(step.note)}" placeholder="Add a note"
               aria-label="Note for step ${position + 1}">
      </li>`;
  }).join('');

  for (const li of host.children) {
    const index = Number(li.dataset.index);
    draggable(
      li,
      () => ({ index, from: 'plan' }),
      () => {
        const step = store.formation.plan[index];
        const t = state.bySlug.get(step.members[0].slug);
        return `<span class="prio prio--ghost" data-type="${t.type}">
          <span class="prio__art">${artHTML(t, { lazy: false })}</span>
          <span class="prio__label">${esc(summarize(step.members))}</span>
          <span class="prio__levelchip">${step.level === null ? 'Any' : `Lv ${step.level}`}</span>
          </span>`;
      }
    );
  }

  const total = visible.length;

  /*
   * A plan with no steps in it used to render as nothing at all.
   *
   * The panel kept its heading, its Clear steps button and the adder, and
   * between them an empty <ol>. Somebody who does not already know what a
   * level-up plan is for -- a stated intended user, not an edge case -- got a
   * form with no explanation of what filling it in would buy them.
   *
   * Two empty states, because there are two reasons to be here with nothing:
   * an empty field, where the answer is to go and place something, and a full
   * field where the answer is what a step is and why the order matters. The
   * adder hides itself in the first case, so this says the same thing the rest
   * of the panel is already saying rather than contradicting it.
   */
  if (!total) {
    const anyone = store.placedFor(store.formation.activePlayer).length
      || store.benchOf(store.formation.activePlayer).length;
    host.innerHTML = anyone
      ? `<li class="plan-empty">
          <p><b>No steps yet.</b> A step is one or more Tatari and the level you
            want them to reach.</p>
          <p>Energizers run out long before everyone is maxed, so the order you
            spend them in is most of the run. Pick somebody above to start one.</p>
        </li>`
      : `<li class="plan-empty">
          <p><b>Nothing to plan yet.</b> Bring some Tatari and put them on the
            field, and they will show up here to be ordered.</p>
        </li>`;
  }

  $('#step-count').textContent = total ? `${total} step${total === 1 ? '' : 's'}` : '';
  $('#btn-clear-plan').disabled = total === 0;
  renderAdder();
}

function stepLabel(step, members, position, total) {
  const who = members.map(nameOf).join(', ');
  const level = step.level === null ? 'no set level' : `level ${step.level}`;
  return `Step ${position + 1} of ${total}: ${who}, ${level}${step.note ? `. Note: ${step.note}` : ''}`;
}

/** How many times this one-Tatari step's subject has appeared up to `index`. */
function nthForStep(index) {
  const { slug, player } = store.formation.plan[index].members[0];
  let n = 0;
  for (let i = 0; i <= index; i++) {
    const s = store.formation.plan[i];
    if (s.members.length === 1 && s.members[0].slug === slug && s.members[0].player === player) n++;
  }
  return n;
}

const suffix = (n) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd'
  : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
