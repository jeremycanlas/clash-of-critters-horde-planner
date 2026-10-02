/**
 * The row of page tabs under every page's header.
 *
 * One list, every page: adding a tool is one line in PAGES, and every page with
 * a <nav id="site-tabs"> shows it. Tabs rather than a menu so nothing on the
 * site is one tap deep; on a phone the row scrolls sideways, so a tenth page
 * costs no extra height.
 */

import { rest, signedIn } from './supabase.js';
import { track } from './analytics.js';

const PAGES = [
  { href: 'index.html', name: 'Drafter' },
  { href: 'community.html', name: 'Community formations', short: 'Community' },
  { href: 'changes.html', name: 'Patch notes' },
  { href: 'skills.html', name: 'Skill data' },
  { href: 'chips.html', name: 'Chips' },
  { href: 'farm.html', name: 'Cozy Farm' },
  { href: 'contribute.html', name: 'Record a range', add: true },
];

/* How long an update counts as news. A patch lands, players check the notes
   over the following week or two, then the tag would only be noise. */
const NEW_FOR_DAYS = 14;

/* The private tabs: Players, and MVP banquets. Nobody sees one until the
   database has said yes for the account signed in right now: the page itself
   calls showPrivateTab() after its own check, and every other page asks again
   here, but only in a browser that has been let in before (the flag), so nobody
   else pays for a request. The database still decides who can read the data;
   this only hides the door. */
const PRIVATE = [
  { href: 'tracker.html', name: 'Players', flag: 'coc.tracker.member', rpc: 'tracker_claim', yes: true },
  { href: 'banquet.html', name: 'MVP banquets', flag: 'coc.banquet.member', rpc: 'banquet_check', yes: 'ok' },
];
const flagged = (flag) => { try { return localStorage.getItem(flag) === '1'; } catch { return false; } };
const unflag = (flag) => { try { localStorage.removeItem(flag); } catch { /* private mode */ } };

const nav = document.getElementById('site-tabs');
const here = location.pathname.split('/').pop() || 'index.html';

// `query` keeps a banquet link's server code, so its tab goes back to the same list.
export function showPrivateTab(href = 'tracker.html', query = '') {
  const p = PRIVATE.find((x) => x.href === href);
  if (!nav || !p || nav.querySelector(`[href^="${href}"]`)) return;
  nav.insertAdjacentHTML('beforeend', `
    <a class="sitetabs__tab sitetabs__tab--private" href="${href}${query}"${here === href ? ' aria-current="page"' : ''}>
      <span class="sitetabs__long">${p.name}</span>
    </a>`);
}

for (const p of PRIVATE) {
  if (!nav || here === p.href || !flagged(p.flag)) continue;
  if (!signedIn()) { unflag(p.flag); continue; }
  rest(`/rpc/${p.rpc}`, { method: 'POST', body: {}, auth: true }).then((r) => {
    if (r.ok && r.data === p.yes) showPrivateTab(p.href);
    else if (r.ok && r.data !== 'discord-down') unflag(p.flag); // taken off; a blip keeps the flag
  });
}

if (nav) {
  nav.innerHTML = PAGES.map((p) => `
    <a class="sitetabs__tab${p.add ? ' sitetabs__tab--add' : ''}" href="${p.href}"${p.href === here ? ' aria-current="page"' : ''}>
      <span class="sitetabs__long">${p.name}</span>${p.short ? `<span class="sitetabs__short">${p.short}</span>` : ''}
    </a>`).join('');

  // Which tab, from where: tab-community-to-changes. Counts only on pages that
  // started the counter, and never the private Players tab.
  nav.addEventListener('click', (e) => {
    const tab = e.target.closest('a.sitetabs__tab:not(.sitetabs__tab--private)');
    if (!tab || tab.getAttribute('aria-current')) return;
    const name = (href) => href.replace(/\.html$/, '') || 'index';
    track(`tab-${name(here)}-to-${name(tab.getAttribute('href'))}`);
  });

  // A phone may start the row scrolled; keep the current page's tab in view.
  nav.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // "New" on Patch notes for a fortnight after an update. Silent if the file is missing.
  fetch('data/changes.json').then((r) => r.json()).then((d) => {
    const days = (Date.now() - Date.parse(d.patch)) / 864e5;
    if (!(days >= 0 && days <= NEW_FOR_DAYS)) return;
    const tab = nav.querySelector('[href="changes.html"]');
    tab.insertAdjacentHTML('beforeend', '<span class="sitetabs__new">New</span>');
    tab.title = `Latest update: ${d.label}`;
  }).catch(() => {});
}

/* Any <details class="formmenu"> closes on a click outside it or Escape, and
   after one of its items is used. <details> does the opening by itself. */
for (const menu of document.querySelectorAll('details.formmenu')) {
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.open = false; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('button.formmenu__item')) menu.open = false;
  });
  menu.addEventListener('change', () => { menu.open = false; });
}
