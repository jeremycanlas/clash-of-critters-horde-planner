/**
 * The Skill data page. Its content is static HTML written by
 * tools/skills-page.mjs; this only chooses what shows: one line and one tier
 * of it in the Lines view, the filtered and sorted table in Rankings. With
 * script off every line, tier and row is simply on the page, stacked.
 *
 * The address is the state: skills.html#cribking opens that Tatari, and
 * skills.html#rankings the table, so a link a guide gives lands where it meant.
 */
import { applyPrefs } from './prefs.js';
import { buildAnalytics, trackOnce } from './analytics.js';
import { $, $$ } from './ui.js';

applyPrefs();
buildAnalytics();

const app = $('#sk-app');
const find = $('#sk-find');
const tbody = $('#sk-rows');
const wide = matchMedia('(min-width: 900px)');
app.classList.add('is-live');
app.dataset.pane = 'list';

let type = '';
let tier = '';
let tag = '';
let current = '';    // the slug open in the Lines view
let pushed = false;  // whether the open line is a history entry this page added

const press = (group, on) => { for (const b of group) b.setAttribute('aria-pressed', String(b === on)); };

function setView(view) {
  app.dataset.view = view;
  press($$('#sk-views [data-view]'), $(`#sk-views [data-view="${view}"]`));
  filter();
}

/* Open one Tatari: its line, that tier, and the line's entry in the list. */
function open(slug) {
  const el = slug ? document.getElementById(slug) : null;
  if (!el?.classList.contains('sk-tier')) return false;
  const line = el.closest('.sk-line');
  for (const l of $$('.sk-line.is-on')) l.classList.remove('is-on');
  line.classList.add('is-on');
  for (const t of $$('.sk-tier', line)) t.classList.toggle('is-on', t === el);
  for (const b of $$('.sk-switch__btn', line)) b.setAttribute('aria-pressed', String(b.dataset.slug === slug));
  for (const a of $$('.sk-pick')) {
    if (a.dataset.line === line.id) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  }
  // Keep the line's entry in sight in the list's own scroll, on a wide screen.
  const pick = $(`.sk-pick[aria-current="true"]`);
  const list = $('.sk-index');
  if (pick && wide.matches && list.scrollHeight > list.clientHeight) {
    const top = pick.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop || top + pick.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top - list.clientHeight / 3;
  }
  current = slug;
  app.dataset.pane = 'line';
  setView('lines');
  return true;
}

/* From the address. No hash: the list, and on a wide screen the first line
   beside it, so the right-hand side is never empty. */
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h === 'rankings') { setView('rank'); return; }
  if (open(h)) return;
  pushed = false;
  app.dataset.pane = 'list';
  if (wide.matches && !current) open($('.sk-pick')?.getAttribute('href').slice(1));
  setView('lines');
}

/* Bring the open line's top into view if the page has scrolled past it. */
const toLine = () => {
  const line = $('.sk-line.is-on');
  if (line && (!wide.matches || line.getBoundingClientRect().top < 0)) line.scrollIntoView({ block: 'start' });
};

// A line from the list, or a Tatari from the table: a new history entry, so
// Back returns to where you picked it.
app.addEventListener('click', (e) => {
  const link = e.target.closest('a.sk-pick, a.sk-who');
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  const slug = link.getAttribute('href').slice(1);
  e.preventDefault();
  history.pushState(null, '', `#${slug}`);
  pushed = true;
  open(slug);
  toLine();
});
$('#sk-detail').addEventListener('click', (e) => {
  const tierBtn = e.target.closest('.sk-switch__btn');
  if (tierBtn) {
    history.replaceState(null, '', `#${tierBtn.dataset.slug}`);
    open(tierBtn.dataset.slug);
    trackOnce('skills-tier');
    return;
  }
  if (e.target.closest('[data-back]')) {
    if (pushed) { history.back(); return; }
    history.replaceState(null, '', location.pathname + location.search);
    route();
    $('.sk-pick[aria-current="true"]')?.scrollIntoView({ block: 'center' });
  }
});
addEventListener('popstate', route);
addEventListener('hashchange', () => { route(); if (location.hash.length > 1 && current) toLine(); });

$('#sk-views').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  if (b.dataset.view === 'rank') {
    history.replaceState(null, '', '#rankings');
    trackOnce('skills-rankings');
  } else {
    history.replaceState(null, '', location.pathname + location.search + (current ? `#${current}` : ''));
  }
  setView(b.dataset.view);
});

/* Search and type apply to both views; tier and effect only to the table. */
function filter() {
  const q = find.value.trim().toLowerCase();
  const fits = (el) => (!type || el.dataset.type === type) && (!q || el.dataset.q.includes(q));
  let lines = 0;
  for (const li of $$('#sk-list > li')) { li.hidden = !fits(li); if (!li.hidden) lines++; }
  let rows = 0;
  for (const tr of tbody.rows) {
    tr.hidden = !(fits(tr) && (!tier || tr.dataset.tier === tier) && (!tag || tr.dataset.tags.split(' ').includes(tag)));
    if (!tr.hidden) rows++;
  }
  $('#sk-none').hidden = (app.dataset.view === 'rank' ? rows : lines) > 0;
}
find.addEventListener('input', () => { filter(); if (find.value.trim()) trackOnce('skills-searched'); });

const chooser = (sel, set) => $(sel).addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  set(b);
  press($$(`${sel} button`), b);
  filter();
  trackOnce('skills-filtered');
});
chooser('#sk-types', (b) => { type = b.dataset.type; });
chooser('#sk-tiers', (b) => { tier = b.dataset.tier; });
chooser('#sk-tags', (b) => { tag = b.dataset.tag; });

/* Sorting. A second press on the same column flips it. Biggest first, except
   Cooldown, where shortest is best. A Tatari with no value sorts last either way. */
let sortKey = 'af';
let dir = -1;
$('.sk-table thead').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  const k = b.dataset.sort;
  dir = k === sortKey ? -dir : k === 'cd' ? 1 : -1;
  sortKey = k;
  for (const th of $$('.sk-table thead th')) th.removeAttribute('aria-sort');
  b.parentElement.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');
  const val = (tr) => tr.dataset[k] === '' ? null : Number(tr.dataset[k]);
  tbody.append(...[...tbody.rows].sort((x, y) => {
    const a = val(x), c = val(y);
    if (a === null || c === null) return (a === null) - (c === null);
    return (a - c) * dir;
  }));
  trackOnce('skills-sorted');
});

route();
// Arriving on skills.html#cribking, the browser jumped to the tier itself; the
// line's name and tier switcher sit above it.
if (location.hash.length > 1 && current) toLine();
