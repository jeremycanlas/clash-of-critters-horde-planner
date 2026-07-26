/**
 * The level-up plan: an ordered list of "take this Tatari to level N" steps.
 *
 * Horde offers three cards each round and any of them may be a level-up for
 * something already on the field, so the useful artefact is a running sequence
 * you read top-down mid-run. A Tatari appears once per level it should hit, so a
 * plan legitimately reads: Sealing 3, Cheerling 3, Frugagon 3, Sealing 5.
 *
 * In co-op the plan covers both players, and every step is badged with its owner.
 */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';

const host = $('#priority');
const adder = $('#step-adder');
const picker = $('#step-picker');

/** `player:slug` of the Tatari selected in the adder. */
let chosen = null;

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
    const select = e.target.closest('.prio__level');
    if (!select) return;
    const index = Number(select.closest('.prio').dataset.index);
    const result = store.setStepLevel(index, Number(select.value));
    if (!result.ok) { toast(result.reason, 'error'); renderPriority(); }
  });

  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-drop-step]');
    if (btn) store.removeStep(Number(btn.closest('.prio').dataset.index));
  });

  host.addEventListener('keydown', (e) => {
    const li = e.target.closest('.prio');
    if (!li || !(e.ctrlKey || e.metaKey)) return;
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    const from = Number(li.dataset.index);
    store.moveStep(from, from + delta);
    requestAnimationFrame(() => host.querySelector(`[data-index="${from + delta}"]`)?.focus());
  });

  picker.addEventListener('click', (e) => {
    const opt = e.target.closest('.step-pick');
    if (!opt || opt.disabled) return;
    chosen = opt.dataset.key;
    renderAdder();
  });

  adder.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!chosen) { toast('Pick a Tatari first'); return; }
    const [player, slug] = splitKey(chosen);
    const result = store.addStep(slug, Number(adder.elements.level.value), player);
    if (!result.ok) toast(result.reason, 'error');
    // `chosen` is left alone, so repeated Add walks the same Tatari up a level
    // at a time - renderAdder advances the offered level.
  });
}

const makeKey = (slug, player) => `${player}:${slug}`;
const splitKey = (key) => { const i = key.indexOf(':'); return [Number(key.slice(0, i)), key.slice(i + 1)]; };

/** Adds a step at the next sensible level. Used by the + on grid tokens. */
export function quickAddStep(slug, player) {
  const level = store.suggestedLevel(slug, player);
  const name = state.bySlug.get(slug)?.name ?? slug;
  if (level === null) {
    toast(`${name} is already planned to level ${store.MAX_LEVEL}`);
    return;
  }
  const result = store.addStep(slug, level, player);
  if (!result.ok) toast(result.reason, 'error');
  else {
    chosen = makeKey(slug, player);
    toast(`${name} to level ${level}`, 'ok');
  }
}

// ---------------------------------------------------------------- rendering

function levelOptions(slug, player, selected) {
  const taken = new Set(store.plannedLevels(slug, player));
  taken.delete(selected);
  return Array.from({ length: store.MAX_LEVEL }, (_, i) => i + 1)
    .map((level) => `<option value="${level}"${level === selected ? ' selected' : ''}${
      taken.has(level) ? ' disabled' : ''}>Lv ${level}</option>`)
    .join('');
}

/** Everything on the field, in cell order, across both players. */
function levelable() {
  return store.allPlaced().map(({ slug, player }) => ({
    key: makeKey(slug, player), slug, player,
    tatari: state.bySlug.get(slug),
    next: store.suggestedLevel(slug, player),
  })).filter((x) => x.tatari);
}

export function renderAdder() {
  const options = levelable();
  adder.hidden = options.length === 0;
  if (!options.length) { picker.innerHTML = ''; return; }

  if (!options.some((o) => o.key === chosen)) {
    chosen = (options.find((o) => o.next !== null) ?? options[0]).key;
  }
  const current = options.find((o) => o.key === chosen);

  picker.innerHTML = options.map(({ key, tatari, player, next }) => `
    <button class="step-pick" type="button" role="radio" data-key="${esc(key)}"
            data-type="${tatari.type}" data-player="${player}"
            aria-checked="${key === chosen}" ${next === null ? 'disabled' : ''}
            title="${esc(tatari.name)}${store.isCoop() ? ` (P${player})` : ''}${
              next === null ? ' — planned to level 7 already' : ''}">
      ${artHTML(tatari)}
      ${store.isCoop() ? `<span class="step-pick__owner" data-player="${player}">${player}</span>` : ''}
      ${next === null ? '<span class="step-pick__done">7</span>' : ''}
    </button>`).join('');

  adder.elements.slug.value = current.slug;
  $('#step-adder-name').textContent = store.isCoop()
    ? `${current.tatari.name} · P${current.player}`
    : current.tatari.name;

  const levelSelect = adder.elements.level;
  levelSelect.innerHTML = levelOptions(current.slug, current.player,
    current.next ?? store.MAX_LEVEL);
  levelSelect.disabled = current.next === null;
  adder.querySelector('[type="submit"]').disabled = current.next === null;
}

export function renderPriority() {
  const total = store.formation.plan.length;

  host.innerHTML = store.formation.plan.map((step, i) => {
    const t = state.bySlug.get(step.slug);
    if (!t) return '';
    const cell = store.cellOf(step.slug, step.player);
    const ordinal = nthForStep(i);
    const who = store.isCoop() ? ` for player ${step.player}` : '';
    return `
      <li class="prio" data-index="${i}" data-type="${t.type}" data-player="${step.player}"
          tabindex="0"
          aria-label="Step ${i + 1} of ${total}: ${esc(t.name)}${who} to level ${step.level}">
        <span class="prio__rank">${i + 1}</span>
        <span class="prio__art">${artHTML(t)}</span>
        <span class="prio__name">
          ${store.isCoop() ? `<span class="prio__owner" data-player="${step.player}">P${step.player}</span>` : ''}
          <span class="prio__label">${esc(t.name)}</span>
          ${ordinal > 1 ? `<span class="prio__repeat" title="${
            ordinal}${suffix(ordinal)} step for this Tatari">&times;${ordinal}</span>` : ''}
        </span>
        <label class="prio__levelwrap">
          <span class="sr-only">Level for ${esc(t.name)}</span>
          <select class="prio__level field field--select">${
            levelOptions(step.slug, step.player, step.level)}</select>
        </label>
        <span class="prio__meta">
          ${typeIcon(t.type)}${roleIcon(t.role)}
          <span class="prio__cell">${cell === null ? '—'
            : `R${store.cellRow(cell) + 1}C${store.cellCol(cell) + 1}`}</span>
        </span>
        <button class="prio__drop" type="button" data-drop-step
                aria-label="Remove step ${i + 1}">&times;</button>
        <span class="prio__grip" aria-hidden="true">&middot;&middot;&middot;</span>
      </li>`;
  }).join('');

  for (const li of host.children) {
    const index = Number(li.dataset.index);
    draggable(
      li,
      () => ({ index, from: 'plan' }),
      () => {
        const step = store.formation.plan[index];
        const t = state.bySlug.get(step.slug);
        return `<span class="prio prio--ghost" data-type="${t.type}">
          <span class="prio__art">${artHTML(t, { lazy: false })}</span>
          <span class="prio__label">${esc(t.name)}</span>
          <span class="prio__levelchip">Lv ${step.level}</span></span>`;
      }
    );
  }

  $('#step-count').textContent = total ? `${total} step${total === 1 ? '' : 's'}` : '';
  $('#btn-clear-plan').disabled = total === 0;
  renderAdder();
}

/** How many times this (Tatari, player) has appeared up to and including `index`. */
function nthForStep(index) {
  const { slug, player } = store.formation.plan[index];
  let n = 0;
  for (let i = 0; i <= index; i++) {
    const s = store.formation.plan[i];
    if (s.slug === slug && s.player === player) n++;
  }
  return n;
}

const suffix = (n) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd'
  : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
