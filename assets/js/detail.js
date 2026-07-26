/** The per-Tatari detail sheet. */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast } from './ui.js';

const dialog = $('#detail');

export function openDetail(slug) {
  const t = state.bySlug.get(slug);
  if (!t) return;

  const chart = state.meta.typeChart[t.type] ?? {};
  const aliases = state.mergedAliases?.[t.family] ?? [];
  const player = store.formation.activePlayer;
  const benched = store.onBench(t.slug, player);
  const placed = store.isPlaced(t.slug, player);
  const who = store.isCoop() ? ` for P${player}` : '';

  dialog.innerHTML = `
    <div class="detail" data-type="${t.type}">
      <div class="detail__head">
        <span class="detail__art">${artHTML(t, { lazy: false })}</span>
        <div class="detail__title">
          <h2>${esc(t.name)}</h2>
          <div class="detail__tags">
            <span class="tag">${typeIcon(t.type)}${esc(t.type)}</span>
            <span class="tag">${roleIcon(t.role)}${esc(t.role)}</span>
            <span class="tag">T${t.tier} of ${t.stages}</span>
            <span class="tag">${esc(t.rarity)}</span>
            ${t.battleRow ? `<span class="tag">${esc(t.battleRow)} row</span>` : ''}
            ${t.custom ? '<span class="tag">Yours</span>' : ''}
          </div>
        </div>
      </div>

      <dl>
        ${t.skill ? `<dt>Skill</dt><dd>${esc(t.skill)}</dd>` : ''}
        <dt>Evolution</dt>
        <dd><div class="detail__line">${t.evolutionLine.map((n) => {
          const m = state.all.find((x) => x.name === n && x.familyId === t.familyId);
          return `<span class="detail__step" aria-current="${n === t.name}"
            data-deployed="${!!(m && store.onBench(m.slug, player))}">${esc(n)}</span>`;
        }).join('')}</div></dd>
        <dt>Matchups</dt>
        <dd>Strong against <b>${esc(chart.strongAgainst ?? '—')}</b>,
            weak to <b>${esc(chart.weakTo ?? '—')}</b>.</dd>
        ${t.etymology ? `<dt>Name</dt><dd>${esc(t.etymology)}</dd>` : ''}
        ${aliases.length ? `<dt>Also known as</dt><dd>${esc(aliases.join(', '))}</dd>` : ''}
        ${t.previousRole && t.previousRole !== 'Same' && t.previousRole !== 'None'
          ? `<dt>Previous role</dt><dd>${esc(t.previousRole)}</dd>` : ''}
        ${t.description ? `<dt>Flavour</dt><dd>${esc(t.description)}</dd>` : ''}
      </dl>

      <div class="modal__actions">
        ${placed
          ? `<button class="btn" type="button" data-act="unplace">Take off the field${who}</button>`
          : `<button class="btn btn--primary" type="button" data-act="place">Place on the field${who}</button>`}
        ${benched
          ? `<button class="btn btn--quiet" type="button" data-act="unbench">Stop bringing${who}</button>`
          : ''}
        ${t.wikiUrl ? `<a class="btn" href="${esc(t.wikiUrl)}" target="_blank" rel="noopener">Wiki page</a>` : ''}
        <button class="btn btn--quiet" type="button" data-close>Close</button>
      </div>
    </div>`;

  dialog.querySelector('[data-act="place"]')?.addEventListener('click', () => {
    const result = store.autoPlace(t.slug, player);
    if (!result.ok) toast(result.reason, 'error');
    else dialog.close();
  });
  dialog.querySelector('[data-act="unplace"]')?.addEventListener('click', () => {
    store.unplace(t.slug, player);
    dialog.close();
  });
  dialog.querySelector('[data-act="unbench"]')?.addEventListener('click', () => {
    store.removeFromBench(t.slug, player);
    dialog.close();
  });

  dialog.showModal();
}

// Close on backdrop click as well as the button and Escape.
dialog.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]') || e.target === dialog) dialog.close();
});
