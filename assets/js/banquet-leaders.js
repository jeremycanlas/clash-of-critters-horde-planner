/**
 * Banquet leaderboards: four boards per group, for one gold rush or all of
 * them, from banquet_leaders() (supabase/migrations/042). The database builds
 * each group's boards at most every 5 minutes and hands everyone that build,
 * so this page asks once on opening and never again on its own.
 *
 * The servers and the link codes are the banquet page's (assets/js/banquet.js).
 */
import { rest, signedIn, isConfigured } from './supabase.js';
import { applyPrefs } from './prefs.js';
import { $, esc } from './ui.js';

applyPrefs();

const SERVERS = {
  '': { name: 'MVP UIDs', profile: null },
  tide: { name: 'Send UIDs', profile: 'tide' },
};
const code = new URLSearchParams(location.search).get('s') ?? '';
const dbs = code === 'duo' ? Object.values(SERVERS) : [SERVERS[code]].filter(Boolean);
const ask = (d, fn, body) => rest(`/rpc/${fn}`, { method: 'POST', body, auth: true, profile: d.profile });
const back = `banquet.html${location.search}`;

const BOARDS = [
  ['scout', 'Scout', 'First to check a UID: open, full or not logged in'],
  ['responder', 'First responder', 'First to find one open, in the hour after the reset'],
  ['sharer', 'Sharer', 'UIDs they shared first that someone else claimed from'],
  ['likes', 'Likes noter', 'Buildings whose likes they noted first, before the reset'],
];
const ALL = 'all';

function gate(head, text) {
  $('#lb-status').textContent = '';
  $('#lb-gate').hidden = false;
  $('#lb-app').hidden = true;
  $('#lb-gate-head').textContent = head;
  $('#lb-gate-text').textContent = text;
}

/* A yes from Discord lasts 30 minutes in the database. Within it the boards
   come straight back; past it, the role is asked again once and then them. */
async function leaders(d, body) {
  let got = await ask(d, 'banquet_leaders', body);
  if (!got.ok && /checking again/i.test(got.why)) {
    const said = await ask(d, 'banquet_check', {});
    if (!said.ok || said.data !== 'ok') return { ok: false, why: said.ok ? said.data : said.why };
    got = await ask(d, 'banquet_leaders', body);
  }
  return got;
}

let rounds = [];
async function load(pick) {
  $('#lb-status').textContent = 'Loading…';
  const body = pick === ALL ? { all_time: true } : { r: pick ?? null };
  const got = await Promise.all(dbs.map((d) => leaders(d, body)));
  const ok = got.map((x, i) => [x, dbs[i]]).filter(([x]) => x.ok);
  if (!ok.length) {
    const why = got[0].why;
    return gate(why === 'no-role' ? 'This page is for one Discord server' : 'Could not load the leaderboards',
      why === 'no-role' ? 'Your Discord account does not have the role for it.' : why);
  }
  const first = ok[0][0].data;
  if (!rounds.length) {
    rounds = [...new Set(ok.flatMap(([x]) => x.data.rounds))].sort().reverse();
    // Named by the reset, as on the banquet page.
    const day = (r) => new Date(`${r}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    $('#lb-round').innerHTML = rounds.map((r) => `<option value="${r}">${r === first.current ? 'This gold rush' : 'Gold rush'}, reset ${day(r)}</option>`).join('')
      + `<option value="${ALL}">All time</option>`;
  }
  $('#lb-round').value = pick ?? first.current;
  const groups = ok.flatMap(([x, d]) => x.data.groups.map((g) => ({ ...g, server: dbs.length > 1 ? d.name : '' })));
  $('#lb-groups').innerHTML = groups.map((g) => group(g, groups.length > 1)).join('');
  $('#lb-status').textContent = '';
  $('#lb-gate').hidden = true;
  $('#lb-app').hidden = false;
}

const minutes = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

function group(g, named) {
  return `<section class="lb-group">
    ${named ? `<h2>${esc(g.server ? `${g.server} · ${g.name}` : g.name)}</h2>` : ''}
    <div class="lb-boards">${BOARDS.map(([key, title, what]) => board(g.boards[key], title, what, named ? 'h3' : 'h2')).join('')}</div>
    <p class="muted lb-built">Counted ${minutes(g.built_at) < 1 ? 'just now' : `${minutes(g.built_at)} min ago`}</p>
  </section>`;
}

// Under a group's heading when there are several, at the top level when there is one.
function board(b, title, what, h) {
  const you = b.you
    ? `You: <b>#${b.you.rank}</b> of ${b.people} · ${b.you.n}`
    : 'Not on this board yet';
  return `<article class="panel lb-board">
      <${h} class="lb-title">${title}</${h}>
      <p class="muted lb-what">${what}</p>
      ${b.top.length ? `<ol class="lb-top">${b.top.map((r) => `<li class="${r.you ? 'is-you' : ''}">
          <span class="lb-rank">${r.rank}</span><span class="lb-name">${esc(r.name)}</span><span class="lb-n">${r.n}</span></li>`).join('')}</ol>`
    : '<p class="muted lb-empty">Nobody yet.</p>'}
      <p class="lb-you">${you}</p>
    </article>`;
}

async function start() {
  $('#lb-back').href = back;
  $('#lb-signin').href = back;
  if (!dbs.length) return gate('This link is not right', 'Check the link you were given.');
  if (!isConfigured()) return gate('Not connected', 'This copy of the site has no database.');
  // Signing in goes through the banquet page: Discord sends you back to it, whatever the server.
  if (!signedIn()) return gate('This page is private', 'Sign in with Discord on the banquet page, then come back here.');
  await load();
}

$('#lb-round').addEventListener('change', (e) => load(e.target.value));
start();
