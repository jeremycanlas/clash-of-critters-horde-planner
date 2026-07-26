/**
 * Level-up priority: the order to spend Horde level-up offers in.
 *
 * Horde offers three cards each round and any of them may be a level-up for
 * something already deployed, so the useful artefact is a ranked list you can
 * read top-down mid-run.
 */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast } from './ui.js';
import { draggable, dropZone } from './dnd.js';

const host = $('#priority');

/** Front-line first: they have to survive for anything behind them to matter. */
const ROLE_WEIGHT = { Tank: 0, Guardian: 1, Healer: 2, Support: 3, DPS: 4, Specialist: 5 };

export function buildPriority() {
  dropZone({
    selector: '.prio',
    // Grid tokens can be dropped here too — same set of Tatari, so it just
    // reorders rather than placing anything new.
    accepts: (target, payload) =>
      store.cellOf(payload.slug) !== null && target.dataset.slug !== payload.slug,
    onHover: (target, ok) => target.classList.toggle('is-over', ok),
    onDrop: (target, payload) => {
      const to = store.formation.priority.indexOf(target.dataset.slug);
      if (to !== -1) store.reprioritize(payload.slug, to);
    },
  });

  $('#btn-priority-auto').addEventListener('click', suggestOrder);
}

/**
 * Sorts by role (survivability first), then by how far forward a Tatari sits —
 * whatever is closest to the enemy needs the levels soonest.
 */
function suggestOrder() {
  const deployed = store.deployedSlugs();
  if (!deployed.length) { toast('Nothing deployed yet'); return; }

  const ordered = deployed
    .map((slug) => ({ slug, t: state.bySlug.get(slug), row: store.cellRow(store.cellOf(slug)) }))
    .sort((a, b) =>
      (ROLE_WEIGHT[a.t.role] ?? 9) - (ROLE_WEIGHT[b.t.role] ?? 9) ||
      a.row - b.row ||
      a.t.name.localeCompare(b.t.name))
    .map((x) => x.slug);

  ordered.forEach((slug, i) => store.reprioritize(slug, i));
  toast('Ordered by role, then how far forward they sit', 'ok');
}

export function renderPriority() {
  host.innerHTML = store.formation.priority.map((slug, i) => {
    const t = state.bySlug.get(slug);
    if (!t) return '';
    const cell = store.cellOf(slug);
    return `
      <li class="prio" data-slug="${esc(slug)}" data-type="${t.type}" tabindex="0"
          aria-label="${esc(t.name)}, priority ${i + 1} of ${store.formation.priority.length}">
        <span class="prio__rank">${i + 1}</span>
        <span class="prio__art">${artHTML(t)}</span>
        <span class="prio__name">${esc(t.name)}</span>
        <span class="prio__meta">
          ${typeIcon(t.type)}${roleIcon(t.role)}
          <span class="prio__cell">R${store.cellRow(cell) + 1}C${store.cellCol(cell) + 1}</span>
        </span>
        <span class="prio__grip" aria-hidden="true">···</span>
      </li>`;
  }).join('');

  for (const li of host.children) {
    draggable(
      li,
      () => ({ slug: li.dataset.slug, from: 'priority' }),
      () => `<span class="prio prio--ghost" data-type="${li.dataset.type}">${
        li.querySelector('.prio__art').outerHTML}<span class="prio__name">${
        esc(state.bySlug.get(li.dataset.slug)?.name ?? '')}</span></span>`
    );
  }
}

/** Ctrl/Cmd + arrow nudges an entry up or down the list. */
host.addEventListener('keydown', (e) => {
  const li = e.target.closest('.prio');
  if (!li || !(e.ctrlKey || e.metaKey)) return;
  const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
  if (!delta) return;
  e.preventDefault();
  const slug = li.dataset.slug;
  const from = store.formation.priority.indexOf(slug);
  store.reprioritize(slug, from + delta);
  requestAnimationFrame(() => host.querySelector(`[data-slug="${slug}"]`)?.focus());
});
