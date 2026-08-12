/**
 * The community gallery.
 *
 * Formations other people posted, each drawn as the board it actually is.
 * Opening one is a plain navigation to `index.html#v6=…` (the same link a
 * player could paste by hand), so the drafter itself carries no network code
 * for reading any of this and never learns that a database exists.
 *
 * ## Why the preview is the important surface
 *
 * This tool's measured problem is that 286 arrivals produced zero copied links.
 * Formations travel as screenshots, and a gallery with no address for a single
 * formation gives a reader nothing to send but the whole gallery. So the
 * preview has a URL of its own, and its three actions are the three things
 * people actually do: copy a link to this one, save the picture, open it.
 *
 * The picture it saves is drawn by `card.js` — the same function that draws the
 * shareable PNG, through `viewOf()`. There is deliberately no second renderer,
 * so a change to how a shared card looks is the same change here.
 */

import { load, state } from './data.js';
import { $, esc, toast, copyText, downloadBlob, slugFilename, dismissOnBackdrop } from './ui.js';
// mapHTML and statsOf are gone from here: the row is a drawn card now, not a
// stamp and a line of facts. saves.js and submit.js still use both.
import { fmtWhen, missingNote } from './formation-card.js';
import { viewOf } from './formation-view.js';
import { drawCard, canvasBlob, warmSprites } from './card.js';
import { toFragment } from './hash.js';
import {
  isConfigured, rest, forgetCache, readCallback, signedIn, signIn, signOut, token, whoAmI,
} from './supabase.js';
// The list of what this browser posted, from the module that writes it. Nothing
// else in submit.js runs on import — the dialog it owns is on the other page.
import { posted } from './submit.js';
import { buildAnalytics, track } from './analytics.js';

/**
 * Ten, not twenty.
 *
 * Each row carries the whole card rather than a thumbnail, and on a phone that
 * card is the one-column shape: about 750 CSS px of row on a 411px screen. Ten
 * of those is roughly eight screen-heights, twenty would be sixteen. The trade
 * is deliberate — a row you have to scroll past is cheaper than a row you
 * cannot read — and "Show more" carries the rest.
 */
const PAGE = 10;

const COLUMNS = 'id,name,note,mode,slugs,placed,steps,author_name,author_avatar,'
  + 'submitted_at,patch_id,score,snapshot';

/** @type {object[]} everything fetched so far, in display order */
let rows = [];
let total = null;
let loading = false;

/**
 * How the list is ordered and what it is narrowed to.
 *
 * Most-upvoted by default, not newest. Newest is the honest default for a
 * gallery nobody has voted in yet, and the wrong one the moment they have: it
 * ranks by when somebody pressed Post, which is the one fact about a formation
 * that says nothing about whether it is worth building. Newest is still one
 * press away, and score ties break on recency, so a gallery with no votes in it
 * still reads newest-first.
 */
const view = {
  sort: 'top', mode: '', patch: '', tier: '',
  /** '' for everyone's, '1' for only what this browser posted. See mineWhere(). */
  mine: '',
};

/** Formations this account has already kept. Empty when signed out. */
let mine = new Set();

/** Patch windows, newest first. Empty is a coherent state - see renderPatches(). */
let patches = [];

/** Survives the trip to Discord, so voting does not cost you the gallery. */
const RESUME_KEY = 'coc.community-resume.v1';

/** Guards the preview against its own history — see openPeek(). */
let peekToken = 0;

// ---------------------------------------------------------------- fetching

/**
 * "The highest tier this formation fields is exactly T<n>", as a query.
 *
 * The database holds no tier: `formations.slugs` is a text[] of what is on the
 * field, and which tier a slug belongs to lives in data/tatari.json, on this
 * side. So rather than denormalising a `max_tier` column — a migration, plus a
 * backfill the server has no way to compute, plus every formation posted before
 * it went in reading as null — the question is asked in terms the database
 * already has: overlaps the slugs at this tier, and overlaps none above it.
 *
 * That keeps the filter server-side, which is the part that matters. Filtering
 * a paged list in the browser only ever filters the page you have loaded, and
 * silently gets worse the more there is to look at.
 *
 * It costs a long query string — about 2KB at T1, the worst case, well inside
 * what PostgREST accepts. And it re-derives from the roster on every call, so a
 * Tatari that changes tier in a later patch is right immediately, with nothing
 * stored anywhere to migrate.
 *
 * A formation holding a slug this roster does not know matches no tier at all,
 * and drops out of every tier filter rather than being guessed into one.
 */
function tierWhere(tier) {
  const n = Number(tier);
  if (!Number.isInteger(n) || n < 1 || n > 4) return '';

  const at = [];
  const above = [];
  for (const t of state.bySlug.values()) {
    if (t.tier === n) at.push(t.slug);
    else if (t.tier > n) above.push(t.slug);
  }
  if (!at.length) return '';

  const set = (list) => `{${list.join(',')}}`;
  const has = `&slugs=ov.${encodeURIComponent(set(at))}`;
  // T4 has nothing above it, so the second half is only asked when it means
  // something — an empty `not.ov.{}` is a predicate no row can satisfy.
  return above.length
    ? `${has}&slugs=not.ov.${encodeURIComponent(set(above))}`
    : has;
}

/**
 * "Only the ones this browser posted", as a query.
 *
 * The gallery has no way to ask the database "which of these are mine". The view
 * publishes no `author_id` — 006 withheld it on purpose — and PostgREST cannot
 * filter on a column the caller has no select grant for, so the question cannot
 * be asked even indirectly.
 *
 * What this browser does have is the list submit.js writes every time a post
 * succeeds: the ids it created. That is a narrower claim than "yours" — it is
 * "yours, from here" — and it is the honest one. Posting from a phone and
 * looking on a laptop shows nothing, which is why the control stays hidden until
 * this list has something in it, and why nothing else on the page was moved onto
 * it: whether a row is yours to delete still comes from the signed-in account.
 *
 * The alternative was matching `author_avatar` against the session's, the way
 * ownedByMe() does. It would survive a change of device and it would be wrong:
 * an account with no picture of its own gets one of Discord's numbered defaults,
 * and that URL is the same string for everybody who has it. A filter called
 * Yours that answers with a stranger's formations is worse than one that only
 * knows about this browser.
 *
 * Capped at 60 ids. That is a query string of about 2.2KB, comfortably inside
 * what PostgREST accepts, and further back than anybody scrolls looking for
 * something they posted.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mineWhere() {
  const ids = posted()
    .map((p) => String(p?.id ?? ''))
    .filter((id) => UUID.test(id))
    .slice(0, 60);
  // No ids at all cannot happen while the control is hidden, but a filter that
  // silently means "everyone" would be the wrong way to be wrong about it.
  if (!ids.length) return '&id=is.null';
  return `&id=in.(${ids.join(',')})`;
}

async function loadMore({ append = true } = {}) {
  if (loading) return;
  loading = true;
  paintMore();
  if (!append) skeleton();

  const order = view.sort === 'top'
    // submitted_at breaks ties, so equal scores keep a stable, meaningful order
    // rather than whatever the planner happens to return.
    ? 'score.desc,submitted_at.desc'
    : 'submitted_at.desc';
  const where = [
    view.mode ? `&mode=eq.${view.mode}` : '',
    view.patch ? `&patch_id=eq.${encodeURIComponent(view.patch)}` : '',
    tierWhere(view.tier),
    view.mine ? mineWhere() : '',
  ].join('');

  const res = await rest(
    `/formation_cards?select=${COLUMNS}&order=${order}${where}`
    + `&limit=${PAGE}&offset=${append ? rows.length : 0}`,
    { cache: true, headers: { Prefer: 'count=exact' } },
  );
  loading = false;

  if (!res.ok) {
    // Quiet: nobody pressed anything to make this happen, and the drafter
    // behind this page is unaffected. But it must not be silent either — a
    // page that says nothing is indistinguishable from an empty gallery.
    say(res.why || 'Could not reach the community list.', true);
    if (!append) $('#list').innerHTML = '';
    paintMore();
    return;
  }

  const fresh = Array.isArray(res.data) ? res.data : [];
  /*
   * De-duplicated by id rather than trusted. `offset` over `submitted_at desc`
   * re-serves a row whenever someone posts mid-paging, and a duplicated id
   * makes two cards that both answer to one preview.
   */
  const seen = new Set(append ? rows.map((r) => String(r.id)) : []);
  const merged = append ? [...rows] : [];
  for (const row of fresh) {
    if (seen.has(String(row.id))) continue;
    seen.add(String(row.id));
    merged.push(row);
  }
  rows = merged;
  total = res.total ?? total;

  say('');
  render({ fresh: !append });
  warmSprites(rows.flatMap((r) => (r.snapshot?.cells ?? []).filter(Boolean).map((c) => c.slug)));
}

// ---------------------------------------------------------------- rendering

/**
 * Something in the shape of the answer, while the answer is on its way.
 *
 * An empty panel and a loading panel were pixel-identical, which on a cold
 * free-tier database reads as "nobody has posted" — the exact wrong conclusion,
 * and one this page then had to talk somebody out of.
 */
function skeleton() {
  $('#list').innerHTML = Array.from({ length: 2 }, () => `
    <li class="community__item community__item--wait" aria-hidden="true">
      <span class="community__skel-map"></span>
      <span class="community__skel-line"></span>
    </li>`).join('');
}

/**
 * Who posted it.
 *
 * The monogram is always rendered, and the picture sits on top of it, starting
 * transparent and revealed only once it has actually decoded. That ordering is
 * the whole trick, and it was arrived at the hard way: the first version fell
 * back on the image's `error` event, and a blocked request does not fire one.
 * Measured on this machine — the URL answers 200 with 39KB in 0.3s from a
 * shell, and in the browser it hangs forever with no load and no error, because
 * `cdn.discordapp.com` is a standing target for content blockers. That left a
 * permanent empty hole where a face should be, for every reader running one.
 *
 * Underneath-first covers blocked, slow, offline, 404 and rotated-hash alike:
 * there is never a moment with nothing in the space.
 *
 * The picture is also the one thing on this site loaded from another host, and
 * its URL carries the poster's Discord ID — an identifier the schema otherwise
 * withholds. `referrerpolicy="no-referrer"` stops Discord learning which page
 * asked, and the footer says the request happens. Re-hosting at post time
 * through the one host this page already talks to would remove both, and is
 * the right next move if either matters.
 */
/**
 * The name to credit a formation to.
 *
 * `||` rather than `??`, because the empty case is an empty string and not a
 * null. `author_name` is `not null default ''`, and a poster whose Discord
 * account has never been given a display name arrives with `global_name` set to
 * `""` — which the trigger's coalesce chain accepts, coalesce guarding against
 * null and not against blank. 009 fixes that where it starts; this keeps the
 * byline honest for everything posted before it runs, which would otherwise be
 * drawn with no byline at all rather than with the "Someone" the rest of the
 * page already says.
 */
const authorOf = (row) => row.author_name?.trim() || 'Someone';

function facePart(row) {
  const name = authorOf(row);
  // Upper-case first, then escape. The other order turns `&lt;` into `&LT;`,
  // which is still a legal HTML5 entity and renders as a bare `<` — harmless
  // on its own, but escaping that a later edit can undo is not escaping.
  const initial = esc(([...name][0] ?? '?').toUpperCase());
  if (!row.author_avatar) {
    return `<span class="community__face-slot"><span class="community__mono" aria-hidden="true">${initial}</span></span>`;
  }
  return `<span class="community__face-slot">
      <span class="community__mono" aria-hidden="true">${initial}</span>
      <img class="community__face" src="${esc(row.author_avatar)}" alt=""
        width="22" height="22" loading="lazy" decoding="async" referrerpolicy="no-referrer"
        onload="this.classList.add('is-there')"></span>`;
}

/**
 * Upvoting a formation.
 *
 * This was "Keep" for a while, on the reasoning that it said what the number
 * meant and what it did not. It cost more than it bought: nobody arrives at a
 * gallery already knowing that this site's word for a vote is "keep", and a
 * thumb is understood before it is read. The hint above the list still carries
 * the caveat the word was doing on its own.
 *
 * Signed out, the control does not pretend. Pressing it takes you to sign in,
 * rather than counting a vote it cannot cast and taking it back a second later.
 *
 * The `is-kept` class and the `community-kept` analytics label keep the old
 * word deliberately: one is private to the stylesheet, and the other is a fixed
 * string with a year of counts already filed under it.
 */
/**
 * Whether this formation is one of yours, and therefore not yours to upvote.
 *
 * The database is the authority — `votes_no_self` in 002 refuses the insert —
 * but finding out from the server means the count ticks up, the button fills in,
 * and both undo themselves a moment later. That flicker is what "the button does
 * not work" looks like from the outside, and no toast undoes the impression.
 *
 * `author_id` is deliberately not exposed by the view, so this compares the
 * avatar URL instead: it carries the poster's own Discord ID and hash, and the
 * session holds the identical string for the signed-in account. Matching means
 * yours. Not matching does not prove otherwise — an account with no avatar has
 * nothing to compare — so this only ever suppresses a press that was going to
 * fail, and `noteRefusal()` below catches the rest from the server's answer.
 */
/**
 * A picture Discord hands out rather than one somebody chose.
 *
 * An account with no avatar of its own is served one of a handful of numbered
 * defaults from `/embed/avatars/`, and that URL is character-for-character the
 * same for everyone who has it. Comparing it proves nothing, so the check below
 * refuses to draw a conclusion from one — otherwise two players who have both
 * left their picture unset would each see the other's formations labelled Yours,
 * with a Delete button the server would then refuse.
 */
const isSharedAvatar = (url) => /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\//.test(url || '');

function ownedByMe(row) {
  if (row.mine === true) return true;
  const me = whoAmI();
  const a = row.author_avatar || '';
  if (isSharedAvatar(a)) return false;
  return !!me && !!a && a === me.avatar;
}

/** Remembers a refusal, so a formation is only ever refused once. */
function noteRefusal(row, why) {
  if (/your own/i.test(why || '')) row.mine = true;
}

function voteHTML(row) {
  const voted = mine.has(String(row.id));
  const n = Number(row.score) || 0;
  const count = n ? ` ${n}` : '';

  // Yours: it still says how many upvotes it has, because that is the number
  // you posted it to find out. It just does not offer you a button to press.
  if (ownedByMe(row)) {
    return `<span class="btn btn--tiny community__act community__vote is-mine"
        title="This is your formation. Upvotes come from other players.">
        <span class="community__vote-mark" aria-hidden="true">👍</span>${
          esc(`Yours${count}`)}</span>`;
  }

  return `<button class="btn btn--tiny community__act community__vote${voted ? ' is-kept' : ''}"
      type="button" data-vote="${esc(row.id)}"
      aria-pressed="${voted}"
      title="${signedIn()
        ? 'Upvote this formation'
        : 'Sign in with Discord to upvote a formation'}">
      <span class="community__vote-mark" aria-hidden="true">👍</span>${
        esc(`${voted ? 'Upvoted' : 'Upvote'}${count}`)}</button>`;
}

/**
 * Who you are signed in as, and the way to stop being.
 *
 * Absent entirely when signed out — most people here never post, and an account
 * strip on a page they have no account for is chrome for its own sake.
 *
 * The name is the same one that would appear on anything you posted, which is
 * the point: it is a check as much as a label, and it costs nothing to show
 * somebody the name they are about to publish under.
 */
function paintWhoAmI() {
  const el = $('#whoami');
  if (!el) return;
  const me = whoAmI();
  if (!me) { el.hidden = true; el.textContent = ''; return; }

  el.hidden = false;
  el.innerHTML = `Signed in as <b>${esc(me.name)}</b>
    <button class="btn btn--tiny btn--quiet community__signout" type="button" data-signout
      title="Ends this sign-in, here and on the server. Your saved formations stay in this browser and anything you posted stays posted — you just cannot post, upvote or delete again until you sign back in.">Sign out</button>`;
}

async function onSignOut() {
  /*
   * A token first, then sign out with it.
   *
   * signOut() ends the session on the server with whatever access token is
   * live, and that is only populated once something has been sent as you. A
   * reader who signs in, browses and leaves has never made an authenticated
   * request — so without this the server session, and the IP on it, would
   * survive the one action whose whole purpose is ending them.
   *
   * A failure here is not worth reporting: token() signs you out locally when a
   * refresh is refused, which is the outcome being asked for anyway.
   */
  await token().catch(() => null);
  signOut();

  mine = new Set();
  paintWhoAmI();
  render({ fresh: true });      // the Yours/Upvote and Delete controls change
  toast('Signed out', 'ok');
  track('community-signed-out');
}

/** Which formations this account has already kept. Signed out, nothing. */
async function loadMyVotes() {
  if (!signedIn()) { mine = new Set(); return; }
  const res = await rest('/votes?select=formation_id', { auth: true });
  if (!res.ok) return;                     // a missing list is not worth a message
  mine = new Set((res.data ?? []).map((v) => String(v.formation_id)));
}

/**
 * Keeps a formation, or takes it back.
 *
 * Not optimistic while signed out, because the honest answer is "sign in first"
 * rather than a number that goes up and then back down. Once signed in it is
 * optimistic, because a phone should answer in the same frame — and the
 * rollback is exact, because the only thing that moved was one integer.
 */
async function onVote(id) {
  const row = rows.find((r) => String(r.id) === String(id));
  if (!row) return;

  if (!signedIn()) {
    // Stash where we are, so coming back from Discord does not cost the reader
    // their scroll position and every page they had loaded.
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({
        scroll: Math.round(scrollY), pages: Math.ceil(rows.length / PAGE), view, vote: String(id),
      }));
    } catch { /* it will just come back to the top */ }
    signIn();
    return;
  }

  // Answered here rather than by the round trip, so nothing moves and then
  // moves back. The database still refuses it if this guess is wrong.
  if (ownedByMe(row)) {
    toast('That one is yours. Upvotes come from other players.', 'error');
    return;
  }

  const kept = mine.has(String(id));
  if (kept) { mine.delete(String(id)); row.score = Math.max(0, (row.score || 0) - 1); }
  else { mine.add(String(id)); row.score = (row.score || 0) + 1; }
  paintVote(id);

  const res = kept
    ? await rest(`/votes?formation_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', auth: true })
    : await rest('/votes', {
      method: 'POST', auth: true, body: { formation_id: id },
      /*
       * `return=minimal` only. `resolution=ignore-duplicates` used to be here
       * too, and it made every upvote fail with 42501 — "permission denied for
       * table votes" — which the toast reports as the list being set up wrong.
       *
       * That preference turns the insert into `ON CONFLICT DO NOTHING`, and
       * Postgres checks SELECT on the arbiter columns before it can decide
       * whether a row conflicts. The arbiter here is the primary key,
       * (formation_id, voter_id), and 002 grants select on (formation_id,
       * created_at) — so the one column the conflict is decided on is the one
       * column the voter cannot read, and the statement is refused before any
       * policy is consulted.
       *
       * Nothing is lost by dropping it: a second insert of the same vote comes
       * back 409 instead of 200, and the check below already treats 409 as the
       * thing having happened, because it has.
       */
      headers: { Prefer: 'return=minimal' },
    });

  if (res.ok || res.status === 409) {
    track(kept ? 'community-unkept' : 'community-kept');
    forgetCache();          // the cached page still holds the old score
    return;
  }

  // Put it back exactly as it was, and say why. A refusal that names a
  // self-vote is also remembered, so an account with no avatar to match on
  // gets the flicker once rather than every time it presses.
  if (kept) { mine.add(String(id)); row.score = (row.score || 0) + 1; }
  else { mine.delete(String(id)); row.score = Math.max(0, (row.score || 0) - 1); }
  noteRefusal(row, res.why);
  paintVote(id);
  toast(res.why, 'error');
}

/** Repaints one vote button, rather than redrawing ten formation cards. */
function paintVote(id) {
  const row = rows.find((r) => String(r.id) === String(id));
  const btn = $(`#list [data-vote="${CSS.escape(String(id))}"]`);
  if (!row || !btn) return;
  btn.outerHTML = voteHTML(row);
}

function cardHTML(row) {
  const cells = row.snapshot?.cells ?? [];
  const missing = missingNote(cells);
  const when = fmtWhen(row.submitted_at);
  const patch = patches.find((p) => String(p.id) === String(row.patch_id));

  /*
   * The card is the row.
   *
   * It is the same picture `drawCard` makes for Share, so it already carries
   * the name, the byline, the mode, the field and what the formation brings —
   * which is why the DOM around it has shrunk to the things a picture cannot
   * be: the poster's note, and the two controls.
   *
   * width/height are set from the card's own logical size so the row reserves
   * its space before the image exists. Without them ten rows reflow as they
   * decode, and the list jumps under the thumb.
   */
  return `
    <li class="community__item" data-id="${esc(row.id)}">
      <button class="community__shotwrap" type="button" data-open-row="${esc(row.id)}"
              title="Open this formation in the drafter">
        <!-- The note is in the alt rather than in a paragraph underneath.
             It is drawn on the card now, and printing it twice a centimetre
             apart reads as a mistake — but a picture is nothing to a screen
             reader, so the words have to survive somewhere. -->
        <img class="community__shot" data-shot="${esc(row.id)}"
             alt="${esc(row.note ? `${row.name} — ${row.note}` : row.name)}"
             width="1080" height="1220" decoding="async">
        <span class="community__shotwait">Drawing…</span>
      </button>

      ${missing ? `<p class="community__missing">${esc(missing)}</p>` : ''}

      <!-- The two controls sit together and the timestamp trails them: it is
           the only thing in this row you cannot press, so putting it between
           the buttons split one group into two. On a phone it still takes its
           own line above them, via order: -1 in the stylesheet. -->
      <span class="community__acts">
        ${voteHTML(row)}
        <a class="btn btn--tiny community__act community__act--go"
           href="${esc(drafterLink(row))}" data-open="${esc(row.id)}">Open in the drafter</a>
        <span class="community__when">${esc([when, patch ? `patch ${patch.label}` : ''].filter(Boolean).join(' · '))}</span>
        ${ownedByMe(row) ? `
          <!-- Last, and after the timestamp, so the destructive control is the
               furthest thing in the row from the one you press to open it. -->
          <button class="btn btn--tiny community__act community__remove"
                  type="button" data-remove-row="${esc(row.id)}"
                  title="Take this formation out of the gallery. It keeps its upvotes and can be put back for 30 days, after which it is erased for good.">Delete</button>` : ''}
      </span>
    </li>`;
}

/**
 * Draws a row's card, once, when it is close to being looked at.
 *
 * Ten live canvases would be about 43 MB of backing store at this device pixel
 * ratio, which iOS Safari answers by blanking them. So each is drawn at scale 1,
 * turned into a PNG blob the browser can manage in its own image cache, and the
 * canvas is dropped. The blob URL is released when the list is rebuilt.
 */
const drawn = new Map();

function releaseShots() {
  for (const url of drawn.values()) URL.revokeObjectURL(url);
  drawn.clear();
}

async function paintShot(img) {
  const id = img.dataset.shot;
  if (!id || drawn.has(id)) return;
  drawn.set(id, '');                        // claim it before awaiting, so two
  const row = rows.find((r) => String(r.id) === String(id));  // observers cannot race
  if (!row?.snapshot) return;

  try {
    const canvas = await drawCard({
      /*
       * `full`, which is Share's "Everything": the field, both benches and the
       * level-up plan rather than the grid on its own. A posted formation is
       * something somebody is reading to decide whether to build it, and the
       * fifteen you bring and the order you level them are half of that answer.
       * The grid-only card is the right thing to *send* someone; it is the
       * wrong thing to browse.
       */
      view: viewOf(row.snapshot), full: true, stacked: stackedHere(), scale: 1,
      username: authorOf(row),
      avatar: row.author_avatar || '',
      note: row.note || '',
    });
    const blob = await canvasBlob(canvas);
    // Said out loud rather than returned from. A null blob used to leave the
    // row reading "Drawing…" for the rest of the session with nothing in the
    // console — the one failure here that looks exactly like a hang.
    if (!blob) throw new Error('canvasBlob returned nothing');
    const url = URL.createObjectURL(blob);
    drawn.set(id, url);
    img.src = url;
    img.classList.add('is-drawn');
    // Reflect the real proportions, so the reserved box and the picture agree.
    img.width = canvas.width;
    img.height = canvas.height;
    /*
     * Hands the box back to the picture. The wrapper holds a guessed aspect
     * ratio so the row reserves height before anything is drawn, but a card is
     * between about 1000 and 1300 tall depending on the plan and the benches —
     * so keeping the guess after the fact framed a short card in a band of
     * empty surface. The guess is for the wait; the picture is the truth.
     */
    img.closest('.community__shotwrap')?.classList.add('is-drawn');
  } catch (err) {
    console.error(err);
    img.closest('.community__shotwrap')?.classList.add('is-failed');
  }
}

/**
 * Which shape of card this screen should get.
 *
 * A card is a picture scaled into whatever column holds it, so the only
 * question that matters is how many display pixels each card pixel gets. The
 * wide card is 1080 across; below about 900 of column it is being shrunk hard
 * enough that the level-up plan stops being readable, and the one-column card
 * — same content, 636 across — is the better trade even though it is taller.
 *
 * Measured off the viewport rather than the element: this is asked before the
 * first row exists, and every row on a page gets the same answer anyway.
 */
function stackedHere() {
  return window.innerWidth < 900;
}

/** Draws rows a screen ahead of the scroll, and never the ones behind it. */
const shotWatcher = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    shotWatcher.unobserve(entry.target);
    paintShot(entry.target);
  }
}, { rootMargin: '600px 0px' });

/**
 * The link that carries a formation back to the drafter.
 *
 * Built from the whole snapshot, so what lands is the field, both benches and
 * the level-up plan — everything the row's own meta line advertises. The list
 * used to carry cells alone and quietly hand over a build with no plan in it.
 */
function drafterLink(row) {
  const fragment = row.snapshot ? toFragment(row.snapshot) : '';
  return fragment ? `index.html#${fragment}` : 'index.html';
}

/**
 * @param {{fresh?: boolean}} [opts] `fresh` throws away the drawn cards too.
 *
 * "Show more" appends; it does not start again. Rebuilding the whole list and
 * releasing every blob meant page two redrew page one — ten canvas renders and
 * ten PNG encodes to see ten new formations, then twenty to see ten more. Only
 * a change of sort or filter genuinely invalidates what has been drawn.
 */
function render({ fresh = true } = {}) {
  const host = $('#list');
  if (fresh) {
    releaseShots();
    host.innerHTML = rows.map(cardHTML).join('');
  } else {
    const have = new Set([...host.children].map((li) => li.dataset.id));
    host.insertAdjacentHTML('beforeend',
      rows.filter((r) => !have.has(String(r.id))).map(cardHTML).join(''));
  }
  for (const img of host.querySelectorAll('[data-shot]:not([src])')) shotWatcher.observe(img);
  $('#list-count').textContent = total === null
    ? (rows.length ? `${rows.length}` : '')
    : `${rows.length} of ${total}`;
  paintMore();
}

function paintMore() {
  const btn = $('#list-more');
  const done = total !== null && rows.length >= total;
  btn.hidden = !rows.length || done;
  btn.disabled = loading;
  btn.textContent = loading ? 'Loading…' : 'Show more';
}

/**
 * The page's one message line. `retry` adds a button, because "it did not load"
 * without "try again" is a dead end on a page that is nothing but a list.
 */
function say(text, retry = false) {
  const el = $('#list-say');
  el.textContent = text;
  el.hidden = !text;
  if (!text || !retry) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--tiny community__retry';
  btn.textContent = 'Try again';
  btn.addEventListener('click', () => {
    if (loading) return;          // a second press used to clear the message
    forgetCache();
    say('');
    loadMore({ append: rows.length > 0 });
  });
  el.append(btn);
}

/** True when the message line is already carrying something. */
const saying = () => !$('#list-say').hidden;

// ---------------------------------------------------------------- preview

/**
 * One formation, with an address.
 *
 * `peekToken` is the race guard. The preview draws asynchronously (sprites
 * have to decode before the card exists), and without a token a slow draw for
 * the formation you opened first could land in the dialog you opened second,
 * putting one build's picture and link under another build's name.
 */
async function openPeek(id, { push = true } = {}) {
  const row = rows.find((r) => String(r.id) === String(id));
  if (!row) return;

  const mine = ++peekToken;
  const dlg = $('#peek');
  dlg.dataset.id = String(row.id);

  const link = new URL(location.href);
  link.hash = `f=${row.id}`;
  const url = link.toString();

  dlg.innerHTML = `
    <h2>${esc(row.name)}</h2>
    <p class="hint peek__by">${facePart(row)}
      Posted by <b>${esc(authorOf(row))}</b> · ${esc(fmtWhen(row.submitted_at))}</p>
    <div class="peek__card"><p class="hint" id="peek-wait">Drawing the card…</p></div>
    <div class="modal__actions">
      <a class="btn btn--primary" href="${esc(drafterLink(row))}" data-open="${esc(row.id)}">Open in the drafter</a>
      <button class="btn" type="button" data-copy>Copy link</button>
      <button class="btn" type="button" data-save>Save picture</button>
      ${ownedByMe(row) ? `
        <!-- Yours, so the two things only you can do. They sit apart from the
             three above: those act on a copy, these act on the posted row. -->
        <button class="btn peek__own" type="button" data-edit>Rename or re-word</button>
        <button class="btn btn--quiet peek__own peek__danger" type="button" data-remove
                title="Take this formation out of the gallery. It keeps its upvotes and can be put back for 30 days, after which it is erased for good.">Delete</button>` : ''}
      <button class="btn btn--quiet" type="button" data-close>Close</button>
    </div>`;
  if (!dlg.open) dlg.showModal();
  track('community-peeked');

  /*
   * Wired here, before the card is drawn, and not down with Copy and Save.
   * Those two act on the picture and cannot be offered until there is one;
   * these act on the row. A formation whose card fails to draw is exactly the
   * one somebody might want to delete, and it must not take its own delete
   * button down with it.
   */
  dlg.querySelector('[data-edit]')?.addEventListener('click', () => editPost(row));
  dlg.querySelector('[data-remove]')?.addEventListener('click', (e) => removePost(row, e.currentTarget));

  // The address bar becomes a thing worth copying, and Back closes the preview.
  if (push) history.pushState({ peek: String(row.id) }, '', url);

  /*
   * The real card, drawn by the same function that draws the shareable PNG.
   * That is the whole point of the shared renderer: a reader saving this
   * picture gets exactly what the poster would have got from Share.
   */
  let canvas = null;
  try {
    // The same card the list drew, at print scale — and with the byline it was
    // missing, so saving the picture from here credits the poster the way the
    // list already did.
    canvas = await drawCard({
      view: viewOf(row.snapshot ?? {}), full: true, stacked: stackedHere(), scale: 2,
      username: authorOf(row),
      avatar: row.author_avatar || '',
      note: row.note || '',
    });
  } catch (err) {
    console.error(err);
  }
  if (mine !== peekToken) return;       // a different formation was opened meanwhile

  const holder = dlg.querySelector('.peek__card');
  if (!holder) return;
  if (!canvas) {
    holder.innerHTML = '<p class="hint">Could not draw this one.</p>';
    return;
  }
  canvas.className = 'peek__canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', [
    `${row.name}: ${row.placed} Tatari on the field`,
    row.note,                       // drawn on the card, so unreadable without this
  ].filter(Boolean).join('. '));
  holder.replaceChildren(canvas);

  dlg.querySelector('[data-copy]')?.addEventListener('click', async () => {
    const ok = await copyText(url);
    toast(ok ? 'Link copied' : 'Could not copy. The link is in the address bar', ok ? 'ok' : 'error');
    if (ok) track('community-link-copied');
  });

  dlg.querySelector('[data-save]')?.addEventListener('click', async () => {
    const blob = await canvasBlob(canvas);
    if (!blob) { toast('Could not save that picture', 'error'); return; }
    downloadBlob(slugFilename(row.name, 'horde-formation', 'png'), blob);
    toast('Picture saved', 'ok');
    track('community-picture-saved');
  });
}

/** Drops a row's drawn card and its blob. Both helpers below need this first. */
function forgetShot(id) {
  const held = drawn.get(String(id));
  if (held) URL.revokeObjectURL(held);
  drawn.delete(String(id));
}

/**
 * Rebuilds one row in place, and redraws its card.
 *
 * `render({fresh: false})` only appends rows it has not seen, which is right
 * for paging and useless for an edit. The card has to be thrown away too: the
 * name and the note are painted into the picture now, so leaving the old blob
 * in place would make a successful edit look like it did nothing.
 */
function replaceRow(row) {
  forgetShot(row.id);
  const li = $(`#list [data-id="${CSS.escape(String(row.id))}"]`);
  if (!li) return;
  li.outerHTML = cardHTML(row);
  const img = $(`#list [data-shot="${CSS.escape(String(row.id))}"]`);
  if (img) shotWatcher.observe(img);
}

/** Takes one row off the page. */
function dropRow(id) {
  forgetShot(id);
  $(`#list [data-id="${CSS.escape(String(id))}"]`)?.remove();
}

/**
 * Renaming and re-wording, in place.
 *
 * Only these two fields, because only these two are safe to change: the board
 * is what people upvoted, and 004 grants update on `name` and `note` and
 * nothing else, so the database refuses anything wider regardless of what this
 * form sends.
 */
function editPost(row) {
  const dlg = $('#peek');
  const acts = dlg.querySelector('.modal__actions');
  if (!acts) return;

  acts.outerHTML = `
    <form class="peek__edit">
      <label class="submit__field">
        <span class="summary__label">Name</span>
        <input id="edit-name" class="field" type="text" maxlength="60"
               autocomplete="off" value="${esc(row.name)}">
      </label>
      <label class="submit__field">
        <span class="summary__label">What is it for? (optional)</span>
        <input id="edit-note" class="field" type="text" maxlength="240"
               autocomplete="off" value="${esc(row.note || '')}">
      </label>
      <p class="hint">The formation itself cannot be changed — that is what
        people upvoted. Delete it and post again to change the board.</p>
      <div class="modal__actions">
        <button class="btn btn--primary" type="submit">Save</button>
        <button class="btn btn--quiet" type="button" data-cancel>Cancel</button>
      </div>
    </form>`;

  const form = dlg.querySelector('.peek__edit');
  form.querySelector('[data-cancel]').addEventListener('click', () => openPeek(row.id, { push: false }));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#edit-name').value.trim();
    const note = $('#edit-note').value.trim();
    if (!name) { toast('A formation needs a name', 'error'); return; }
    if (name === row.name && note === (row.note || '')) { openPeek(row.id, { push: false }); return; }

    const go = form.querySelector('[type="submit"]');
    go.disabled = true;

    const res = await rest(`/formations?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      auth: true,
      // null rather than '', so an emptied note is absent rather than blank —
      // the column is nullable and the card tests it for content.
      body: { name, note: note || null },
      headers: { Prefer: 'return=minimal' },
    });

    if (!res.ok) {
      go.disabled = false;
      toast(res.why, 'error');
      return;
    }

    row.name = name;
    row.note = note;
    forgetCache();              // the cached page still holds the old words
    replaceRow(row);
    openPeek(row.id, { push: false });
    toast('Saved', 'ok');
    track('community-edited');
  });
}

/** Puts a soft-deleted formation back, votes and all. */
async function restorePost(row) {
  const res = await rest(`/formations?id=eq.${encodeURIComponent(row.id)}`, {
    method: 'PATCH', auth: true, body: { deleted_at: null },
    headers: { Prefer: 'return=minimal' },
  });
  if (!res.ok) { toast(res.why, 'error'); return; }

  forgetCache();
  // Straight back to the database rather than splicing the row into the list at
  // a remembered index: the sort is score-then-recency and the page may have
  // moved on, so where it belongs now is a question only the server can answer.
  await loadMore({ append: false });
  toast('Restored', 'ok');
  track('community-restored');
}

/**
 * Deleting your own post.
 *
 * Two things guard it, and they guard different mistakes.
 *
 * Two presses catch the press you did not mean to make: the button arms, says
 * so, and disarms itself after four seconds so a stray click cannot sit there
 * waiting to be completed by the next one.
 *
 * Undo catches the press you did mean and then regretted. That is only possible
 * because 005 made this a soft delete — `deleted_at` is set, the row stops being
 * readable, and the upvotes stay attached to it. A hard DELETE cascades the
 * votes away, and restoring a formation without its score is not restoring it.
 *
 * After thirty days the purge makes it real. The button's title says so, since
 * that is the part no amount of interface can take back.
 */
async function removePost(row, btn) {
  if (btn.dataset.armed !== 'yes') {
    btn.dataset.armed = 'yes';
    btn.textContent = 'Delete it?';
    btn.classList.add('is-armed');
    setTimeout(() => {
      if (!btn.isConnected || btn.dataset.armed !== 'yes') return;
      delete btn.dataset.armed;
      btn.textContent = 'Delete';
      btn.classList.remove('is-armed');
    }, 4000);
    return;
  }

  btn.disabled = true;
  const res = await rest(`/formations?id=eq.${encodeURIComponent(row.id)}`, {
    method: 'PATCH', auth: true, body: { deleted_at: new Date().toISOString() },
    headers: { Prefer: 'return=minimal' },
  });

  if (!res.ok) {
    btn.disabled = false;
    delete btn.dataset.armed;
    btn.textContent = 'Delete';
    btn.classList.remove('is-armed');
    toast(res.why, 'error');
    return;
  }

  dropRow(row.id);
  rows = rows.filter((r) => String(r.id) !== String(row.id));
  if (Number.isInteger(total)) total = Math.max(0, total - 1);
  forgetCache();
  closePeek();
  render({ fresh: false });   // repaints the count and the "load more" state
  sayIfEmpty();               // ...and this says so if that was the last one
  toast('Deleted. Its upvotes are kept for 30 days.', 'ok',
    { label: 'Undo', fn: () => restorePost(row) });
  track('community-deleted');
}

function closePeek({ pop = true } = {}) {
  const dlg = $('#peek');
  peekToken++;
  delete dlg.dataset.id;
  if (dlg.open) dlg.close();
  // Put the address back to the gallery, so copying it later copies the list.
  if (pop && location.hash.startsWith('#f=')) {
    history.pushState(null, '', location.pathname + location.search);
  }
}

/** `#f=<id>` in the address: somebody was sent one formation. */
function openFromHash() {
  const m = /^#f=(.+)$/.exec(location.hash);
  if (!m) { closePeek({ pop: false }); return; }
  const id = decodeURIComponent(m[1]);
  if (rows.some((r) => String(r.id) === id)) { openPeek(id, { push: false }); return; }

  // Sent a link to something below the first page. Fetch just that one.
  rest(`/formation_cards?select=${COLUMNS}&id=eq.${encodeURIComponent(id)}&limit=1`, { cache: true })
    .then((res) => {
      const row = res.ok && Array.isArray(res.data) ? res.data[0] : null;
      if (!row) { toast('That formation is not there any more', 'error'); return; }
      if (!rows.some((r) => String(r.id) === String(row.id))) rows = [row, ...rows];
      render();
      openPeek(row.id, { push: false });
    });
}

// ---------------------------------------------------------------- patches

/**
 * The game publishes no patch identifier anywhere this tool can read, so a
 * patch here is a maintainer's judgement with a source attached. When none has
 * been recorded, that is a coherent state and gets said once rather than
 * twenty times: no chip on any row, no filter, and one line under the hint.
 */
async function loadPatches() {
  const res = await rest('/patches?select=id,label,starts_at,source_url&order=starts_at.desc',
    { cache: true });
  patches = res.ok && Array.isArray(res.data) ? res.data : [];

  const host = $('#patch-filter');
  if (!patches.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.innerHTML = [
    '<button class="segmented__btn" type="button" data-patch="" aria-pressed="true">Any patch</button>',
    ...patches.slice(0, 3).map((p) => `<button class="segmented__btn" type="button"
        data-patch="${esc(p.id)}" aria-pressed="false">${esc(p.label)}</button>`),
  ].join('');
}

/** Points a segmented group at one value and repaints its pressed states. */
function pick(host, attr, value) {
  for (const btn of host.querySelectorAll('[data-' + attr + ']')) {
    btn.setAttribute('aria-pressed', String(btn.dataset[attr] === value));
  }
}

/** Any change to sort or filter starts the list again from the top. */
/**
 * Says why the list is empty, if it is.
 *
 * Shared because there are two ways to arrive at an empty list and only one of
 * them used to say anything. Filtering down to nothing explained itself;
 * deleting your last formation left a blank panel under a "0 of 0" — which
 * reads as the page having broken, at the exact moment somebody has just done
 * something irreversible-looking and most wants reassuring.
 */
function sayIfEmpty() {
  if (rows.length || saying()) return;
  /*
   * Yours gets its own sentence. "Try widening it" is the right advice for a
   * tier or a patch and useless for this one: the reason is not that the filter
   * is narrow, it is that this browser has no record of the post — most likely
   * because it was made from a different one, or because storage was cleared.
   * Saying so is the difference between a filter and a missing formation.
   */
  if (view.mine) {
    say('Nothing here that this browser posted. Posts made on another device, or '
      + 'before this browser\'s storage was cleared, are still in the gallery — '
      + 'they are just not on this list.');
    return;
  }
  say(view.mode || view.patch || view.tier
    ? 'Nothing posted matches that yet. Try widening it.'
    : 'Nothing has been posted yet.');
}

async function refine(change) {
  Object.assign(view, change);
  rows = [];
  total = null;
  forgetCache();
  await loadMore({ append: false });
  sayIfEmpty();
}

// ---------------------------------------------------------------- boot

async function main() {
  buildAnalytics();

  /*
   * First, and before anything reads the address or the session.
   *
   * Signing in sends you to Discord and back with `#access_token=…` on the
   * fragment, and this is what turns that into a session. It was only ever
   * called on the drafter — so signing in *from this page* completed at
   * Discord, returned here, and dropped the token on the floor. Pressing
   * Upvote then asked you to sign in again, for ever.
   *
   * Nothing caught it because the two ways in overlap: posting starts on the
   * drafter, where the drafter's own call handled it, and anybody who had ever
   * posted arrived here with a token already in `localStorage`. It took being
   * able to sign out to reach the path at all.
   *
   * Before the roster loads, because that is a network wait, and before
   * openFromHash(), because both read `location.hash` and this one clears it
   * when it is an auth return rather than a `#f=` link.
   */
  const returned = readCallback();
  if (returned === 'failed') toast('That sign-in did not complete. Try again.', 'error');

  try {
    await load();
  } catch (err) {
    say('Could not load the Tatari roster, so formations cannot be drawn. '
      + 'If you opened this file directly, serve the folder over HTTP instead.');
    console.error(err);
    return;
  }

  $('#list').addEventListener('click', (e) => {
    // A real anchor: let the browser navigate, so the fragment lands the way a
    // pasted link would and middle-click still opens a tab.
    if (e.target.closest('[data-open]')) { track('community-loaded'); return; }
    const vote = e.target.closest('[data-vote]');
    if (vote) { onVote(vote.dataset.vote); return; }
    // Before the open-row check below: this button sits inside the row, and
    // deleting a formation must not also open it on the way past.
    const gone = e.target.closest('[data-remove-row]');
    if (gone) {
      e.stopPropagation();
      const target = rows.find((r) => String(r.id) === String(gone.dataset.removeRow));
      if (target) removePost(target, gone);
      return;
    }
    /*
     * The card used to open a preview, and a "Look" button beside it did the
     * same thing — two controls for one action, which only existed because the
     * row showed too little to act on. The row is the whole formation now, so
     * pressing it does the thing you came for.
     */
    const row = e.target.closest('[data-open-row]');
    if (row) {
      const link = e.target.closest('.community__item')?.querySelector('[data-open]');
      if (link) { track('community-loaded'); location.href = link.href; }
    }
  });

  $('#list-more').addEventListener('click', () => loadMore());

  // The rows are tall enough that the top of a filtered list is a long way up.
  document.querySelector('[data-top]')?.addEventListener('click', () => {
    scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#sort-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn || btn.dataset.sort === view.sort) return;
    pick($('#sort-switch'), 'sort', btn.dataset.sort);
    track(btn.dataset.sort === 'top' ? 'community-sort-top' : 'community-sort-new');
    refine({ sort: btn.dataset.sort });
  });

  $('#mode-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn || btn.dataset.mode === view.mode) return;
    pick($('#mode-filter'), 'mode', btn.dataset.mode);
    track('community-filtered');
    refine({ mode: btn.dataset.mode });
  });

  $('#whoami').addEventListener('click', (e) => {
    if (e.target.closest('[data-signout]')) onSignOut();
  });

  $('#tier-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tier]');
    if (!btn || btn.dataset.tier === view.tier) return;
    pick($('#tier-filter'), 'tier', btn.dataset.tier);
    track('community-filtered');
    refine({ tier: btn.dataset.tier });
  });

  /*
   * Shown only once this browser has posted something. Before that the control
   * has exactly one honest answer and it is an empty list, which on this page
   * reads as a fault rather than as a filter.
   */
  const mineHost = $('#mine-filter');
  mineHost.hidden = posted().length === 0;
  mineHost.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mine]');
    if (!btn || btn.dataset.mine === view.mine) return;
    pick(mineHost, 'mine', btn.dataset.mine);
    track(btn.dataset.mine ? 'community-mine' : 'community-filtered');
    refine({ mine: btn.dataset.mine });
  });

  $('#patch-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-patch]');
    if (!btn || btn.dataset.patch === view.patch) return;
    pick($('#patch-filter'), 'patch', btn.dataset.patch);
    track('community-filtered');
    refine({ patch: btn.dataset.patch });
  });

  const dlg = $('#peek');
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-open]')) track('community-loaded');
  });
  dismissOnBackdrop(dlg, closePeek);
  // Escape closes it natively, which must still put the address back.
  dlg.addEventListener('close', () => {
    if (location.hash.startsWith('#f=')) history.pushState(null, '', location.pathname + location.search);
  });

  addEventListener('popstate', openFromHash);

  /*
   * A drawn card is a PNG of the palette that was live when it was drawn, so a
   * system theme flip mid-session leaves ten dark cards on a light page. The
   * blobs are dropped and the visible rows redraw; palette() re-reads the
   * variables on the way through.
   */
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    releaseShots();
    for (const img of $('#list').querySelectorAll('[data-shot]')) {
      img.removeAttribute('src');
      img.classList.remove('is-drawn');
      shotWatcher.observe(img);
    }
  });

  if (!isConfigured()) {
    say('This copy of Horde Drafter is not connected to a community list, '
      + 'so there is nothing to show here. The drafter itself works as normal.');
    $('#list-count').textContent = '';
    return;
  }

  track('community-opened');

  /*
   * Both before the list paints, because both change what a row says: a patch
   * label, and whether the keep button is already pressed. Painting first and
   * correcting after would flicker every row.
   */
  await Promise.all([loadPatches(), loadMyVotes()]);
  paintWhoAmI();

  // Came back from signing in mid-keep: put the reader back where they were.
  let resume = null;
  try {
    resume = JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null');
    sessionStorage.removeItem(RESUME_KEY);
  } catch { /* nothing was stashed */ }
  if (resume?.view) {
    Object.assign(view, resume.view);
    pick($('#sort-switch'), 'sort', view.sort);
    pick($('#mode-filter'), 'mode', view.mode);
    pick($('#tier-filter'), 'tier', view.tier);
    if (!$('#mine-filter').hidden) pick($('#mine-filter'), 'mine', view.mine);
    if (!$('#patch-filter').hidden) pick($('#patch-filter'), 'patch', view.patch);
  }

  await loadMore({ append: false });

  for (let i = 1; i < (resume?.pages ?? 1); i++) await loadMore();
  if (resume?.vote && signedIn()) await onVote(resume.vote);
  if (resume?.scroll) scrollTo({ top: resume.scroll, behavior: 'instant' });

  /*
   * Only when nothing else is being said. This used to run unconditionally and
   * overwrite a failed fetch with "Nothing has been posted yet" — telling
   * somebody whose request timed out that the gallery was empty, and wiping the
   * Try again button on the way past.
   */
  if (!rows.length && !saying()) say('Nothing has been posted yet.');

  if (location.hash.startsWith('#f=')) openFromHash();
}

main();
