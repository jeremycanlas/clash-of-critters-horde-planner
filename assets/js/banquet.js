/**
 * MVP banquets: every member's four MVP UIDs per gold rush, and who has claimed
 * which banquet.
 *
 * Holds no data and decides nothing. Who gets in (a Discord role, asked of
 * Discord by the database), who sees what (only members who shared all four),
 * and which round is current all live in supabase/migrations/013; this page
 * shows whatever banquet_state() hands it.
 */

import { rest, signIn, signOut, signedIn, readCallback, isConfigured } from './supabase.js';
import { applyPrefs } from './prefs.js';
import { showPrivateTab } from './site-nav.js';
import { $, $$, esc, copyText } from './ui.js';

applyPrefs();

// The gold rush's four teams, in the order the slots are stored (1 to 4).
const COLORS = [
  { name: 'Red', css: 'var(--fire)' },
  { name: 'Blue', css: 'var(--water)' },
  { name: 'Yellow', css: 'var(--lightning)' },
  { name: 'Purple', css: '#9b6cf0' },
];

const FLAG = 'coc.banquet.member';
const setMember = (on) => {
  try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* private mode */ }
};

let state = null;
let show = 'open';

const status = (text) => { $('#bq-status').textContent = text; $('#bq-status').hidden = !text; };
// A round is the Manila date its gold rush ended, at the 8am reset.
const day = (d) => new Date(`${d}T08:00:00+08:00`)
  .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Manila' });
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dot = (c) => `<span class="bq-dot" style="--c:${COLORS[c - 1].css}" title="${COLORS[c - 1].name}"></span>`;

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

async function load(round = null) {
  const got = await rest('/rpc/banquet_state', { method: 'POST', body: { r: round }, auth: true });
  if (!got.ok) return gate('Could not load the banquets', got.why, true);
  state = got.data;
  status('');
  $('#bq-gate').hidden = true;
  $('#bq-app').hidden = false;
  render();
}

// ------------------------------------------------------------------ render

function render() {
  const past = state.round !== state.current;
  $('#bq-sub').textContent = `Gold rush ended ${day(state.current)}, 8am Manila`;
  $('#bq-round').innerHTML = state.rounds
    .map((r) => `<option value="${r}"${r === state.round ? ' selected' : ''}>${day(r)}${r === state.current ? ' (now)' : ''}</option>`)
    .join('');
  $('#bq-when').textContent = past ? 'A past round, read only.' : '';

  // Your four: editable now, a record afterwards.
  const mine = new Map(state.mine.map((m) => [m.color, m.uid]));
  $('#bq-slots').innerHTML = COLORS.map((c, i) => `<label class="bq-slot">${dot(i + 1)}<span>${c.name}</span>
      <input class="field" inputmode="numeric" pattern="[0-9]{1,15}" maxlength="15" autocomplete="off"
        data-color="${i + 1}" value="${esc(mine.get(i + 1) ?? '')}"${past ? ' readonly' : ''} aria-label="${c.name} MVP UID"></label>`).join('');
  $('#bq-save').hidden = past;
  $('#bq-mine').hidden = past && !state.mine.length;

  const open = past || state.shared;
  $('#bq-locked').hidden = open;
  $('#bq-locked').textContent = `${state.total} banquet${state.total === 1 ? '' : 's'} shared this round. Enter all four of yours above to see them.`;
  $('#bq-list').hidden = !open;
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
  const shown = state.banquets.filter(WHICH[show])
    .sort((a, b) => !!a.not_yet - !!b.not_yet || a.claims - b.claims || a.uid.localeCompare(b.uid));
  $('#bq-count').textContent = `${shown.length} of ${state.banquets.length}`;
  $('#bq-cards').innerHTML = shown.map((b) => `<li class="bq-card${b.full ? ' is-full' : ''}${b.claimed ? ' is-claimed' : ''}">
      <div class="bq-card__id">
        <span class="bq-card__dots">${b.colors.map(dot).join('')}</span>
        <button type="button" class="tr-copy bq-uid" data-copy="${b.uid}" title="Copy UID">${b.uid}</button>
        ${b.full ? `<span class="bq-tag">Full<small> · ${esc(b.full)}</small></span>` : ''}
        ${b.not_yet ? `<span class="bq-tag bq-tag--wait">Not yet available<small> · ${esc(b.not_yet.by)}, ${time(b.not_yet.at)}</small></span>` : ''}
      </div>
      <p class="bq-card__meta">From ${esc(b.entered_by.join(', '))}</p>
      ${b.claims ? `<details class="bq-card__claims">
        <summary>${b.claims} member${b.claims === 1 ? '' : 's'} claimed</summary>
        <p>${esc(b.claimed_by.join(', '))}</p>
      </details>` : '<p class="bq-card__meta">No members claimed yet</p>'}
      ${past ? '' : `<div class="bq-card__actions">
        <button type="button" class="btn${b.claimed ? ' btn--primary' : ''}" data-claim="${b.uid}" aria-pressed="${b.claimed}">${b.claimed ? 'Claimed ✓' : 'I claimed'}</button>
        <button type="button" class="btn btn--quiet" data-mark="full" data-uid="${b.uid}" aria-pressed="${!!b.full}">${b.full ? 'Not full' : 'Full'}</button>
        <button type="button" class="btn btn--quiet" data-mark="not-yet" data-uid="${b.uid}" aria-pressed="${!!b.not_yet}">${b.not_yet ? 'Available now' : 'Not yet available'}</button>
      </div>`}
    </li>`).join('') || `<li class="muted bq-none">${state.banquets.length ? 'Nothing here.' : 'No banquets shared this round yet.'}</li>`;
}

// ------------------------------------------------------------------ actions

$('#bq-mine').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#bq-mine-error');
  err.hidden = true;
  const uids = $$('[data-color]').map((i) => i.value.trim());
  if (uids.some((u) => u && !/^[0-9]{1,15}$/.test(u))) { err.textContent = 'A UID is a whole number, up to 15 digits.'; err.hidden = false; return; }
  $('#bq-save').disabled = true;
  const got = await rest('/rpc/banquet_save_mvps', { method: 'POST', body: { uids: uids.map((u) => (u ? Number(u) : null)) }, auth: true });
  $('#bq-save').disabled = false;
  if (!got.ok) { err.textContent = got.why; err.hidden = false; return; }
  $('#bq-saved').textContent = 'Saved';
  setTimeout(() => { $('#bq-saved').textContent = ''; }, 1500);
  load();
});

$('#bq-cards').addEventListener('click', async (e) => {
  const claim = e.target.closest('[data-claim]');
  const mark = e.target.closest('[data-mark]');
  const btn = claim ?? mark;
  if (!btn) return;
  btn.disabled = true;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  const got = claim
    ? await rest('/rpc/banquet_claim', { method: 'POST', body: { target: Number(claim.dataset.claim), claimed: on }, auth: true })
    : await rest('/rpc/banquet_mark', { method: 'POST', body: { target: Number(mark.dataset.uid), state: on ? mark.dataset.mark : null }, auth: true });
  if (!got.ok) { btn.disabled = false; btn.textContent = got.why; return; }
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
