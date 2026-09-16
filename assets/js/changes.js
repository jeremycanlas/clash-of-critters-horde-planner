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
import { buildAnalytics, track } from './analytics.js';
import { $, artHTML, esc } from './ui.js';

// Safe on import: it only reads localStorage and writes to <html>.
applyPrefs();

/*
 * Buffed first, then adjusted, then nerfed.
 *
 * Not alphabetical and not by size. An update is read for good news first, and
 * putting the nerfs last means the page does not open on a wall of red for
 * somebody who came to find out whether their team survived.
 */
const ORDER = [
  { key: 'buff', glyph: '↑', title: 'Buffed' },
  { key: 'adjusted', glyph: '±', title: 'Adjusted' },
  { key: 'nerf', glyph: '↓', title: 'Nerfed' },
];

/* `many` is explicit because Tatari does not take an s -- one Tatari, 230
   Tatari -- and the naive rule printed "135 Tataris" on the first render. */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tatariCount = (n) => plural(n, 'Tatari', 'Tatari');

/*
 * Which horde level teaches each skill, read off the wiki data rather than
 * written into the notes.
 *
 * The patch notes name a skill and give its numbers; they never say when you get
 * it, and that is half of what the reader needs -- a buff to a level 7 skill is
 * a different proposition from one to a level 3. tatari.json has the answer, so
 * the two are joined here.
 *
 * Matched by longest name first rather than by splitting on the first colon.
 * Skinklet's level 5 is called "Technique: Veil", and a naive split files it
 * under a skill named "Technique" that does not exist.
 */
function levelOf(head, text) {
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const skills = Object.entries(head?.hordeSkills ?? {})
    .map(([key, skill]) => ({ level: key.replace('level', ''), name: skill.name }))
    .sort((a, b) => b.name.length - a.name.length);
  return skills.find((s) => norm(text).startsWith(norm(s.name))) ?? null;
}

/*
 * Whether one stat moved in your favour, from the numbers alone.
 *
 * Higher is better nearly everywhere here -- damage, chance, shield, heal, count
 * -- so the rule is "up is good" with one documented exception: an interval or a
 * cooldown getting longer is worse, and that reverses it.
 *
 * Checked rather than assumed. Run over all 95 stat fragments in the current
 * file, this agrees with the editorial direction on the entry every time: every
 * fragment of a buffed line reads favourable, every fragment of a nerfed line
 * reads unfavourable, and Voltfawn -- the one adjusted line -- splits, which is
 * exactly what "adjusted" was recording. If a future patch breaks that
 * agreement, changestest.html says so rather than the page quietly lying.
 *
 * Anything without two readable numbers gets no verdict at all. The notes are
 * prose and a guess here would be a coloured arrow pointing the wrong way.
 */
const LOWER_IS_BETTER = /\b(interval|cooldown)\b/i;

export function movement(part) {
  const [before, after] = part.split('→');
  if (after === undefined) return null;
  const num = (x) => { const m = x.match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
  const a = num(before);
  const b = num(after);
  if (a === null || b === null || a === b) return null;
  const up = b > a;
  return (LOWER_IS_BETTER.test(part) ? !up : up) ? 'up' : 'down';
}

/**
 * One evolution family, as a card.
 *
 * Every member is drawn, not just the Tatari the notes named. Horde skills
 * belong to the line, so "Frostnip was buffed" is really "these four were
 * buffed", and a reader hunting for the sprite they actually field should find
 * it without knowing which T1 it grows from.
 */
function line(entry) {
  const members = (entry.members ?? [])
    .map((slug) => state.bySlug.get(slug))
    .filter(Boolean);
  const head = members[0];

  const art = members.map((t) => `
    <span class="chline__art" data-type="${t.type}" title="${esc(t.name)}">
      ${artHTML(t)}
      <span class="chline__tier">T${t.tier}</span>
    </span>`).join('');

  const changes = (entry.changes ?? []).map((text) => {
    const skill = levelOf(head, text);
    const rest = skill ? text.slice(skill.name.length).replace(/^\s*:\s*/, '') : text;
    /*
     * One stat per line. The notes pack several into a sentence -- "Damage 160%
     * -> 200%, extra bomb 40% -> 55%, Blind 30% -> 40%" -- and read as prose
     * that way, which is the wrong shape for something scanned. Split on the
     * comma and each number gets its own row and its own verdict.
     */
    const stats = rest.split(/,\s+/).map((part) => {
      const move = movement(part);
      return `
        <li class="chstat" ${move ? `data-move="${move}"` : ''}>
          <span class="chstat__mark" aria-hidden="true"></span>
          <span class="chstat__text">${esc(part)}</span>
        </li>`;
    }).join('');

    return `
      <li class="chline__change">
        <span class="chline__skill">
          ${skill ? `<span class="chline__lv" title="Taught at horde level ${skill.level}"
            >L${skill.level}</span>` : ''}${esc(skill ? skill.name : text)}
        </span>
        <ul class="chline__stats">${stats}</ul>
      </li>`;
  }).join('');

  return `
    <article class="chline" data-patch="${entry.direction}" data-type="${head?.type ?? ''}">
      <header class="chline__head">
        <div class="chline__arts">${art}</div>
        <h3 class="chline__name">${esc(members.map((t) => t.name).join(' → ') || entry.line)}</h3>
      </header>
      <ul class="chline__changes">${changes}</ul>
    </article>`;
}

function render(book) {
  const lines = book.lines ?? [];
  const patch = book.label || book.patch || '';
  document.title = patch ? `Horde Drafter: What changed in the ${patch} update` : document.title;
  $('#changes-patch').textContent = patch;

  /* Whoever read these off the game, named on the tab their reading is on. */
  const credit = $('#changes-credit');
  credit.hidden = !book.by;
  credit.textContent = book.by ? `Read off the game and shared by ${book.by}.` : '';

  if (!lines.length) {
    $('#changes-mode').innerHTML = '';
    $('#changes-intro').textContent =
      'No update is being tracked right now. When the next patch notes land, what they '
      + 'moved will be listed here.';
    return;
  }

  /*
   * No standing paragraph. It used to open with a sentence restating the date
   * already in the header and the counts already on every group heading, and
   * "The 26 August 2026 update rebalanced..." is the kind of line a reader skips
   * on the way to the thing they came for. The date is in the header; the
   * numbers are three lines down; the way back to the drafter is a button.
   *
   * The element stays for the case where there is nothing to show, which is the
   * only time this page needs to say anything in prose.
   */
  $('#changes-intro').textContent = '';

  /*
   * What the update did to the mode, before what it did to any Tatari.
   *
   * The cards below answer "is mine still good", which is the second question.
   * The first is "what am I walking into" -- seasons, difficulties, a three-hour
   * window instead of two -- and somebody arriving from a Discord link on patch
   * morning wants that before they want 35 families of numbers.
   *
   * Trimmed from the full notes by hand, like everything else here. An update
   * covers the farm, the bento maker and the spinwheel too; none of that is
   * anything this tool models, so none of it is repeated here.
   */
  const mode = book.mode?.groups ?? [];
  $('#changes-mode').innerHTML = !mode.length ? '' : `
    <h2 class="chmode__head">The mode itself</h2>
    <div class="chmode__groups">
      ${mode.map((g) => `
        <section class="chmode__group">
          <h3 class="chmode__title">${esc(g.title)}</h3>
          <ul class="chmode__list">
            ${(g.items ?? []).map((item) => `<li>${esc(item)}</li>`).join('')}
          </ul>
        </section>`).join('')}
    </div>`;

  $('#changes-body').innerHTML = ORDER.map(({ key, glyph, title }) => {
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
        <div class="chgroup__grid">${group.map(line).join('')}</div>
      </section>`;
  }).join('');
}

/*
 * Only render when this really is the page.
 *
 * movement() is exported so changestest.html can check its verdicts against the
 * editorial direction on each entry, and importing a module runs everything at
 * its top level. Without this guard the test page loaded the whole roster and
 * then threw on the first element that only exists in changes.html.
 */
/**
 * The tab strip, and which set of notes is on screen.
 *
 * One file, two sets of notes: the live patch at the top level, where data.js
 * and the roster read it, and anything not live yet under `preview`. Keeping the
 * live one exactly where it was is the whole point of that shape -- the drafter
 * needed no change at all, and a preview can never leak into the markers on a
 * card by being in the wrong place in the file.
 *
 * With nothing to preview the nav stays hidden and the page is what it was.
 */
function mount(book) {
  const books = [book, book.preview].filter((b) => b?.lines?.length);
  const tabs = $('#changes-tabs');

  /*
   * Fixed labels, not the tab's own text.
   *
   * analytics.js only ever sends a short list of labels written into this repo,
   * and a label built from a data file would quietly widen that the first time
   * a set of notes was named after something it should not be. "live" and
   * "preview" are the two things worth telling apart anyway: what is counted is
   * whether anybody reads notes that have not shipped, not which month it is.
   */
  const kind = (b) => (b.provisional ? 'preview' : 'live');

  if (books.length < 2) {
    tabs.hidden = true;
    track(`changes-open-${kind(book)}`);
    render(book);
    return;
  }

  tabs.hidden = false;
  /* .segmented is the app's tab strip already, and it already styles
     aria-selected. A second control that looked almost like it would be one
     more thing to keep in step with the theme. */
  tabs.innerHTML = books.map((b, i) => `
    <button class="segmented__btn" type="button" role="tab" data-i="${i}"
      aria-selected="${i === 0}">${esc(b.label || b.patch || 'Update')}${
  b.provisional ? '<span class="chtab__flag">preview</span>' : ''}</button>`).join('');

  /*
   * Each tab has an address.
   *
   * The same argument the community gallery makes for giving one formation a
   * URL: a tab you cannot link to is a tab nobody can send anybody. Patch
   * mornings happen in Discord, and "look at Season 2" has to be a link rather
   * than a link plus an instruction to press the second tab.
   *
   * Written with replaceState rather than by assigning location.hash, so
   * switching tabs does not stack up history the Back button has to walk out of.
   */
  const slug = (b) => (b.label || b.patch || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  /*
   * `clicked` separates the two questions a shared link raises.
   *
   * "changes-open-preview" is somebody arriving on #season-2 because that is
   * the link they were given; "changes-tab-preview" is somebody who arrived on
   * the live notes and went looking. Counting both under one label would make a
   * link that got passed around look like a tab that got discovered, and those
   * call for opposite things.
   */
  const show = (i, clicked) => {
    for (const t of tabs.querySelectorAll('.segmented__btn')) {
      t.setAttribute('aria-selected', String(Number(t.dataset.i) === i));
    }
    track(`changes-${clicked ? 'tab' : 'open'}-${kind(books[i])}`);
    render(books[i]);
    if (clicked) history.replaceState(null, '', i ? `#${slug(books[i])}` : location.pathname);
  };

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented__btn');
    if (!btn) return;
    show(Number(btn.dataset.i), true);
    /* Back to the top of the notes, not wherever the last tab was scrolled to.
       Switching tabs and landing halfway down a different update reads as the
       page having jumped on its own. */
    $('#changes-body').scrollIntoView({ block: 'start', behavior: 'auto' });
  });

  const wanted = books.findIndex((b) => `#${slug(b)}` === location.hash);
  show(wanted > 0 ? wanted : 0, false);
}

if ($('#changes-body')) {
  /* Before mount(), which counts which tab the page opened on. Off the
     published site this does nothing and every track() below is a no-op. */
  buildAnalytics();
  await load();
  const book = await fetch('data/changes.json')
    .then((r) => r.json())
    // A copy without the file still renders the page and says so, the same way
    // the drafter simply marks nothing.
    .catch(() => ({ lines: [] }));
  mount(book);
}
