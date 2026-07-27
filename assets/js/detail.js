/** The per-Tatari detail sheet. */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast } from './ui.js';
import { groupOf, helpFor } from './effects.js';

const dialog = $('#detail');

/**
 * What this Tatari learns as it levels in Horde, which is the whole point of
 * the level plan: 3, 5 and 7 are the levels that actually change how it fights.
 * The wiki records these per evolution line rather than per form.
 */
function hordeSkills(t) {
  if (!t.hordeSkills) {
    return `<p class="hint detail__pending">The wiki has not documented the
      ${esc(t.family)} line's Horde level-up skills yet.</p>`;
  }
  const rows = [3, 5, 7].map((level) => {
    const skill = t.hordeSkills[`level${level}`];
    if (!skill) return '';
    return `
      <li class="learn">
        <span class="learn__level">Lv ${level}</span>
        <span class="learn__body">
          ${skill.name ? `<b>${esc(skill.name)}</b> ` : ''}${esc(skill.text)}
        </span>
      </li>`;
  }).join('');

  return `
    <h3 class="detail__heading">Horde level-up skills</h3>
    <ul class="learns">${rows}</ul>
    <p class="hint detail__note">Shared by the whole ${esc(t.family)} line.</p>`;
}

/**
 * The wiki documents range as an in-game screenshot with the reachable tiles lit
 * up, so it is shown as one. Turning those into a grid overlay is not something
 * the source supports: they are photographs at assorted zooms with UI on top.
 */
function rangeDiagram(t) {
  if (!t.rangeImage) return '';
  return `
    <h3 class="detail__heading">Attack range</h3>
    <figure class="rangefig">
      <img src="${esc(t.rangeImage)}" alt="${esc(t.name)}'s attack range in game"
           loading="lazy" decoding="async">
      <figcaption class="hint">${esc(t.name)} stands at the bottom; the lit tiles
        are what it can reach. Screenshot from the wiki.</figcaption>
    </figure>`;
}

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

      ${hordeSkills(t)}
      ${rangeDiagram(t)}

      <dl>
        ${t.skill ? `<dt>Base skill</dt><dd>${esc(t.skill)}
          ${t.skillTypes?.length ? `<div class="detail__effects">${t.skillTypes.map((x) => {
    // The wiki's own definition, where its category page has one.
    const help = helpFor(x);
    return `<span class="tally tally--effect" data-effect="${groupOf(x)}"${
      help ? ` title="${esc(help)}"` : ''}>${esc(x)}</span>`;
  }).join('')}</div>` : ''}</dd>` : ''}
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
