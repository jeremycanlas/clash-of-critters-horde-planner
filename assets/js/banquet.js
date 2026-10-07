/**
 * MVP banquets: the UIDs a group adds here each gold rush,
 * and who has claimed which banquet.
 *
 * Holds no data and decides nothing. Who gets in and which group they are (a
 * Discord role, asked of Discord by the database), who sees what (four UIDs of
 * your own), and which round is current all live in supabase/migrations/016;
 * this page shows whatever banquet_state() hands it. A group member's answer
 * carries no group at all, so the group controls below only ever appear for
 * someone who sees both.
 *
 * ## Servers
 *
 * Each Discord server has a schema of its own: the first is public, another is
 * a full copy of the banquet tables and functions under its own name, made by
 * tools/setup-server.sh, whose functions name nothing outside it. The code on
 * the page's link picks which (`?s=…`); no code is the server this page has
 * always served, and behaves exactly as it did. One more code is both at once,
 * for whoever each server separately lets in: it renumbers each server's groups
 * after its place (10s, 20s) so no two collide, and sends every request to the
 * schema the card it is about came from.
 */

import { rest, signIn, signOut, signedIn, readCallback, isConfigured, whoAmI } from './supabase.js';
import { applyPrefs } from './prefs.js';
import { showPrivateTab } from './site-nav.js';
import { $, $$, esc, copyText, toast } from './ui.js';

applyPrefs();

// Link code: the server's name, and its schema (none is public).
const SERVERS = {
  '': { name: 'MVP UIDs', profile: null },
  tide: { name: 'Send UIDs', profile: 'tide' },
};
const BOTH = 'duo';
const code = new URLSearchParams(location.search).get('s') ?? '';
const dbs = (code === BOTH ? Object.values(SERVERS) : [SERVERS[code]].filter(Boolean))
  .map((s, i, all) => ({ ...s, base: all.length > 1 ? (i + 1) * 10 : 0, state: null }));
const combined = dbs.length > 1;
// Where a group's requests go, and the group number that database knows it by.
const dbOf = (g) => (combined && g ? dbs.find((d) => d.base === g - (g % 10)) : dbs[0]);
const local = (g) => (combined && g ? g % 10 || null : g);
const ask = (d, fn, body) => rest(`/rpc/${fn}`, { method: 'POST', body, auth: true, profile: d.profile });
function call(fn, body) {
  return ask(dbOf(body.g), fn, 'g' in body ? { ...body, g: local(body.g) } : body);
}
// What this browser keeps, kept per link, so two servers never mix their seen or last copied.
const K = code ? `.${code}` : '';

// The site's nav knows the one server only.
const FLAG = 'coc.banquet.member';
const setMember = (on) => {
  if (!dbs.some((d) => !d.profile)) return;
  try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* private mode */ }
};

let state = null;
let show = null; // one status's tile pressed, or null for all four
let find = '';
let group = 0; // for those who see both: 0 is both, 1 or 2 is the page as that group sees it
/* Screenshot mode, for those who see both groups: the View as bar goes, so a
   capture "As Group 1" is exactly what a member sees. Kept per browser. */
const SHOT = `coc.banquet.shot${K}`;
let shot = false;
const VIEW = `coc.banquet.view${K}`; // which group it is viewed as, so a reload in screenshot mode keeps it
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

/* What is new since you last looked. `seen` is every banquet you have been
   shown, per round and per browser; a banquet you have not been shown, have
   not claimed and is not full is new. The first visit sees everything as
   seen, so it does not open on a wall of "new". */
const SEEN = `coc.banquet.seen.v1${K}`;
let seen = null; // Set of "grp:uid", for state.round
const latest = []; // this visit's changes, newest first
const TITLE = document.title;
const keyOf = (b) => `${b.grp ?? ''}:${b.uid}`;
function loadSeen(round, banquets) {
  let held = null;
  try { held = JSON.parse(localStorage.getItem(SEEN) ?? 'null'); } catch { /* start fresh */ }
  seen = new Set(held?.round === round ? held.keys : banquets.map(keyOf));
  saveSeen(round);
}
function saveSeen(round) {
  try { localStorage.setItem(SEEN, JSON.stringify({ round, keys: [...seen] })); } catch { /* this visit only */ }
}
const isNew = (b) => seen && !seen.has(keyOf(b)) && !b.claimed && !b.full;
function markSeen(...keys) {
  for (const k of keys) seen?.add(k);
  if (state) saveSeen(state.round);
}

/* One line per change another member made, from the difference between two
   answers. Your own presses are not news to you. */
function diff(before, after) {
  const was = new Map(before.banquets.map((b) => [keyOf(b), b]));
  const said = [];
  const where = (b) => (b.grp && !group ? ` (${nameOf(b.grp)})` : '');
  for (const b of after.banquets) {
    const o = was.get(keyOf(b));
    if (!o) { said.push(`New: ${b.uid}${where(b)} from ${b.entered_by.join(', ')}`); continue; }
    const others = b.claims - o.claims - (b.claimed && !o.claimed ? 1 : 0) + (o.claimed && !b.claimed ? 1 : 0);
    if (others > 0) said.push(`${b.claimed_by.slice(-others).join(', ')} claimed ${b.uid}${where(b)}`);
    if (b.full && !o.full) said.push(`${b.full} marked ${b.uid}${where(b)} full`);
    if (b.not_yet && !o.not_yet) said.push(`${b.not_yet.by}: ${b.uid}${where(b)} not logged in yet`);
    if (b.open && !o.open) said.push(`${b.open.by} saw a gift on ${b.uid}${where(b)}`);
  }
  const at = Date.now();
  latest.unshift(...said.reverse().map((text) => ({ text, at })));
  latest.length = Math.min(latest.length, 20);
}
let folded = false; // Your UIDs is folded or not once, on arrival; after that it is yours
let drawnGroups = ''; // the groups and names the View as buttons were last drawn from
let wasAsleep = []; // your UIDs not logged in at the last render, so a new one opens the fold

const status = (text) => { $('#bq-status').textContent = text; $('#bq-status').hidden = !text; };
/* A round is one gold rush, named by its reset (00:00 UTC, 8am Manila): when
   its banquets open. Its UIDs are added before that, and a past round ran six
   days from it. The current round stays current until the next is set up, so
   it is labelled by its reset alone. Dates read in UTC so everyone sees the
   same ones; the reset is also given in the viewer's own time. */
const opens = (d) => new Date(`${d}T00:00:00Z`);
const closes = (d) => new Date(opens(d).getTime() + 6 * 864e5);
const utcDay = (t) => t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const span = (d) => (d === state?.current ? `reset ${utcDay(opens(d))}` : `${utcDay(opens(d))} – ${utcDay(closes(d))}`);
const before = (d) => Date.now() < opens(d).getTime(); // its UIDs are still being added
// The date is in the round picker already; the weekday says which day it is where you are.
const yourTime = (t) => t.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
// "2:05 PM, 12 min ago": the clock for when, the gap for whether to go and look again.
const since = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
};
const ago = (iso) => `${time(iso)}, ${since(iso)}`;
// A group's name, and whether it is a private list: never part of All groups.
const nameOf = (g) => state?.names?.[g] ?? `Group ${g}`;
const isPrivate = (g) => !!state?.private?.includes(g);
// In the current view: one group, or All groups, which leaves private lists out.
const inView = (g) => (group ? g === group : !isPrivate(g));
const tagOf = (g) => (g && !group ? `<span class="bq-grp">${esc(nameOf(g))}</span>` : '');
const grpAttr = (g) => (g ? ` data-grp="${g}"` : '');

// ------------------------------------------------------------------ gate

const WHY = {
  'no-role': ['This page is for one Discord server', 'Your Discord account does not have the role for it. Ask in the server.'],
  'not-set-up': ['Not set up yet', 'The owner has not finished connecting this page to Discord.'],
  'discord-down': ['Could not reach Discord', 'Discord did not answer. Try again in a minute.'],
  'signed-out': ['This page is private', 'Sign in with Discord to see it.'],
};

/* Discord, or the way to it, sometimes does not answer for a few seconds, and
   the database can be busy: asked again up to three times before saying so. */
async function check(d) {
  let said;
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500 * i));
    const got = await ask(d, 'banquet_check', {});
    said = got.ok ? got.data : got.why;
    if (got.ok && said !== 'discord-down') return said;
    if (!got.ok && !/busy|reach/i.test(said)) return said; // a real answer, not a moment's overload
  }
  return said;
}

async function start() {
  const back = readCallback();
  if (!dbs.length) return gate('This link is not right', 'Check the link you were given.', false);
  if (!isConfigured()) return gate('Not connected', 'This copy of the site has no database.', false);
  if (!signedIn()) {
    return gate('This page is private', back === 'failed'
      ? 'Discord did not sign you in. Try again.'
      : 'Sign in with Discord to see it. Only members of one Discord server with the right role can open it.', true);
  }
  $('#bq-signout').hidden = false;
  status('Checking your role with Discord…');
  const said = await Promise.all(dbs.map(check));
  const ours = said[dbs.findIndex((d) => !d.profile)];
  if (ours && ours !== 'discord-down') setMember(ours === 'ok');
  // Both servers: whichever let you in opens, and the other says why not.
  const shut = said.map((got, i) => [got, dbs[i]]).filter(([got]) => got !== 'ok');
  if (shut.length === dbs.length) {
    const [got, d] = shut[0];
    const [head, text] = WHY[got] ?? ['Could not check your access', got];
    return gate(combined ? `${d.name}: ${head}` : head, text, got === 'signed-out' || !WHY[got]);
  }
  for (const [got, d] of shut) {
    dbs.splice(dbs.indexOf(d), 1);
    toast(`${d.name}: ${(WHY[got] ?? [got])[0]}`, 'info');
  }
  showPrivateTab('banquet.html', code ? `?s=${code}` : ''); // a known code: dbs is empty otherwise
  await load();

  /* Everyone else's claims and marks: what changed, every 10 s while you are
     using the page, every minute once it has sat untouched for 10 minutes, every
     3 minutes while hidden, and at once on coming back to it from the game.
     Untouched for an hour, it pauses until tapped. 7 Oct: every open tab asked
     for its whole list every 15 s, for as long as it was open, overnight too,
     and the database could not keep up (039). */
  // Real input only: a redraw can move the scroll position by itself, which is not someone there.
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'touchmove']) addEventListener(ev, touched, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { touched(); tick(true); } });
  setInterval(tick, 5 * 1000);

  // Keeps the database's yes fresh, and notices a role taken away.
  setInterval(async () => {
    if (paused) return;
    const again = await Promise.all(dbs.map(check));
    if (again.includes('no-role')) location.reload();
  }, 10 * 60 * 1000);
}

/* How long since `t`. A clock moved back (a phone resetting it, say) makes
   anything waiting due at once, and never makes you look away for days. */
const ago_ = (t) => (Date.now() < t ? Infinity : Date.now() - t);
const away = () => Math.max(0, Date.now() - lastActive);
const ACTIVE = 10 * 1000;
const IDLE_AFTER = 10 * 60 * 1000;
const PAUSE_AFTER = 60 * 60 * 1000;
let lastActive = Date.now();
let lastAsk = 0;
let paused = false;
function touched() {
  lastActive = Date.now();
  if (paused) { paused = false; $('#bq-paused').hidden = true; tick(true); }
}
const every = () => (document.hidden ? 3 * 60 * 1000 : away() > IDLE_AFTER ? 60 * 1000 : ACTIVE);
async function tick(now = false) {
  if (!state || paused) return; // no list yet: the first load failed and said so
  if (away() > PAUSE_AFTER) { paused = true; $('#bq-paused').hidden = false; return; }
  if (!now && ago_(lastAsk) < every()) return;
  lastAsk = Date.now();
  await poll();
  offline();
  if ($('#bq-access').open && !document.hidden) loadAccess();
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

/* One server's answer in the view of both, with its groups renumbered after
   its place. A member's answer names no group, so it is that server's base,
   and a server with one group is called by the server's name alone. */
function lift(d) {
  const s = d.state;
  const up = (g) => d.base + (g ?? 0);
  const own = s.groups ?? [0];
  return {
    ...s,
    mine: s.mine.map((m) => ({ ...m, grp: up(m.grp) })),
    banquets: s.banquets.map((b) => ({ ...b, grp: up(b.grp) })),
    events: (s.events ?? []).map((e) => ({ ...e, grp: up(e.grp) })),
    groups: own.map(up),
    names: Object.fromEntries(own.map((g) => [up(g), own.length === 1 ? d.name : `${d.name} · ${s.names?.[g] ?? `Group ${g}`}`])),
    private: (s.private ?? []).map(up),
  };
}

// Both servers as one answer. Both count the same gold rushes, so rounds line up.
function merge(parts) {
  const synced = parts.map((p) => p.synced_at).filter(Boolean).sort();
  return {
    round: parts[0].round,
    current: parts[0].current,
    rounds: [...new Set(parts.flatMap((p) => p.rounds))].sort().reverse(),
    // ponytail: open if any server is; a locked one shows nothing, with no "add N more" for it.
    shared: parts.some((p) => p.shared),
    total: parts.reduce((n, p) => n + p.total, 0),
    mine: parts.flatMap((p) => p.mine),
    banquets: parts.flatMap((p) => p.banquets),
    events: parts.flatMap((p) => p.events).sort((a, b) => b.at.localeCompare(a.at)),
    groups: parts.flatMap((p) => p.groups),
    names: Object.assign({}, ...parts.map((p) => p.names)),
    private: parts.flatMap((p) => p.private),
    synced_at: synced[0] ?? null,
  };
}

/* `quiet` is the timer's: a failed refresh keeps what is on screen, where a
   failed load someone asked for says so. */
async function load(round = null, quiet = false) {
  /* A refresh sends the fingerprint of what it holds; an unchanged list comes
     back as a few bytes saying so, rather than the whole list again. */
  const same = quiet && state && (round ?? state.current) === state.round;
  const got = await Promise.all(dbs.map((d) => ask(d, 'banquet_state', { r: round, known: same ? d.state?.hash ?? null : null })));
  const bad = got.find((x) => !x.ok);
  if (bad) return quiet ? undefined : gate('Could not load the banquets', bad.why, true);
  reached = Date.now();
  const changed = got.some((x) => !x.data.same);
  const before = state;
  dbs.forEach((d, i) => {
    const a = got[i].data;
    d.state = a.same ? { ...d.state, synced_at: a.synced_at } : a;
    d.since = a.since; // what changed is asked from here
  });
  lastFull = Date.now();
  state = combined ? merge(dbs.map(lift)) : dbs[0].state;
  if (!seen || before?.round !== state.round) loadSeen(state.round, state.banquets);
  // Just unlocked: the list is new to you all at once, which is the same as none of it.
  else if (!before.shared && state.shared) markSeen(...state.banquets.map(keyOf));
  else if (changed && quiet) diff(before, state);
  status('');
  $('#bq-gate').hidden = true;
  $('#bq-app').hidden = false;
  render();
  if (changed && state.groups) loadCopies();
}

/* What changed since the last answer, merged into what is held: the cards
   that moved, whole, and the ones gone. A few rows, however big the list. A
   full load instead when the database says this page is too far behind, when
   the list has just opened to you, when the gold rush turns, and every hour
   in case anything slipped past (a whole list is 0.4-1 MB). A past round does not change. */
let lastFull = 0;
let lastDrawn = 0;
async function poll() {
  if (!state) return;
  if (state.round !== state.current) return;
  if (ago_(lastFull) > 60 * 60 * 1000 || dbs.some((d) => !d.since)) return load(null, true);
  const got = await Promise.all(dbs.map((d) => ask(d, 'banquet_changes', { since: d.since })));
  if (got.some((x) => !x.ok)) return; // keeps what is on screen; offline() says so after two minutes
  reached = Date.now();
  if (got.some((x, i) => x.data.reload || x.data.current !== dbs[i].state.current
      || (x.data.shared && !dbs[i].state.shared))) return load(null, true);
  const before = state;
  let changed = false;
  dbs.forEach((d, i) => {
    const a = got[i].data;
    const s = d.state;
    const byKey = new Map(s.banquets.map((b) => [keyOf(b), b]));
    for (const g of a.gone) byKey.delete(keyOf(g));
    for (const c of a.cards) byKey.set(keyOf(c), c);
    const groups = a.groups ? { groups: a.groups, names: a.names, private: a.private } : {};
    changed ||= a.cards.length > 0 || a.gone.length > 0 || a.shared !== s.shared || a.total !== s.total
      || !!a.covered !== !!s.covered || JSON.stringify(a.mine) !== JSON.stringify(s.mine)
      || (a.groups && JSON.stringify([a.groups, a.names, a.private]) !== JSON.stringify([s.groups, s.names, s.private]));
    // New log lines go on top of what is held; one sent twice (the 30 s overlap) is kept once.
    const line = (e) => `${e.at}|${e.kind}|${e.grp ?? ''}|${e.uid}|${e.by}`;
    const events = a.events_new?.length
      ? [...new Map([...a.events_new, ...(s.events ?? [])].map((e) => [line(e), e])).values()]
        .sort((x, y) => y.at.localeCompare(x.at)).slice(0, 200)
      : s.events;
    changed ||= events !== s.events;
    d.state = { ...s, ...groups, banquets: [...byKey.values()], mine: a.mine, shared: a.shared, total: a.total,
      synced_at: a.synced_at, covered: a.covered, events };
    d.since = a.since;
  });
  // Unchanged, it is still drawn once a minute: "5 min ago" and the reset countdown move on their own.
  if (!changed && ago_(lastDrawn) < 60 * 1000) return;
  state = combined ? merge(dbs.map(lift)) : dbs[0].state;
  if (changed) diff(before, state);
  render();
  if (changed && state.groups) loadCopies();
}
// After your own press: what changed, at once, rather than the whole list.
const fresh = () => (state.round === state.current ? poll() : load(state.round));

// ------------------------------------------------------------------ access log

// A copy is the one sign of taking the site can see. Not waited on: it must never slow the copy.
function noteCopy(key) {
  const [g, uid] = key.split(':');
  call('banquet_note_copy', { target: Number(uid), g: g ? Number(g) : null });
}

/* The access log and possible copies, from each server that lets you see them,
   with their groups renumbered as lift() does. One server: its answer as is. */
async function fromEach(fn, body, renumber) {
  const got = await Promise.all(dbs.filter((d) => d.state?.groups).map(async (d) => {
    const x = await ask(d, fn, body);
    return x.ok && combined ? { ok: true, data: renumber(x.data, (g) => d.base + g) } : x;
  }));
  const bad = got.find((x) => !x.ok);
  return bad ?? { ok: true, data: got.map((x) => x.data) };
}

const FLAGS = {
  'copied-not-claimed': 'copied far more than they claimed',
  'took-not-shared': 'took without sharing',
  script: 'reads like a script, not the page',
};

async function loadAccess() {
  const got = await fromEach('banquet_access_log', { days: 7 }, (people, up) => people.map((p) => ({
    ...p, groups: p.groups.map(up), recent: p.recent.map((v) => ({ ...v, groups: v.groups.map(up) })) })));
  if (!got.ok) { $('#bq-access-body').textContent = got.why; return; }
  const people = got.data.flat();
  const flagged = people.filter((p) => p.flags.length).length;
  $('#bq-access-n').textContent = `(${people.length} people${flagged ? `, ${flagged} flagged` : ''})`;
  const day = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  $('#bq-access-body').innerHTML = people.length ? `<ul class="bq-copies__list bq-access__list">${people.map((p) => `<li${p.flags.length ? ' class="is-flagged"' : ''}>
      <b>${esc(p.name)}</b> ${p.groups.map((g) => `<span class="bq-grp">${esc(nameOf(g))}</span>`).join(' ')}
      ${p.flags.map((f) => `<span class="bq-access__flag">${FLAGS[f] ?? esc(f)}</span>`).join(' ')}
      <div class="bq-access__nums">copied <b>${p.copied}</b> · claimed <b>${p.claimed}</b> · shared <b>${p.shared}</b>
        · ${p.visits} visit${p.visits === 1 ? '' : 's'}, ${p.minutes} min · up to ${p.per_min} refreshes a minute
        ${p.past_visits ? `· looked at past gold rushes ${p.past_visits}×` : ''} · last ${day(p.last)}</div>
      <details><summary>Visits</summary><ul>${p.recent.map((v) => `<li>${day(v.start)} to ${time(v.last)}
        · ${v.groups.map((g) => esc(nameOf(g))).join(' + ')} · ${v.reads} refreshes · ${v.copied} copied</li>`).join('')}</ul></details>
    </li>`).join('')}</ul>` : '<p class="muted">Nobody in the last 7 days.</p>';
}
$('#bq-access').addEventListener('toggle', () => { if ($('#bq-access').open) loadAccess(); });

// ------------------------------------------------------------------ possible copies

async function loadCopies() {
  const got = await fromEach('banquet_copies', { r: state.round }, (c, up) => ({
    people: c.people.map((p) => ({ ...p, grp: up(p.grp), items: p.items.map((i) => ({ ...i, first_grp: i.first_grp && up(i.first_grp) })) })),
    both_groups: c.both_groups.map((b) => ({ ...b, groups: Object.fromEntries(Object.entries(b.groups).map(([g, n]) => [up(Number(g)), n])) })),
  }));
  if (!got.ok) return;
  const people = got.data.flatMap((c) => c.people);
  const both = got.data.flatMap((c) => c.both_groups);
  const n = people.length + both.length;
  $('#bq-copies-n').textContent = n ? `(${n})` : '(none)';
  const whenBy = (by, g, at) => `${esc(by)}, ${esc(nameOf(g))}, ${time(at)}`;
  $('#bq-copies-body').innerHTML = (people.length ? `<h3>Posted after someone else</h3><ul class="bq-copies__list">${people.map((p) => `<li>
      <b>${esc(p.name)}</b> <span class="bq-grp">${esc(nameOf(p.grp))}</span>
      <span class="${p.all_copied ? 'bq-copies__all' : 'muted'}">${p.all_copied ? `all ${p.uids} posted earlier by others` : `${p.copied} of ${p.uids} posted earlier by others`}</span>
      <ul>${p.items.filter((i) => i.first_by).map((i) => `<li><span class="bq-copies__uid">${i.uid}</span>
        first by ${whenBy(i.first_by, i.first_grp, i.first_at)} · theirs ${time(i.at)}</li>`).join('')}</ul>
    </li>`).join('')}</ul>` : '')
    + (both.length ? `<h3>In both groups</h3><ul class="bq-copies__list">${both.map((b) => `<li>
      <span class="bq-copies__uid">${b.uid}</span> ${Object.entries(b.groups).map(([g, names]) => `${esc(nameOf(Number(g)))}: ${esc(names.join(', '))}`).join(' · ')}
    </li>`).join('')}</ul>` : '')
    || '<p class="muted">Nothing this round.</p>';
}

/* A refresh that fails keeps the list on screen, so a phone that lost its
   signal would show an old list as if it were live. Two minutes without an
   answer says so, and it goes once an answer comes back. */
function offline() {
  const min = paused ? 0 : Math.floor((Date.now() - reached) / 60000);
  $('#bq-stale').hidden = min < 2;
  if (min < 2) return;
  $('#bq-stale').hidden = false;
  $('#bq-stale').textContent = `This page has not reached the list for ${min} minutes, so what you see may be out of date. Check your connection.`;
}

// ------------------------------------------------------------------ render

function render() {
  lastDrawn = Date.now();
  const past = state.round !== state.current;
  // First, as everything below is in its view: a member, or a stale choice (a group that went away).
  if (!state.groups?.includes(group)) group = 0;
  $('#bq-sub').textContent = `Gold rush ${span(state.current)}`;
  if (document.activeElement !== $('#bq-round')) $('#bq-round').innerHTML = state.rounds
    .map((r) => `<option value="${r}"${r === state.round ? ' selected' : ''}>${span(r)}${r === state.current ? ' (now)' : ''}</option>`)
    .join('');
  $('#bq-when').textContent = past ? 'A past round, read only.'
    : before(state.round) ? `Resets 00:00 UTC · ${yourTime(opens(state.round))} your time`
    : `Reset ${yourTime(opens(state.round))} your time`;

  // Yours: added here, and they can go. Ones read from Discord, in older rounds, cannot.
  const n = state.mine.length;
  const mineShown = state.mine.filter((m) => !m.grp || inView(m.grp)).reverse(); // newest first, under the box
  // Each one's status, once the list is open to you.
  const cards = new Map(state.banquets.map((b) => [keyOf(b), b]));
  const statusMine = (m) => { const b = cards.get(keyOf(m)); return b && statusOf(b); };
  // Left alone while one is being edited: a refresh must not throw the edit away.
  if (!editing) $('#bq-my').innerHTML = mineShown.map((m) => `<li class="bq-mine__uid">
      ${tagOf(m.grp)}<button type="button" class="tr-copy" data-copy="${m.uid}" title="Copy UID">${m.uid}</button>
      ${statusMine(m) ? `<span class="bq-mine__st is-${statusMine(m)}">${MINE[statusMine(m)]}</span>` : ''}
      ${likesMine(cards.get(keyOf(m)))}
      ${m.source === 'discord' ? '<span class="bq-src">from Discord</span>'
        : past ? '' : `<button type="button" class="btn btn--quiet" data-edit="${m.uid}"${grpAttr(m.grp)} aria-label="Edit ${m.uid}">Edit</button>
          <button type="button" class="btn btn--quiet" data-remove="${m.uid}"${grpAttr(m.grp)} aria-label="Remove ${m.uid}">Remove</button>`}
    </li>`).join('') || `<li class="muted">${past ? 'None this gold rush.' : 'None yet. Add them here.'}</li>`;
  const asleep = past ? [] : mineShown.filter((m) => statusMine(m) === 'notin').map((m) => m.uid);
  $('#bq-remind').hidden = !asleep.length;
  $('#bq-remind').innerHTML = asleep.length ? `${asleep.join(', ')} ${asleep.length > 1 ? "haven't" : "hasn't"} logged in since the reset.
    <button type="button" class="btn btn--quiet" data-remind="${asleep.join(', ')}">Copy a reminder</button>` : '';
  $('#bq-mine .bq-mine__actions').hidden = past;
  $('#bq-mine-n').textContent = mineShown.length ? `(${mineShown.length})` : '';
  /* Folded on arrival when there is nothing left to do in it; never while it
     is being used. One of yours not logged in is something to do: the
     reminder to copy is in there, so it opens, on arrival or whenever one
     newly turns not logged in. Folding it again after that is yours. */
  if (!folded) { $('#bq-mine-fold').open = !!asleep.length || !!state.covered || !((past || state.shared) && mineShown.length); folded = true; }
  else if (asleep.some((u) => !wasAsleep.includes(u))) $('#bq-mine-fold').open = true;
  wasAsleep = asleep;
  /* The groups are Discord roles, and a role can be added or renamed while
     the page is open: the group buttons and the picker are redrawn whenever
     the set or a name changes, not only on the first answer. */
  const sig = state.groups ? JSON.stringify([state.groups, state.names, state.private]) : '';
  const regroup = sig !== drawnGroups;
  drawnGroups = sig;
  const pick = $('#bq-add-grp');
  pick.hidden = !state.groups || !!group;
  if (state.groups && regroup) {
    const was = pick.value;
    pick.innerHTML = `<option value="">${combined ? 'Server…' : 'Group…'}</option>${state.groups.map((g) => `<option value="${g}">${esc(nameOf(g))}</option>`).join('')}`;
    pick.value = state.groups.includes(Number(was)) ? was : '';
  }

  const open = past || state.shared;
  $('#bq-locked').hidden = open;
  // Covered: the group's list opens at the reset, however many you add.
  $('#bq-locked').textContent = state.covered
    ? `The list opens at the reset, ${yourTime(opens(state.round))} your time. Add your UIDs now: until then, only you see them.`
    : `${state.total} banquet${state.total === 1 ? '' : 's'} shared this round. `
      + `Add ${4 - n} more UID${4 - n === 1 ? '' : 's'} of your own to see them.`;
  $('#bq-list').hidden = !open;
  $('#bq-view').hidden = !state.groups || shot;
  $('#bq-copies').hidden = !state.groups || shot || !!group;
  $('#bq-access').hidden = !state.groups || shot || !!group;
  const groups = $('#bq-groups');
  if (state.groups && regroup) {
    groups.innerHTML = [0, ...state.groups].map((g) => `<button class="segmented__btn" type="button" data-group="${g}"
      aria-pressed="${g === group}">${!g ? (combined ? 'Both servers' : 'All groups') : isPrivate(g) ? esc(nameOf(g)) : `As ${esc(nameOf(g))}`}</button>`).join('');
  }
  $('#bq-view-note').textContent = !group ? ''
    : isPrivate(group) ? `${nameOf(group)}: only the people added to it can see it. Anything you add or press is kept here.`
    : `What ${nameOf(group)} members see. Anything you press counts for ${nameOf(group)}.`;
  if (open) renderCards(past);
  renderLikesDue(open && !past);
  renderNews(open && !past);
  renderLog(open, past);
}

// ------------------------------------------------------------------ activity

/* Every claim, mark and post this gold rush, newest first, with who and when:
   what moved a banquet to where it is, and whether to trust it. Each kind
   wears the icon and colour its status has on the cards and in the claim run
   (a gift for a gift seen, the portrait for full, the moon for not logged in),
   so a long log scans by shape before a word of it is read. */
const SAID = {
  post: ['post', (u) => `posted ${u}`],
  claim: ['claim', (u) => `claimed ${u}`],
  unclaim: ['unclaim', (u) => `took back their claim on ${u}`],
  open: ['gift', (u) => `saw the gift on ${u}`],
  full: ['full', (u) => `marked ${u} full`],
  'not-yet': ['notin', (u) => `found ${u} not logged in`],
  clear: ['clear', (u) => `cleared the mark on ${u}`],
};
// The last hour as minutes, anything older as the day and time.
const when = (iso) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 1 ? 'just now' : min < 60 ? `${min} min`
    : new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
/* A line about a banquet you can claim right now is the quickest way to it:
   its newest line, only, gets the card's own buttons (Copy UID, I claimed it,
   Full, Not logged in), handled by the same code. Claimed or full since, that line says so
   instead. Older lines about the same UID stay plain, so nothing repeats. */
function logAction(e, b, past) {
  if (past || !b) return '';
  if (b.claimed) return '<span class="bq-log__state is-claimed">You claimed it</span>';
  if (b.full) return e.kind === 'full' ? '' : '<span class="bq-log__state is-full">Full now</span>';
  if (statusOf(b) !== 'claimable') return '';
  return `<span class="bq-log__act">
      <button type="button" class="tr-copy bq-log__btn" data-copy="${b.uid}" aria-label="Copy UID ${b.uid}">Copy UID</button>
      <button type="button" class="btn bq-log__btn" data-claim="${b.uid}"${grpAttr(b.grp)} aria-label="I claimed it, ${b.uid}" aria-pressed="false">I claimed it</button>
      <button type="button" class="btn btn--quiet bq-log__btn" data-mark="full" data-uid="${b.uid}"${grpAttr(b.grp)} aria-label="Full: ${b.uid}" aria-pressed="false">Full</button>
      <button type="button" class="btn btn--quiet bq-log__btn" data-mark="not-yet" data-uid="${b.uid}"${grpAttr(b.grp)} aria-label="Not logged in: ${b.uid}" aria-pressed="false">Not logged in</button>
    </span>`;
}
function renderLog(on, past) {
  $('#bq-activity').hidden = !on;
  if (!on) return;
  // ponytail: the newest 50 of the 200 the database sends; a "more" button if a round ever needs it.
  const events = (state.events ?? []).filter((e) => !e.grp || inView(e.grp)).slice(0, 50);
  const cards = new Map(state.banquets.map((b) => [keyOf(b), b]));
  /* Labelling MVPs must never cost the labeller a banquet: what they can claim
     right now is counted in the heading and lit up in the log, so it is in
     view while they mark the rest. */
  const canClaim = (b) => !past && b && !b.claimed && !b.full && statusOf(b) === 'claimable';
  const open = state.banquets.filter((b) => (!b.grp || inView(b.grp)) && canClaim(b)).length;
  $('#bq-log-claim').hidden = !open;
  $('#bq-log-claim').textContent = open ? `· ${open} to claim` : '';
  const done = new Set(); // UIDs whose newest line is drawn: the rest are older news
  $('#bq-log').innerHTML = events.map((e) => {
    const k = keyOf(e);
    const newest = !done.has(k);
    done.add(k);
    const [look, say] = SAID[e.kind] ?? ['clear', (u) => `${esc(e.kind)} ${u}`];
    return `<li class="is-${look}${newest && canClaim(cards.get(k)) ? ' is-claimable' : ''}" data-key="${k}">
      ${icon(look, 18)}
      <span class="bq-log__what">${tagOf(e.grp)}<b>${esc(e.by)}</b> <span class="bq-log__verb">${say(`<span class="bq-log__uid">${e.uid}</span>`)}</span></span>
      <time datetime="${e.at}">${when(e.at)}</time>
      ${newest ? logAction(e, cards.get(k), past) : ''}
    </li>`;
  }).join('') || '<li class="muted">Nothing yet this gold rush.</li>';
}

/* The last day of a round is when people check the buildings, before the
   reset: a count noted now is the next round's "before". Says how many in
   view still have none, and offers to show just those. */
const DUE = 24 * 3600 * 1000;
let onlyUnnoted = false;
const unnoted = (b) => !b.likes_now;
/* Likes: All, Has likes (more than 0: MVP before, so a portrait may be old),
   0 likes (never MVP before: a portrait there means full) or Not noted (nobody
   has looked). By the newest count, since the reset or before it. */
let likesShow = 'all';
const LIKES = {
  all: () => true,
  has: (b) => (b.likes_now ?? b.likes_before)?.n > 0,
  zero: (b) => (b.likes_now ?? b.likes_before)?.n === 0,
  none: (b) => !(b.likes_now ?? b.likes_before),
};
function renderLikesDue(on) {
  const left = on ? (before(state.round) ? opens(state.round) : closes(state.round)).getTime() - Date.now() : 0;
  const list = state.banquets.filter((b) => !b.grp || inView(b.grp));
  const missing = list.filter(unnoted).length;
  const show = on && left > 0 && left <= DUE && list.length > 0;
  $('#bq-likes-due').hidden = !show;
  if (!show) { onlyUnnoted = false; return; }
  const h = Math.max(1, Math.round(left / 3600e3));
  $('#bq-likes-due').innerHTML = `${icon('heart', 15)}<span>Reset in ${h} h. ${missing
    ? `<b>${missing}</b> of ${list.length} building${list.length === 1 ? '' : 's'} have no likes noted yet. Noting them now means nobody mistakes a portrait for full after the reset.`
    : 'Every building has its likes noted for next round.'}</span>
    ${missing ? `<button type="button" class="btn btn--quiet" data-unnoted aria-pressed="${onlyUnnoted}">${onlyUnnoted ? 'Show all' : 'Show those'}</button>` : ''}`;
}
$('#bq-likes-due').addEventListener('click', (e) => {
  if (!e.target.closest('[data-unnoted]')) return;
  onlyUnnoted = !onlyUnnoted;
  render();
});

// ------------------------------------------------------------------ what is new

function renderNews(on) {
  const fresh = on ? state.banquets.filter((b) => isNew(b) && (!b.grp || inView(b.grp))) : [];
  fresh.sort((a, b) => (b.posted ?? '').localeCompare(a.posted ?? ''));
  $('#bq-new').hidden = !fresh.length;
  $('#bq-new-uids').innerHTML = fresh.slice(0, 6).map((b) => `<button type="button" class="bq-new__uid"
      data-new="${keyOf(b)}" data-copy="${b.uid}" title="Copy and show">${b.uid}</button>`).join('')
    + (fresh.length > 6 ? `<span class="muted">+${fresh.length - 6}</span>` : '');
  const last = on ? latest.find((l) => Date.now() - l.at < 30 * 60 * 1000) : null;
  $('#bq-latest').hidden = !last;
  if (last) {
    const min = Math.floor((Date.now() - last.at) / 60000);
    $('#bq-latest').textContent = `Latest: ${last.text} · ${min < 1 ? 'just now' : `${min} min ago`}`;
  }
  document.title = fresh.length ? `(${fresh.length}) ${TITLE}` : TITLE;
}

/* Four statuses, from what someone last saw in the game. A banquet opens once
   its MVP logs in after the reset and stays open until 50 players anywhere
   have claimed it, so a claim is a gift seen, and the site's own count is only
   a floor. A UID nobody has looked at yet needs a look. */
const statusOf = (b) => (b.full ? 'full' : b.not_yet ? 'notin' : b.open || b.claims ? 'claimable' : 'look');
const SECTIONS = [
  ['claimable', 'Claimable', 'most room first'],
  ['look', 'Needs a look', 'nobody has checked'],
  ['notin', 'Not logged in yet', 'longest unchecked first'],
  ['full', 'Full', ''],
];
// The same, as words beside your own UIDs.
const MINE = { claimable: 'claimable', look: 'needs a look', notin: 'not logged in', full: 'full' };
// What "Copy a reminder" copies, to send to whoever plays that MVP.
const reminder = (uids) => `Your MVP banquet has not opened yet (UID ${uids}). `
  + 'It opens once the MVP logs in after the gold rush reset, so please log in once today. Thank you!';
/* Likes. Each full banquet leaves 50 on its MVP's building, so the count
   before the reset says how many times it has been MVP, and the portrait it
   shows until its MVP logs in again looks exactly like "full". A building that
   had a banquet before (50 or more) gets asked about before Full is believed:
   the same count as before is not logged in yet, fifty more is full. */
const PER = 50;
const hadOne = (b) => (b.likes_before?.n ?? 0) >= PER;
const fullAt = (b) => b.likes_before.n + PER;
const times = (n) => Math.floor(n / PER);
let likesFor = null; // "grp:uid" whose likes box is open
let likesDraft = '';
let askFull = null; // "grp:uid" whose Full press is waiting on the likes question
function likesRow(b, past) {
  const k = keyOf(b);
  const bf = b.likes_before;
  const nw = b.likes_now;
  if (!past && likesFor === k) {
    return `<div class="bq-likes bq-likes--edit">
        <label>Likes on the building <input class="field" data-likes-input inputmode="numeric" pattern="[0-9]*" maxlength="6"
          autocomplete="off" value="${esc(likesDraft)}" aria-label="Likes on ${b.uid}'s building"></label>
        <button type="button" class="btn btn--primary" data-likes-save="${b.uid}"${grpAttr(b.grp)}>Save</button>
        <button type="button" class="btn btn--quiet" data-likes-cancel>Cancel</button>
      </div>`;
  }
  const said = [
    bf ? `<span title="${esc(`${bf.by}, ${new Date(bf.at).toLocaleString()}`)}">Before reset <b>${bf.n}</b>${
      times(bf.n) ? ` · MVP ${times(bf.n)}× before` : ''}</span>` : '',
    nw ? `<span title="${esc(`${nw.by}, ${new Date(nw.at).toLocaleString()}`)}">Now <b>${nw.n}</b> · ${esc(nw.by)} ${since(nw.at)}</span>` : '',
  ].filter(Boolean).join('');
  // Nothing noted: no row, only the heart button up in the card's first line.
  if (!said) return '';
  return `<div class="bq-likes">${icon('heart', 14)}${said}
      ${past ? '' : `<button type="button" class="btn btn--quiet bq-likes__btn" data-likes="${k}" aria-label="Update the likes on ${b.uid}">Update</button>`}
    </div>`;
}
// The way in when nothing is noted yet: a heart, kept small so a long list stays short.
// Beside your own UIDs: the newest count noted, if any.
const likesMine = (b) => {
  const n = (b?.likes_now ?? b?.likes_before)?.n;
  return n == null ? '' : `<span class="bq-mine__likes" title="Likes on the building">${icon('heart', 12)}${n}</span>`;
};
const likesAdd = (b, past) => (past || b.likes_before || b.likes_now ? ''
  : `<button type="button" class="btn btn--quiet bq-likes__add" data-likes="${keyOf(b)}" aria-label="Note the likes on ${b.uid}" title="Note the likes on its building">${icon('heart', 15)}<span>Likes</span></button>`);
// The question Full waits on, for a building that had a banquet before.
const askRow = (b) => `<div class="bq-ask" role="group" aria-label="Full or not logged in">
    <p>Before the reset this building had <b>${b.likes_before.n}</b> likes. The portrait stays up until its MVP logs in. What does it show now?</p>
    <button type="button" class="btn" data-mark="full" data-sure data-uid="${b.uid}"${grpAttr(b.grp)}>${fullAt(b)} or more · Full</button>
    <button type="button" class="btn" data-mark="not-yet" data-sure data-uid="${b.uid}"${grpAttr(b.grp)}>Still ${b.likes_before.n} · Not logged in</button>
    <button type="button" class="btn btn--quiet" data-ask-cancel>Cancel</button>
  </div>`;

// Within a status: yours already claimed last, then fewest claims, the likeliest to have room.
const ORDER = {
  claimable: (a, b) => a.claimed - b.claimed || a.claims - b.claims || a.uid.localeCompare(b.uid),
  look: (a, b) => (b.posted ?? '').localeCompare(a.posted ?? '') || a.uid.localeCompare(b.uid),
  notin: (a, b) => a.not_yet.at.localeCompare(b.not_yet.at) || a.uid.localeCompare(b.uid),
  full: (a, b) => a.uid.localeCompare(b.uid),
};

// The UID, or anyone named on the card: who posted it, who claimed it, who marked it.
const found = (b) => !find || b.uid.includes(find)
  || [...b.entered_by, ...b.claimed_by, b.full, b.not_yet?.by].some((n) => n && n.toLowerCase().includes(find));

/* The last UID you copied, so the card you are checking in the game stays
   easy to find as the list reorders and refreshes. Kept per browser. */
const LAST = `coc.banquet.lastcopied${K}`;
let lastCopied = null; // "grp:uid"
try { lastCopied = localStorage.getItem(LAST); } catch { /* this visit only */ }
function setLastCopied(k) {
  lastCopied = k;
  try { localStorage.setItem(LAST, k); } catch { /* this visit only */ }
  renderCards(state.round !== state.current); // moves the colour and the label, and the button with them
}
function renderLast() {
  const b = lastCopied && state?.banquets.find((x) => keyOf(x) === lastCopied);
  $('#bq-last').hidden = !b;
  if (b) $('#bq-last').innerHTML = `Last copied <b>${b.uid}</b> <span aria-hidden="true">↕</span>`;
}

function card(b, past) {
  const st = statusOf(b);
  const k = keyOf(b);
  const mark = (to, label, aria, pressed) => `<button type="button" class="btn btn--quiet" data-mark="${to}" data-uid="${b.uid}"${grpAttr(b.grp)}
    aria-label="${aria}: ${b.uid}"${pressed == null ? '' : ` aria-pressed="${pressed}"`}>${label}</button>`;
  const actions = past ? '' : st === 'full' ? mark('full', 'Not full', 'Not full', true)
    : st === 'notin' ? mark('open', 'Open now', 'Open now', false) + mark('not-yet', 'Still not open', 'Still not open')
    : `<button type="button" class="btn${b.claimed ? ' btn--primary' : ''}" data-claim="${b.uid}"${grpAttr(b.grp)} aria-label="I claimed ${b.uid}" aria-pressed="${b.claimed}">${b.claimed ? 'Claimed ✓' : 'I claimed'}</button>`
      + mark('full', 'Full', 'Full', false)
      + mark('not-yet', '<span class="bq-long">Not logged in</span><span class="bq-short">Not in</span>', 'Not logged in', false);
  const tag = {
    claimable: `<span class="bq-tag bq-tag--ok">${b.open ? `Gift seen ${since(b.open.at)}` : 'Gift seen'}</span>`,
    look: '',
    notin: '<span class="bq-tag bq-tag--wait">Not logged in</span>',
    full: `<span class="bq-tag">Full<small> · ${esc(b.full ?? '')}</small></span>`,
  }[st];
  const gone = b.claims ? `<details class="bq-card__claims">
        <summary>at least ${b.claims} of 50 gone</summary>
        <p>${esc(b.claimed_by.join(', '))}</p>
      </details>` : `<p class="bq-card__meta">${st === 'look' ? 'Not checked yet' : 'No claims here yet'}</p>`;
  return `<li data-key="${k}" class="bq-card is-${st}${b.claimed ? ' is-claimed' : ''}${k === lastCopied ? ' is-last-copied' : ''}">
      <div class="bq-card__id">
        ${tagOf(b.grp)}
        <button type="button" class="tr-copy bq-uid" data-copy="${b.uid}" title="Copy UID">${b.uid}</button>
        ${tag}
        ${isNew(b) ? '<span class="bq-tag bq-tag--new">New</span>' : ''}
        ${k === lastCopied ? '<span class="bq-tag bq-tag--last">Last copied</span>' : ''}
        ${likesFor === k ? '' : likesAdd(b, past)}
      </div>
      ${st === 'notin' ? `<p class="bq-card__checked">Last checked ${ago(b.not_yet.at)} by ${esc(b.not_yet.by)}</p>` : ''}
      ${st === 'full' ? '' : `<div class="bq-card__row">
      <p class="bq-card__meta">From ${esc(b.entered_by.join(', '))}${b.posted ? ` · ${time(b.posted)}` : ''}${b.open ? ` · checked by ${esc(b.open.by)}` : ''}</p>
      ${gone}
      </div>`}
      ${likesRow(b, past)}
      ${!past && askFull === k && hadOne(b) ? askRow(b) : actions ? `<div class="bq-card__actions">${actions}</div>` : ''}
    </li>`;
}

function renderCards(past) {
  const inViewList = state.banquets.filter((b) => !b.grp || inView(b.grp));
  for (const [st] of SECTIONS) $(`[data-n="${st}"]`).textContent = inViewList.filter((b) => statusOf(b) === st).length;
  for (const x of $$('[data-show]')) x.setAttribute('aria-pressed', String(x.dataset.show === show));
  for (const x of $$('[data-liked]')) {
    x.setAttribute('aria-pressed', String(x.dataset.liked === likesShow));
    x.title = `${inViewList.filter(LIKES[x.dataset.liked]).length} buildings`;
  }
  const shown = inViewList.filter((b) => found(b) && (!onlyUnnoted || unnoted(b)) && LIKES[likesShow](b));
  const opened = new Set($$('#bq-cards details[open]').map((d) => d.closest('li').dataset.key));
  const typing = document.activeElement?.matches?.('[data-likes-input]'); // a refresh must not take the box from under a thumb
  $('#bq-cards').innerHTML = SECTIONS.filter(([st]) => !show || show === st).map(([st, head, note]) => {
    const list = shown.filter((b) => statusOf(b) === st).sort(ORDER[st]);
    if (!list.length && !show) return '';
    return `<section class="bq-section">
      <h2>${head}${note && list.length > 1 ? ` <span class="muted">· ${note}</span>` : ''}</h2>
      <ul class="bq-cards">${list.map((b) => card(b, past)).join('') || '<li class="muted bq-none">Nothing here.</li>'}</ul>
    </section>`;
  }).join('') || `<p class="muted bq-none">${inViewList.length ? 'Nothing matches.' : 'No banquets shared this round yet.'}</p>`;
  for (const d of $$('#bq-cards details')) d.open = opened.has(d.closest('li').dataset.key);
  if (typing) { const box = $('#bq-cards [data-likes-input]'); box?.focus(); box?.setSelectionRange(box.value.length, box.value.length); }
  const due = past ? 0 : runQueue().length;
  $('#bq-run-start').hidden = past;
  $('#bq-run-start').disabled = !due;
  $('#bq-run-start').textContent = due ? `Start claim run · ${due} to go` : 'Claim run: nothing to check right now';
  renderLast();
}

// ------------------------------------------------------------------ claim run

/* One UID at a time, already copied, and what the game showed for it. In
   order: claimable ones you have not claimed, most room first; then those
   nobody has checked; then those not logged in when last checked, once that
   was an hour ago or more. */
const RECHECK = 60 * 60 * 1000;
/* Clusters, so people checking at once do not all start at the same UID: each
   person is one of four, fixed by their sign-in, and the unchecked lists (Needs a
   look, Not logged in) start a quarter further along for each and wrap round.
   Everyone still gets every UID; Claimable stays most room first for all, since
   everyone claims every one of those anyway. */
const CLUSTERS = 4;
const cluster = [...(whoAmI()?.uid ?? '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % CLUSTERS;
const fromMine = (list) => {
  const at = Math.floor((cluster * list.length) / CLUSTERS);
  return [...list.slice(at), ...list.slice(0, at)];
};
function runQueue() {
  const list = state.banquets.filter((b) => !b.grp || inView(b.grp));
  const pick = (st, ok) => list.filter((b) => statusOf(b) === st && ok(b)).sort(ORDER[st]);
  return [...pick('claimable', (b) => !b.claimed), ...fromMine(pick('look', () => true)),
    ...fromMine(pick('notin', (b) => Date.now() - Date.parse(b.not_yet.at) >= RECHECK))].map(keyOf);
}
let run = null; // { queue: ["grp:uid"], i, tally }
const cardOf = (k) => state.banquets.find((b) => keyOf(b) === k);
// Still worth showing: someone else may have marked it full, or you claimed it on its card, mid-run.
const stillDue = (k) => { const b = cardOf(k); return b && !b.full && !b.claimed; };

const ICON = {
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  full: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  notin: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  skip: '<path d="M5 4l10 8-10 8z"/><path d="M19 5v14"/>',
  // The activity log's own kinds: a post, a claim, a claim taken back, a mark cleared.
  post: '<path d="M12 5v14M5 12h14"/>',
  claim: '<path d="M20 6 9 17l-5-5"/>',
  unclaim: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  clear: '<path d="M18 6 6 18M6 6l12 12"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
};
const icon = (k, size = 26) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

const TALLY = [['gift', 'claimed'], ['full', 'full'], ['notin', 'not logged in'], ['skip', 'skipped']];
function renderRun() {
  const total = run.queue.length;
  const b = run.i < total ? cardOf(run.queue[run.i]) : null;
  const t = run.tally;
  $('#bq-run-step').textContent = b ? `${run.i + 1} / ${total}` : 'done';
  $('#bq-run-bar').style.width = `${total ? Math.round((Math.min(run.i, total) / total) * 100) : 100}%`;
  /* The tally as the answers' own icons, each with its count: one line on the
     narrowest phone, where the words ran to three. The words stay, for a
     screen reader, and as a tooltip. */
  $('#bq-run-tally').innerHTML = `<span class="sr-only">So far: </span>${TALLY.map(([k, word], i) => `<span class="bq-run__t is-${k}" title="${t[k]} ${word}">
      ${icon(k, 16)}<b>${t[k]}</b><span class="sr-only"> ${word}${i < TALLY.length - 1 ? ', ' : ''}</span></span>`).join('')}`;
  if (!b) {
    $('#bq-run-body').innerHTML = `<section class="bq-run__card">
        <h3>${total ? 'Run finished' : 'Nothing to check right now'}</h3>
        <p>${total ? `You claimed ${t.gift}, spotted ${t.full} full and ${t.notin} not logged in.`
          : 'Every banquet is claimed by you, full, or was checked less than an hour ago.'}</p>
        <button type="button" class="btn" data-run="again">Run it again</button>
      </section>`;
    return;
  }
  if (run.ask) {
    $('#bq-run-body').innerHTML = `<section class="bq-run__card" data-key="${keyOf(b)}">
        <button type="button" class="tr-copy bq-run__uid" data-copy="${b.uid}" title="Copy UID">${b.uid}</button>
        <span class="bq-run__about">${tagOf(b.grp)} before the reset: ${b.likes_before.n} likes, MVP ${times(b.likes_before.n)}× before</span>
      </section>
      <p class="bq-run__ask">The portrait stays up until its MVP logs in. How many likes now?</p>
      <div class="bq-run__answers">
        <button type="button" class="bq-run__btn is-full" data-run="full!">${icon('full')}<span>${fullAt(b)} or more · it's full<small>Takes it off everyone's list</small></span></button>
        <button type="button" class="bq-run__btn is-notin" data-run="notin">${icon('notin')}<span>Still ${b.likes_before.n} · not logged in<small>Its poster gets a reminder to send</small></span></button>
      </div>
      <button type="button" class="btn btn--quiet bq-run__skip" data-run="back">Back</button>`;
    return;
  }
  const st = statusOf(b);
  const seen = st === 'claimable' ? `gift seen ${b.open ? since(b.open.at) : ''}`
    : st === 'notin' ? `no icon ${since(b.not_yet.at)}, by ${esc(b.not_yet.by)}` : 'not checked yet';
  $('#bq-run-body').innerHTML = `<section class="bq-run__card" data-key="${keyOf(b)}">
      <span id="bq-run-copied" class="bq-run__copied" role="status">Copying…</span>
      <button type="button" class="tr-copy bq-run__uid" data-copy="${b.uid}" title="Copy UID">${b.uid}</button>
      <span class="bq-run__about">${tagOf(b.grp)} ${b.claims ? `at least ${b.claims} of 50 gone` : 'no claims yet'} · ${seen}</span>
    </section>
    <p class="bq-run__ask">What did the game show?</p>
    <div class="bq-run__answers">
      <button type="button" class="bq-run__btn is-gift" data-run="gift">${icon('gift')}<span>Gift · I claimed it<small>Counts your claim, goes to the next</small></span></button>
      <button type="button" class="bq-run__btn is-full" data-run="full">${icon('full')}<span>Portrait · it's full<small>Takes it off everyone's list</small></span></button>
      <button type="button" class="bq-run__btn is-notin" data-run="notin">${icon('notin')}<span>Nothing · not logged in<small>Its poster gets a reminder to send</small></span></button>
    </div>
    <button type="button" class="btn btn--quiet bq-run__skip" data-run="skip">Skip for now</button>`;
}

// The next one still due, shown and copied for the game's search.
async function nextInRun() {
  do run.i++; while (run.i < run.queue.length && !stillDue(run.queue[run.i]));
  renderRun();
  const k = run.queue[run.i];
  if (!k) return;
  const ok = await copyText(k.split(':')[1]);
  if (ok) { noteCopy(k); setLastCopied(k); }
  const say = $('#bq-run-copied');
  if (say && run.queue[run.i] === k) say.textContent = ok ? 'Copied, paste it in the game' : 'Tap the UID to copy it';
}

/* On a phone the run is the whole screen. On anything wider it is a small
   panel that does not block the page, docked on the right, so the game's
   window (an emulator, often) stays in view beside it; dragged by its title
   bar, it stays where it was put, per browser. */
const RUNPOS = 'coc.banquet.runpos';
const wide = () => matchMedia('(min-width: 561px)').matches;
function placeRun(x, y) {
  const d = $('#bq-run');
  const left = Math.max(0, Math.min(x, innerWidth - d.offsetWidth));
  const top = Math.max(0, Math.min(y, innerHeight - 48));
  Object.assign(d.style, { left: `${left}px`, top: `${top}px`, right: 'auto' });
  return { left, top };
}
function startRun() {
  run = { queue: runQueue(), i: -1, tally: { gift: 0, full: 0, notin: 0, skip: 0 } };
  const d = $('#bq-run');
  if (!d.open) {
    d.classList.toggle('bq-run--float', wide());
    if (wide()) {
      d.show();
      let at = null;
      try { at = JSON.parse(localStorage.getItem(RUNPOS) ?? 'null'); } catch { /* docked, then */ }
      if (at) placeRun(at.left, at.top); else d.removeAttribute('style');
    } else d.showModal();
  }
  nextInRun();
}
$('#bq-run').addEventListener('pointerdown', (e) => {
  const d = $('#bq-run');
  if (!d.classList.contains('bq-run--float') || !e.target.closest('.bq-run__top') || e.target.closest('button')) return;
  const box = d.getBoundingClientRect();
  const dx = e.clientX - box.left;
  const dy = e.clientY - box.top;
  const move = (m) => placeRun(m.clientX - dx, m.clientY - dy);
  const drop = (m) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', drop);
    try { localStorage.setItem(RUNPOS, JSON.stringify(placeRun(m.clientX - dx, m.clientY - dy))); } catch { /* this visit only */ }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', drop);
  e.preventDefault();
});
// A panel that does not block the page has no Escape of its own.
addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#bq-run').open && $('#bq-run').classList.contains('bq-run--float')) $('#bq-run').close(); });

$('#bq-run-start').addEventListener('click', startRun);
$('#bq-run-close').addEventListener('click', () => $('#bq-run').close());
$('#bq-run').addEventListener('close', () => { run = null; });
$('#bq-run-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-run]');
  if (!btn || !run) return;
  let what = btn.dataset.run;
  if (what === 'again') return startRun();
  const k = run.queue[run.i];
  const b = cardOf(k);
  // A portrait on a building that had a banquet before: ask, it may only be the old one.
  if (what === 'full' && b && hadOne(b)) { run.ask = true; return renderRun(); }
  if (what === 'back') { run.ask = false; return renderRun(); }
  run.ask = false;
  if (what === 'full!') what = 'full';
  run.tally[what]++;
  markSeen(k);
  // On to the next first: the copy has to happen while the tap still counts as one.
  nextInRun();
  if (what === 'skip' || !b) return;
  const g = b.grp ?? null;
  const target = Number(b.uid);
  const got = what === 'gift' ? await call('banquet_claim', { target, claimed: true, g })
    : await call('banquet_mark', { target, state: what === 'full' ? 'full' : 'not-yet', g });
  if (!got.ok) toast(`${b.uid}: ${got.why}`, 'info');
  fresh();
});

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
  if (state.groups && !g) { err.textContent = combined ? 'Pick a server.' : 'Pick a group.'; err.hidden = false; return; }
  // Back in the box after every add, so the next one can be typed straight away.
  const again = () => $('#bq-add-uid').focus();
  // Adding one you have already did nothing and said nothing, which reads as broken.
  if (state.mine.some((m) => m.uid === uid && (m.grp ?? null) === g)) {
    err.textContent = `${uid} is already in your list.`; err.hidden = false; $('#bq-add-uid').value = ''; again(); return;
  }
  $('#bq-add').disabled = true;
  const got = await call('banquet_add', { target: Number(uid), g });
  $('#bq-add').disabled = false;
  again();
  if (!got.ok) { err.textContent = got.why; err.hidden = false; return; }
  $('#bq-add-uid').value = '';
  markSeen(`${g ?? ''}:${uid}`); // yours: not news to you
  fresh();
});

/* Edit, for UIDs added here: the row becomes a box with the UID in it. Save
   swaps it in one step; Cancel, or Escape, puts the row back. */
let editing = false;
function stopEditing() { editing = false; render(); }
async function saveEdit(li) {
  const input = li.querySelector('input');
  const err = li.querySelector('.tr-form__error');
  const next = input.value.trim();
  if (!/^[0-9]{8}$/.test(next)) { err.textContent = 'A UID is 8 digits.'; err.hidden = false; return; }
  li.querySelector('[data-save]').disabled = true;
  const got = await call('banquet_edit',
    { target: Number(li.dataset.uid), replacement: Number(next), g: li.dataset.grp ? Number(li.dataset.grp) : null });
  li.querySelector('[data-save]').disabled = false;
  if (!got.ok) { err.textContent = got.why; err.hidden = false; return; }
  const g = li.dataset.grp ?? '';
  markSeen(`${g}:${next}`); // yours: not news to you
  editing = false;
  toast(`Changed ${li.dataset.uid} to ${next}`);
  fresh();
}
$('#bq-my').addEventListener('keydown', (e) => {
  const li = e.target.closest('li.is-editing');
  if (!li) return;
  if (e.key === 'Enter') { e.preventDefault(); saveEdit(li); }
  if (e.key === 'Escape') stopEditing();
});

$('#bq-my').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const li = edit.closest('li');
    editing = true;
    li.classList.add('is-editing');
    li.dataset.uid = edit.dataset.edit;
    if (edit.dataset.grp) li.dataset.grp = edit.dataset.grp;
    li.innerHTML = `${edit.dataset.grp ? tagOf(Number(edit.dataset.grp)) : ''}
      <input class="field" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="off" value="${edit.dataset.edit}" aria-label="New UID for ${edit.dataset.edit}">
      <button type="button" class="btn btn--primary" data-save>Save</button>
      <button type="button" class="btn btn--quiet" data-cancel>Cancel</button>
      <p class="tr-form__error" role="alert" hidden></p>`;
    li.querySelector('input').select();
    return;
  }
  if (e.target.closest('[data-save]')) return saveEdit(e.target.closest('li'));
  if (e.target.closest('[data-cancel]')) return stopEditing();
  const remove = e.target.closest('[data-remove]');
  if (!remove) return;
  remove.disabled = true;
  const got = await call('banquet_remove', { target: Number(remove.dataset.remove), g: grpOf(remove) });
  if (!got.ok) { remove.disabled = false; remove.textContent = got.why; return; }
  fresh();
});

$('#bq-remind').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remind]');
  if (!b) return;
  toast(await copyText(reminder(b.dataset.remind)) ? 'Reminder copied. Send it to whoever plays that MVP.' : 'Could not copy the reminder.');
});

$('#bq-shot').addEventListener('click', () => {
  setShot(true);
  toast('Screenshot mode. Tap "MVP banquets" to bring the controls back.');
});
// The way back leaves nothing on screen to give it away: the title, the page's tab, or Escape.
$('.topbar h1').addEventListener('click', () => { if (shot && state?.groups) setShot(false); });
// The page's own tab reads the same, "MVP banquets", and would only reload.
$('#site-tabs').addEventListener('click', (e) => {
  if (!shot || !state?.groups || !e.target.closest('[aria-current="page"]')) return;
  e.preventDefault();
  setShot(false);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape' && shot && state?.groups) setShot(false); });

// A new UID: copy it for the game's search, show its card, and it is not new any more.
$('#bq-new-uids').addEventListener('click', (e) => {
  const b = e.target.closest('[data-new]');
  if (!b) return;
  copyText(b.dataset.copy);
  noteCopy(b.dataset.new);
  setLastCopied(b.dataset.new);
  markSeen(b.dataset.new);
  render();
  const card = $(`#bq-cards li[data-key="${CSS.escape(b.dataset.new)}"]`);
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card?.classList.add('is-found');
  setTimeout(() => card?.classList.remove('is-found'), 1600);
  toast(`Copied ${b.dataset.copy}`);
});
$('#bq-last').addEventListener('click', () => {
  let card = $(`#bq-cards li[data-key="${CSS.escape(lastCopied)}"]`);
  if (!card) { // filtered or searched out of view: show everything, then find it
    show = null; find = ''; $('#bq-find').value = '';
    renderCards(state.round !== state.current);
    card = $(`#bq-cards li[data-key="${CSS.escape(lastCopied)}"]`);
  }
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card?.classList.add('is-found');
  setTimeout(() => card?.classList.remove('is-found'), 1600);
});
$('#bq-new-clear').addEventListener('click', () => {
  markSeen(...state.banquets.filter((b) => !b.grp || inView(b.grp)).map(keyOf));
  render();
});

$('#bq-groups').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  group = Number(b.dataset.group);
  try { localStorage.setItem(VIEW, String(group)); } catch { /* this visit only */ }
  for (const x of $$('[data-group]')) x.setAttribute('aria-pressed', String(x === b));
  render();
});

/* I claimed and the marks, on a card or on an activity line: one handler, so
   the two can never drift apart. */
async function press(e) {
  const claim = e.target.closest('[data-claim]');
  const mark = e.target.closest('[data-mark]');
  const btn = claim ?? mark;
  if (!btn) return;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  const li = btn.closest('li');
  if (mark && on && mark.dataset.mark === 'full' && !('sure' in mark.dataset)) {
    const b = cardOf(li.dataset.key);
    if (b && hadOne(b)) {
      // Its likes say it was MVP before: the card asks first. From the log, that card is brought into view.
      askFull = li.dataset.key;
      renderCards(state.round !== state.current);
      if (btn.closest('#bq-log')) $(`#bq-cards li[data-key="${CSS.escape(li.dataset.key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
  }
  askFull = null;
  btn.disabled = true;
  const target = Number((claim ?? mark).dataset[claim ? 'claim' : 'uid']);
  const g = grpOf(btn);
  markSeen(li.dataset.key); // claimed or marked: seen, whatever Undo does next
  const got = claim
    ? await call('banquet_claim', { target, claimed: on, g })
    : await call('banquet_mark', { target, state: on ? mark.dataset.mark : null, g });
  if (!got.ok) { btn.disabled = false; btn.textContent = got.why; btn.removeAttribute('aria-label'); return; }
  /* Claiming moves the card to the end of Claimable at once, so a thumb on the
     wrong card gets a way back that does not mean finding it again. */
  if (claim && on) {
    toast(`Claimed ${target}`, 'info', {
      label: 'Undo',
      fn: async () => {
        await call('banquet_claim', { target, claimed: false, g });
        fresh();
      },
    });
  }
  fresh();
}
$('#bq-cards').addEventListener('click', press);

// Likes: a box on the card, saved as what the game shows right now.
async function saveLikes(btn) {
  const box = btn.closest('li').querySelector('[data-likes-input]');
  const typed = box.value.trim();
  if (!/^[0-9]{1,6}$/.test(typed)) { box.focus(); toast('Likes is a number, like 100.', 'info'); return; }
  const n = Number(typed);
  btn.disabled = true;
  const target = Number(btn.dataset.likesSave);
  const g = grpOf(btn);
  const got = await call('banquet_likes_set', { target, n, g });
  btn.disabled = false;
  if (!got.ok) { toast(got.why, 'info'); return; }
  const b = cardOf(btn.closest('li').dataset.key);
  likesFor = null;
  // A count that answers the portrait question offers the mark that goes with it.
  const mark = (to) => () => call('banquet_mark', { target, state: to, g }).then(() => fresh());
  const now = b && state.round === state.current && hadOne(b) && !b.full;
  if (now && n >= fullAt(b)) toast(`${target}: ${n} likes, so it is full`, 'info', { label: 'Mark full', fn: mark('full') });
  else if (now && n === b.likes_before.n && !b.not_yet) toast(`${target}: still ${n}, not logged in yet`, 'info', { label: 'Mark not logged in', fn: mark('not-yet') });
  else toast(`Noted ${n} likes on ${target}`);
  fresh();
}
$('#bq-cards').addEventListener('click', (e) => {
  const open = e.target.closest('[data-likes]');
  if (open) {
    likesFor = open.dataset.likes;
    const b = cardOf(likesFor);
    likesDraft = String(b?.likes_now?.n ?? b?.likes_before?.n ?? '');
    askFull = null;
    renderCards(state.round !== state.current);
    $('#bq-cards [data-likes-input]')?.select();
    return;
  }
  if (e.target.closest('[data-likes-cancel]')) { likesFor = null; return renderCards(state.round !== state.current); }
  if (e.target.closest('[data-ask-cancel]')) { askFull = null; return renderCards(state.round !== state.current); }
  const save = e.target.closest('[data-likes-save]');
  if (save) saveLikes(save);
});
$('#bq-cards').addEventListener('input', (e) => { if (e.target.matches('[data-likes-input]')) likesDraft = e.target.value; });
$('#bq-cards').addEventListener('keydown', (e) => {
  if (!e.target.matches('[data-likes-input]')) return;
  if (e.key === 'Enter') { e.preventDefault(); saveLikes(e.target.closest('li').querySelector('[data-likes-save]')); }
  if (e.key === 'Escape') { likesFor = null; renderCards(state.round !== state.current); }
});
$('#bq-log').addEventListener('click', press);

$('#bq-liked').addEventListener('click', (e) => {
  const b = e.target.closest('[data-liked]');
  if (!b) return;
  likesShow = b.dataset.liked;
  renderCards(state.round !== state.current);
});

// A tile shows only its status; pressed again, all four.
for (const b of $$('[data-show]')) {
  b.addEventListener('click', () => {
    show = show === b.dataset.show ? null : b.dataset.show;
    renderCards(state.round !== state.current);
  });
}

$('#bq-round').addEventListener('change', (e) => load(e.target.value));
$('#bq-find').addEventListener('input', (e) => {
  find = e.target.value.trim().toLowerCase();
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
  const card = btn.closest('#bq-cards li[data-key], .bq-run__card[data-key], #bq-log li[data-key]');
  if (ok && card) { noteCopy(card.dataset.key); setLastCopied(card.dataset.key); }
  btn.classList.add(ok ? 'is-copied' : 'is-failed');
  btn.dataset.label = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { btn.classList.remove('is-copied', 'is-failed'); delete btn.dataset.label; }, 1200);
});

// Back to this address, code and all; with no code it is the address it always was.
$('#bq-signin').addEventListener('click', () => signIn(`${location.origin}${location.pathname}${location.search}`));
$('#bq-signout').addEventListener('click', () => { signOut(); setMember(false); location.reload(); });

start();
