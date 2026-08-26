/**
 * Everything the last game update did, on one page you can send somebody.
 *
 * The drafter already marks the 135 affected Tatari and lets you filter to them,
 * which answers "is the one I am using still good". This answers the other
 * question, the one asked once on the morning a patch lands: what moved, and by
 * how much. That reading is done in a different posture -- scrolling, not
 * drafting -- and by people who may not have the tool open at all, which is why
 * it is a page with its own address rather than a sheet inside the app.
 *
 * Everything here comes from data/changes.json. No numbers are computed and
 * none are inferred: the file is read from the developers' patch notes by hand,
 * and this only groups and prints it.
 */

import { load, state } from './data.js';
import { applyPrefs } from './prefs.js';
import { $, artHTML, esc } from './ui.js';

applyPrefs();

/*
 * Buffed first, then adjusted, then nerfed.
 *
 * Not alphabetical and not by size. An update is read for good news first, and
 * putting the nerfs last means the page does not open on a wall of red for
 * somebody who came to find out whether their team survived.
 */
const ORDER = [
  { key: 'buff', glyph: '↑', title: 'Buffed', blurb: 'Every number moved in your favour.' },
  { key: 'adjusted', glyph: '±', title: 'Adjusted', blurb: 'Some numbers up, some down.' },
  { key: 'nerf', glyph: '↓', title: 'Nerfed', blurb: 'Every number moved against you.' },
];

/* `many` is explicit because Tatari does not take an s -- one Tatari, 230
   Tatari -- and the naive rule printed "135 Tataris" on the first render. */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tatariCount = (n) => plural(n, 'Tatari', 'Tatari');

/**
 * One evolution family, with its art.
 *
 * Every member is drawn, not just the one the notes named. Horde skills belong
 * to the line, so "Frostnip was buffed" is really "these four were buffed", and
 * a reader scanning for the sprite they actually field should find it here
 * rather than have to know which T1 it grows from.
 */
function line(entry) {
  const members = (entry.members ?? [])
    .map((slug) => state.bySlug.get(slug))
    .filter(Boolean);

  const art = members.map((t) => `
    <span class="chline__art" data-type="${t.type}" title="${esc(t.name)}">
      ${artHTML(t)}
      <span class="chline__tier">T${t.tier}</span>
    </span>`).join('');

  /*
   * The skill name and its numbers are split apart, because they are read
   * differently: you scan the left column for a skill you use and only then
   * read the right. Anything without a colon is printed whole rather than
   * guessed at -- the notes are prose and not every line is name-then-change.
   */
  const changes = (entry.changes ?? []).map((text) => {
    const at = text.indexOf(':');
    if (at < 0) return `<li class="chline__change"><span class="chline__what">${esc(text)}</span></li>`;
    return `<li class="chline__change">
      <span class="chline__skill">${esc(text.slice(0, at))}</span>
      <span class="chline__what">${esc(text.slice(at + 1).trim())}</span>
    </li>`;
  }).join('');

  return `
    <article class="chline" data-patch="${entry.direction}">
      <div class="chline__arts">${art}</div>
      <div class="chline__body">
        <h3 class="chline__name">${esc(members.map((t) => t.name).join(' → ') || entry.line)}</h3>
        <ul class="chline__changes">${changes}</ul>
      </div>
    </article>`;
}

function render(book) {
  const lines = book.lines ?? [];
  const patch = book.label || book.patch || '';
  document.title = patch ? `Horde Drafter: What changed in the ${patch} update` : document.title;
  $('#changes-patch').textContent = patch;

  if (!lines.length) {
    $('#changes-intro').textContent =
      'No update is being tracked right now. When the next patch notes land, what they '
      + 'moved will be listed here.';
    return;
  }

  const tatari = lines.reduce((n, l) => n + (l.members?.length ?? 0), 0);
  $('#changes-intro').innerHTML =
    `The ${esc(patch)} update rebalanced the Horde Invasion skills of `
    + `<b>${plural(lines.length, 'evolution line')}</b>, which is `
    + `<b>${tatariCount(tatari)}</b> of the ${state.all.length} in the roster. `
    + `Horde skills belong to the whole line, so every member of a family moves together. `
    + `<a href="index.html">The drafter</a> marks these on the roster and can filter to them.`;

  $('#changes-body').innerHTML = ORDER.map(({ key, glyph, title, blurb }) => {
    const group = lines.filter((l) => l.direction === key);
    if (!group.length) return '';
    const members = group.reduce((n, l) => n + (l.members?.length ?? 0), 0);
    return `
      <section class="chgroup" data-patch="${key}">
        <h2 class="chgroup__head">
          <span class="chgroup__mark" data-patch="${key}" data-glyph="${glyph}" aria-hidden="true"></span>
          ${title}
          <span class="chgroup__count">${plural(group.length, 'line')}, ${tatariCount(members)}</span>
        </h2>
        <p class="chgroup__blurb">${blurb}</p>
        ${group.map(line).join('')}
      </section>`;
  }).join('');
}

await load();
const book = await fetch('data/changes.json')
  .then((r) => r.json())
  // A copy without the file still renders the page and says so, the same way the
  // drafter simply marks nothing.
  .catch(() => ({ lines: [] }));
render(book);
