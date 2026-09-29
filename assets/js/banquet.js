/**
 * MVP banquets: the UIDs a group posts in its Discord channel each gold rush,
 * and who has claimed which banquet.
 *
 * Holds no data and decides nothing. Who gets in and which group they are (a
 * Discord role, asked of Discord by the database), who sees what (four UIDs of
 * your own), and which round is current all live in supabase/migrations/016;
 * this page shows whatever banquet_state() hands it. A group member's answer
 * carries no group at all, so the group controls below only ever appear for
 * someone who sees both.
 */

import { rest, signIn, signOut, signedIn, readCallback, isConfigured } from './supabase.js';
import { applyPrefs } from './prefs.js';
import { showPrivateTab } from './site-nav.js';
import { $, $$, esc, copyText, toast } from './ui.js';

applyPrefs();

const FLAG = 'coc.banquet.member';
const setMember = (on) => {
  try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* private mode */ }
};

let state = null;
let show = 'open';
let find = '';
let group = 0; // for those who see both: 0 is both, 1 or 2 is the page as that group sees it
/* Screenshot mode, for those who see both groups: the View as bar goes, so a
   capture "As Group 1" is exactly what a member sees. Kept per browser. */
const SHOT = 'coc.banquet.shot';
let shot = false;
const VIEW = 'coc.banquet.view'; // which group it is viewed as, so a reload in screenshot mode keeps it
try {
  shot = localStorage.getItem(SHOT) === '1';
  group = Number(localStorage.getItem(VIEW)) || 0;
} catch { /* private mode: starts off */ }
const setShot = (on) => {
  shot = on;
  try { if (on) localStorage.setItem(SHOT, '1'); else localStorage.removeItem(SHOT); } catch { /* this visit only */ }
  render();
};
let reached = Date.now(); // the last time a refresh got an answer
let folded = false; // Your UIDs is folded or not once, on arrival; after that it is yours

const status = (text) => { $('#bq-status').textContent = text; $('#bq-status').hidden = !text; };
/* A round is one gold rush: it starts at the reset (00:00 UTC, 8am Manila) on
   the date it is stored under and ends six days later. Dates read in UTC so
   everyone sees the same ones; the end is also given in the viewer's own time. */
const opens = (d) => new Date(`${d}T00:00:00Z`);
const closes = (d) => new Date(opens(d).getTime() + 6 * 864e5);
const utcDay = (t) => t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const span = (d) => `${utcDay(opens(d))} – ${utcDay(closes(d))}`;
// The date is in the round picker already; the weekday says which day it is where you are.
const localEnd = (d) => closes(d).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
// "2:05 PM, 12 min ago": the clock for when, the gap for whether to go and look again.
const ago = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  const gap = min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
  return `${time(iso)}, ${gap}`;
};
const tagOf = (g) => (g && !group ? `<span class="bq-grp">Group ${g}</span>` : '');
const grpAttr = (g) => (g ? ` data-grp="${g}"` : '');

// ------------------------------------------------------------------ gate

const WHY = {
  'no-role': ['This page is for one Discord server', 'Your Discord account does not have the role for it. Ask in the server.'],
  'not-set-up': ['Not set up yet', 'The owner has not finished connecting this page to Discord.'],
  'discord-down': ['Could not reach Discord', 'Discord did not answer. Try again in a minute.'],
  'signed-out': ['This page is private', 'Sign in with Discord to see it.'],
};

async function check() {
  const got = await rest('/rpc/banquet_check', { method: 'POST', body: {}, auth: true });
  if (!got.ok) return got.why;
  return got.data;
}

async function start() {
  const back = readCallback();
  if (!isConfigured()) return gate('Not connected', 'This copy of the site has no database.', false);
  if (!signedIn()) {
    return gate('This page is private', back === 'failed'
      ? 'Discord did not sign you in. Try again.'
      : 'Sign in with Discord to see it. Only members of one Discord server with the right role can open it.', true);
  }
  $('#bq-signout').hidden = false;
  status('Checking your role with Discord…');
  const got = await check();
  if (got !== 'ok') {
    if (got !== 'discord-down') setMember(false);
    const [head, text] = WHY[got] ?? ['Could not check your access', got];
    return gate(head, text, got === 'signed-out' || !WHY[got]);
  }
  setMember(true);
  showPrivateTab('banquet.html');
  await load();

  /* Everyone else's claims and marks, every 30 seconds while the tab is in
     view, and at once on coming back to it from the game. Nothing while hidden. */
  const refresh = async () => {
    if (document.hidden || !state) return; // no list yet: the first load failed and said so
    await load(state.round === state.current ? null : state.round, true);
    offline();
  };
  setInterval(refresh, 30 * 1000);
  document.addEventListener('visibilitychange', refresh);

  // Keeps the database's yes fresh, and notices a role taken away.
  setInterval(async () => {
    const again = await check();
    if (again === 'no-role') location.reload();
  }, 10 * 60 * 1000);
}

function gate(head, text, canSignIn) {
  status('');
  $('#bq-gate').hidden = false;
  $('#bq-app').hidden = true;
  $('#bq-gate-head').textContent = head;
  $('#bq-gate-text').textContent = text;
  $('#bq-signin').hidden = !canSignIn;
}

// ------------------------------------------------------------------ data

/* `quiet` is the timer's: a failed refresh keeps what is on screen, where a
   failed load someone asked for says so. */
async function load(round = null, quiet = false) {
  /* A refresh sends the fingerprint of what it holds; an unchanged list comes
     back as a few bytes saying so, rather than the whole list again. */
  const known = quiet && state && (round ?? state.current) === state.round ? state.hash : null;
  const got = await rest('/rpc/banquet_state', { method: 'POST', body: { r: round, known }, auth: true });
  if (!got.ok) return quiet ? undefined : gate('Could not load the banquets', got.why, true);
  reached = Date.now();
  state = got.data.same ? { ...state, synced_at: got.data.synced_at } : got.data;
  status('');
  $('#bq-gate').hidden = true;
  $('#bq-app').hidden = false;
  render();
}

/* A refresh that fails keeps the list on screen, so a phone that lost its
   signal would show an old list as if it were live. Two minutes without an
   answer says so, and it is the reader's connection, not Discord. */
function offline() {
  const min = Math.floor((Date.now() - reached) / 60000);
  if (min < 2) return;
  $('#bq-stale').hidden = false;
  $('#bq-stale').textContent = `This page has not reached the list for ${min} minutes, so what you see may be out of date. Check your connection.`;
}

// ------------------------------------------------------------------ render

function render() {
  const past = state.round !== state.current;
  $('#bq-sub').textContent = `Gold rush ${span(state.current)}`;
  if (document.activeElement !== $('#bq-round')) $('#bq-round').innerHTML = state.rounds
    .map((r) => `<option value="${r}"${r === state.round ? ' selected' : ''}>${span(r)}${r === state.current ? ' (now)' : ''}</option>`)
    .join('');
  // How fresh the posts are: read every minute, so a gap of five means it stopped.
  const age = state.synced_at ? Math.floor((Date.now() - Date.parse(state.synced_at)) / 60000) : null;
  $('#bq-fresh').textContent = past || age == null ? '' : `Discord read ${age < 1 ? 'just now' : `${age} min ago`}`;
  $('#bq-stale').hidden = past || (age != null && age < 5);
  $('#bq-stale').textContent = age == null
    ? 'Discord has not been read yet, so posted UIDs are missing. Tell the owner.'
    : `Discord has not been read for ${age} minutes, so new or edited posts may be missing. Tell the owner.`;
  $('#bq-when').textContent = past ? 'A past round, read only.'
    : `Ends 00:00 UTC · ${localEnd(state.round)} your time`;

  // Yours: posted ones come from Discord and change there; added ones can go.
  const n = state.mine.length;
  const mineShown = state.mine.filter((m) => !group || m.grp === group);
  $('#bq-my').innerHTML = mineShown.map((m) => `<li class="bq-mine__uid">
      ${tagOf(m.grp)}<button type="button" class="tr-copy" data-copy="${m.uid}" title="Copy UID">${m.uid}</button>
      ${m.source === 'discord' ? '<span class="bq-src">from Discord</span>'
        : past ? '' : `<button type="button" class="btn btn--quiet" data-remove="${m.uid}"${grpAttr(m.grp)} aria-label="Remove ${m.uid}">Remove</button>`}
    </li>`).join('') || `<li class="muted">${past ? 'None this gold rush.' : 'None yet. Post them in Discord, or add them here.'}</li>`;
  $('#bq-mine .bq-mine__actions').hidden = past;
  $('#bq-mine-n').textContent = mineShown.length ? `(${mineShown.length})` : '';
  // Folded on arrival when there is nothing left to do in it; never while it is being used.
  if (!folded) { $('#bq-mine-fold').open = !((past || state.shared) && mineShown.length); folded = true; }
  const pick = $('#bq-add-grp');
  pick.hidden = !state.groups || !!group;
  if (state.groups && !pick.options.length) {
    pick.innerHTML = `<option value="">Group…</option>${state.groups.map((g) => `<option value="${g}">Group ${g}</option>`).join('')}`;
  }

  const open = past || state.shared;
  $('#bq-locked').hidden = open;
  $('#bq-locked').textContent = `${state.total} banquet${state.total === 1 ? '' : 's'} shared this round. `
    + `Add ${4 - n} more UID${4 - n === 1 ? '' : 's'} of your own to see them.`;
  $('#bq-list').hidden = !open;
  if (!state.groups?.includes(group)) group = 0; // a member, or a stale choice
  $('#bq-view').hidden = !state.groups || shot;
  const groups = $('#bq-groups');
  if (state.groups && !groups.children.length) {
    groups.innerHTML = [0, ...state.groups].map((g) => `<button class="segmented__btn" type="button" data-group="${g}"
      aria-pressed="${g === group}">${g ? `As Group ${g}` : 'Both groups'}</button>`).join('');
  }
  $('#bq-view-note').textContent = group ? `What Group ${group} members see. Anything you press counts for Group ${group}.` : '';
  if (open) renderCards(past);
}

const WHICH = {
  open: (b) => !b.full && !b.claimed,
  claimed: (b) => b.claimed,
  full: (b) => !!b.full,
  all: () => true,
};

function renderCards(past) {
  // Open before not-yet-open, then fewest claims first: the likeliest to have room.
  const shown = state.banquets.filter((b) => WHICH[show](b) && (!group || b.grp === group) && (!find || b.uid.includes(find)))
    .sort((a, b) => !!a.not_yet - !!b.not_yet || a.claims - b.claims || a.uid.localeCompare(b.uid));
  const inView = state.banquets.filter((b) => !group || b.grp === group);
  $('#bq-count').textContent = `${shown.length} of ${inView.length}`;
  const key = (b) => `${b.grp ?? ''}:${b.uid}`;
  const opened = new Set($$('#bq-cards details[open]').map((d) => d.closest('li').dataset.key));
  $('#bq-cards').innerHTML = shown.map((b) => `<li data-key="${key(b)}" class="bq-card${b.full ? ' is-full' : ''}${b.not_yet ? ' is-waiting' : ''}${b.claimed ? ' is-claimed' : ''}">
      <div class="bq-card__id">
        ${tagOf(b.grp)}
        <button type="button" class="tr-copy bq-uid" data-copy="${b.uid}" title="Copy UID">${b.uid}</button>
        ${b.full ? `<span class="bq-tag">Full<small> · ${esc(b.full)}</small></span>` : ''}
        ${b.not_yet ? '<span class="bq-tag bq-tag--wait">Not yet available</span>' : ''}
      </div>
      ${b.not_yet ? `<p class="bq-card__checked">Last checked ${ago(b.not_yet.at)} by ${esc(b.not_yet.by)}</p>` : ''}
      <div class="bq-card__row">
      <p class="bq-card__meta">From ${esc(b.entered_by.join(', '))}</p>
      ${b.claims ? `<details class="bq-card__claims">
        <summary>${b.claims} claimed</summary>
        <p>${esc(b.claimed_by.join(', '))}</p>
      </details>` : '<p class="bq-card__meta">No claims yet</p>'}
      </div>
      ${past ? '' : `<div class="bq-card__actions">
        <button type="button" class="btn${b.claimed ? ' btn--primary' : ''}" data-claim="${b.uid}"${grpAttr(b.grp)} aria-label="I claimed ${b.uid}" aria-pressed="${b.claimed}">${b.claimed ? 'Claimed ✓' : 'I claimed'}</button>
        <button type="button" class="btn btn--quiet" data-mark="full" data-uid="${b.uid}"${grpAttr(b.grp)} aria-label="Full: ${b.uid}" aria-pressed="${!!b.full}">${b.full ? 'Not full' : 'Full'}</button>
        <button type="button" class="btn btn--quiet" data-mark="not-yet" data-uid="${b.uid}"${grpAttr(b.grp)} aria-label="Not yet available: ${b.uid}" aria-pressed="${!!b.not_yet}">${b.not_yet ? 'Open now' : '<span class="bq-long">Not yet available</span><span class="bq-short">Not open</span>'}</button>
        ${b.not_yet ? `<button type="button" class="btn btn--quiet" data-mark="not-yet" data-uid="${b.uid}"${grpAttr(b.grp)} aria-label="Still not open: ${b.uid}">Still not open</button>` : ''}
      </div>`}
    </li>`).join('') || `<li class="muted bq-none">${inView.length ? 'Nothing here.' : 'No banquets shared this round yet.'}</li>`;
  for (const d of $$('#bq-cards details')) d.open = opened.has(d.closest('li').dataset.key);
}

// ------------------------------------------------------------------ actions

// The group only matters, and is only sent, for someone who sees both.
const grpOf = (el) => (el.dataset.grp ? Number(el.dataset.grp) : null);

$('#bq-mine').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#bq-mine-error');
  const uid = $('#bq-add-uid').value.trim();
  err.hidden = true;
  if (!/^[0-9]{8}$/.test(uid)) { err.textContent = 'A UID is 8 digits.'; err.hidden = false; return; }
  const g = state.groups ? group || Number($('#bq-add-grp').value) || null : null;
  if (state.groups && !g) { err.textContent = 'Pick a group.'; err.hidden = false; return; }
  $('#bq-add').disabled = true;
  const got = await rest('/rpc/banquet_add', { method: 'POST', body: { target: Number(uid), g }, auth: true });
  $('#bq-add').disabled = false;
  if (!got.ok) { err.textContent = got.why; err.hidden = false; return; }
  $('#bq-add-uid').value = '';
  load();
});

$('#bq-my').addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove]');
  if (!remove) return;
  remove.disabled = true;
  const got = await rest('/rpc/banquet_remove', { method: 'POST', body: { target: Number(remove.dataset.remove), g: grpOf(remove) }, auth: true });
  if (!got.ok) { remove.disabled = false; remove.textContent = got.why; return; }
  load();
});

$('#bq-shot').addEventListener('click', () => {
  setShot(true);
  toast('Screenshot mode. Tap the page title to bring the controls back.');
});
// The way back leaves nothing on screen to give it away. Escape does it too.
$('.topbar h1').addEventListener('click', () => { if (shot && state?.groups) setShot(false); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && shot && state?.groups) setShot(false); });

$('#bq-groups').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  group = Number(b.dataset.group);
  try { localStorage.setItem(VIEW, String(group)); } catch { /* this visit only */ }
  for (const x of $$('[data-group]')) x.setAttribute('aria-pressed', String(x === b));
  render();
});

$('#bq-cards').addEventListener('click', async (e) => {
  const claim = e.target.closest('[data-claim]');
  const mark = e.target.closest('[data-mark]');
  const btn = claim ?? mark;
  if (!btn) return;
  btn.disabled = true;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  const target = Number((claim ?? mark).dataset[claim ? 'claim' : 'uid']);
  const g = grpOf(btn);
  const got = claim
    ? await rest('/rpc/banquet_claim', { method: 'POST', body: { target, claimed: on, g }, auth: true })
    : await rest('/rpc/banquet_mark', { method: 'POST', body: { target, state: on ? mark.dataset.mark : null, g }, auth: true });
  if (!got.ok) { btn.disabled = false; btn.textContent = got.why; btn.removeAttribute('aria-label'); return; }
  /* Claiming takes the card out of To claim at once, so a thumb on the wrong
     card gets a way back that does not mean finding it in another tab. */
  if (claim && on) {
    toast(`Claimed ${target}`, 'info', {
      label: 'Undo',
      fn: async () => {
        await rest('/rpc/banquet_claim', { method: 'POST', body: { target, claimed: false, g }, auth: true });
        load(state.round);
      },
    });
  }
  load(state.round);
});

for (const b of $$('[data-show]')) {
  b.addEventListener('click', () => {
    show = b.dataset.show;
    for (const x of $$('[data-show]')) x.setAttribute('aria-pressed', String(x === b));
    renderCards(state.round !== state.current);
  });
}

$('#bq-round').addEventListener('change', (e) => load(e.target.value));
$('#bq-find').addEventListener('input', (e) => {
  find = e.target.value.replace(/\D/g, '');
  renderCards(state.round !== state.current);
});

/* The filter bar sticks under the header, which is itself sticky on a wide
   screen and scrolls away on a phone. */
const stickTop = () => {
  const bar = $('.topbar');
  const h = getComputedStyle(bar).position === 'sticky' ? bar.offsetHeight : 0;
  document.documentElement.style.setProperty('--bq-top', `${h}px`);
};
stickTop();
addEventListener('resize', stickTop);

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.tr-copy');
  if (!btn) return;
  const ok = await copyText(btn.dataset.copy);
  btn.classList.add(ok ? 'is-copied' : 'is-failed');
  btn.dataset.label = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { btn.classList.remove('is-copied', 'is-failed'); delete btn.dataset.label; }, 1200);
});

$('#bq-signin').addEventListener('click', () => signIn());
$('#bq-signout').addEventListener('click', () => { signOut(); setMember(false); location.reload(); });

start();
