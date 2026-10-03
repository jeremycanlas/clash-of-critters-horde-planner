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
import { theme as storedTheme, setTheme } from './prefs.js';

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

/* ---------------------------------------------------------------- header
   Every page's header carries the same two things on the right: the credit
   with its tip jar, and one light/dark switch. Added here because this script
   is on every page, so a new page gets both for free. The switch writes the
   same stored preference the drafter's settings use, so a choice made on one
   tab is the theme on all of them. */

const topbar = document.querySelector('.topbar');
if (topbar) {
  if (!topbar.querySelector('.byline')) {
    topbar.insertAdjacentHTML('beforeend', `
    <span class="byline" title="Created by jacc6475 on Discord">
      <img class="byline__avatar" src="assets/img/jacc6475.jpg" width="26" height="26" alt="" decoding="async">
      <span class="byline__text">by <b>jacc6475</b></span>
      <a class="byline__tip" href="https://ko-fi.com/jacc6475" target="_blank" rel="noopener"
         title="Horde Drafter is free and always will be. This is just a tip jar."
         aria-label="Say thanks: tip jar on Ko-fi">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M2 21h18v-2H2v2ZM20 8h-2V5H4v8a4 4 0 0 0 4 4h6a4 4 0 0 0 3.9-3.1A3 3 0 0 0 20 8Zm-2 4.9V10h1a1 1 0 0 1 0 2 3 3 0 0 1-1 .9Z"/>
        </svg>
        <span class="byline__tip-text">Say thanks</span>
      </a>
    </span>`);
  }
  const byline = topbar.querySelector('.byline');
  byline.insertAdjacentHTML('afterend', `
    <button class="btn btn--quiet themetoggle" type="button" id="theme-toggle"></button>`);
  const btn = topbar.querySelector('#theme-toggle');
  const sys = matchMedia('(prefers-color-scheme: light)');
  // What is on screen now: the stored choice, or the system's when there is none.
  const showing = () => { const t = storedTheme(); return t === 'system' ? (sys.matches ? 'light' : 'dark') : t; };
  const MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>';
  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  const render = () => {
    const next = showing() === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${next === 'light' ? SUN : MOON}</svg>`;
    // Keep the drafter's own System/Light/Dark switch, if this page has it, in step.
    for (const b of document.querySelectorAll('[data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === storedTheme()));
  };
  btn.addEventListener('click', () => { setTheme(showing() === 'dark' ? 'light' : 'dark'); render(); track('theme-toggled'); });
  // Another tab changed it: follow along without a reload.
  addEventListener('storage', (e) => { if (e.key === 'coc.theme') { setTheme(storedTheme()); render(); } });
  sys.addEventListener('change', render);
  document.getElementById('theme-switch')?.addEventListener('click', () => setTimeout(render));
  render();
}
