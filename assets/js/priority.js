/**
 * The level-up plan: an ordered list of "take this Tatari to level N" steps.
 *
 * Horde offers three cards each round and any of them may be a level-up for
 * something already deployed, so the useful artefact is a running sequence you
 * read top-down mid-run. A Tatari appears once per level it should hit, so a
 * plan legitimately reads: Sealing 3, Cheerling 3, Frugagon 3, Sealing 5.
 */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';

const host = $('#priority');
const adder = $('#step-adder');

export function buildPriority() {
  dropZone({
    selector: '.prio',
    accepts: (target, payload) =>
      payload.from === 'plan' && Number(target.dataset.index) !== payload.index,
    onHover: (target, ok) => target.classList.toggle('is-over', ok),
    onDrop: (target, payload) => store.moveStep(payload.index, Number(target.dataset.index)),
  });

  // Level select and remove button, delegated so re-renders need no rebinding.
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

  adder.addEventListener('submit', (e) => {
    e.preventDefault();
    const slug = adder.elements.slug.value;
    const level = Number(adder.elements.level.value);
    if (!slug) { toast('Pick a Tatari first'); return; }
    const result = store.addStep(slug, level);
    if (!result.ok) { toast(result.reason, 'error'); return; }
    // Keep the same Tatari selected and advance to its next unplanned level, so
    // laying out 1-2-3-4 for one critter is four clicks of Add.
    renderAdder(slug);
  });

  adder.elements.slug.addEventListener('change', (e) => renderAdder(e.target.value));
}

/** Adds a step for `slug` at its next unplanned level. Used by the grid tokens. */
export function quickAddStep(slug) {
  const level = store.suggestedLevel(slug);
  if (level === null) {
    toast(`${state.bySlug.get(slug)?.name ?? slug} is already planned to level ${store.MAX_LEVEL}`);
    return;
  }
  const result = store.addStep(slug, level);
  if (!result.ok) toast(result.reason, 'error');
  else toast(`${state.bySlug.get(slug).name} to level ${level}`, 'ok');
}

// ---------------------------------------------------------------- rendering

function levelOptions(slug, selected) {
  const taken = new Set(store.plannedLevels(slug));
  taken.delete(selected);
  return Array.from({ length: store.MAX_LEVEL }, (_, i) => i + 1)
    .map((level) => `<option value="${level}"${level === selected ? ' selected' : ''}${
      taken.has(level) ? ' disabled' : ''}>Lv ${level}</option>`)
    .join('');
}

export function renderAdder(keepSlug) {
  const deployed = store.deployedSlugs();
  const slugSelect = adder.elements.slug;
  const levelSelect = adder.elements.level;

  adder.hidden = deployed.length === 0;
  if (!deployed.length) return;

  const wanted = deployed.includes(keepSlug) ? keepSlug
    : deployed.includes(slugSelect.value) ? slugSelect.value
      : deployed.find((s) => store.suggestedLevel(s) !== null) ?? deployed[0];

  slugSelect.innerHTML = deployed.map((slug) => {
    const t = state.bySlug.get(slug);
    const done = store.suggestedLevel(slug) === null;
    return `<option value="${esc(slug)}"${slug === wanted ? ' selected' : ''}${
      done ? ' disabled' : ''}>${esc(t?.name ?? slug)}${done ? ' (maxed)' : ''}</option>`;
  }).join('');

  const next = store.suggestedLevel(wanted);
  levelSelect.innerHTML = levelOptions(wanted, next ?? store.MAX_LEVEL);
  levelSelect.disabled = next === null;
  adder.querySelector('[type="submit"]').disabled = next === null;
}

export function renderPriority() {
  const total = formationSteps();

  host.innerHTML = store.formation.plan.map((step, i) => {
    const t = state.bySlug.get(step.slug);
    if (!t) return '';
    const cell = store.cellOf(step.slug);
    const ordinal = nthForSlug(i);
    return `
      <li class="prio" data-index="${i}" data-type="${t.type}" tabindex="0"
          aria-label="Step ${i + 1} of ${total}: ${esc(t.name)} to level ${step.level}">
        <span class="prio__rank">${i + 1}</span>
        <span class="prio__art">${artHTML(t)}</span>
        <span class="prio__name">${esc(t.name)}${
          ordinal > 1 ? `<span class="prio__repeat" title="${
            ordinal}${suffix(ordinal)} step for this Tatari">&times;${ordinal}</span>` : ''}</span>
        <label class="prio__levelwrap">
          <span class="sr-only">Level for ${esc(t.name)}</span>
          <select class="prio__level field field--select">${levelOptions(step.slug, step.level)}</select>
        </label>
        <span class="prio__meta">
          ${typeIcon(t.type)}${roleIcon(t.role)}
          <span class="prio__cell">R${store.cellRow(cell) + 1}C${store.cellCol(cell) + 1}</span>
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
          <span class="prio__name">${esc(t.name)}</span>
          <span class="prio__levelchip">Lv ${step.level}</span></span>`;
      }
    );
  }

  $('#step-count').textContent = total
    ? `${total} step${total === 1 ? '' : 's'}`
    : '';
  renderAdder();
}

const formationSteps = () => store.formation.plan.length;

/** How many times this Tatari has appeared up to and including `index`. */
function nthForSlug(index) {
  const { slug } = store.formation.plan[index];
  let n = 0;
  for (let i = 0; i <= index; i++) if (store.formation.plan[i].slug === slug) n++;
  return n;
}

const suffix = (n) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd'
  : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
