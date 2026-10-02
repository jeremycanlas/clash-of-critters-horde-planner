/**
 * Posting a formation to the community list.
 *
 * The one thing in the drafter that sends anything anywhere, and it only
 * happens on a press of a button that says so. Everything else here (the
 * field, the benches, the plan, the saved list) stays in this browser exactly
 * as it always has.
 *
 * The dialog shows the board before it shows the buttons, because you should be
 * able to see what you are about to publish rather than trust a name. There is
 * no consent checkbox: this is unreachable except by pressing Post, the
 * disclosure sits directly above the confirm, and the confirm itself says
 * "publicly". A checkbox on top of that would be theatre.
 */

import { $, toast, dismissOnBackdrop, APP_VERSION } from './ui.js';
import { mapHTML, statsOf, unknownSlugs } from './formation-card.js';
import { isConfigured, signedIn, signIn, whoAmI, rest, forgetCache } from './supabase.js';
import { track } from './analytics.js';

/** What this browser has posted, so it knows what it may delete. */
const POSTED_KEY = 'coc.posted.v1';

/** Survives the trip to Discord and back, so Post resumes where it left off. */
const PENDING_KEY = 'coc.post-pending.v1';

const MAX_NAME = 60;
const MAX_NOTE = 240;

/** The save currently in the dialog. */
let held = null;

// ---------------------------------------------------------------- posted list

export function posted() {
  try {
    const list = JSON.parse(localStorage.getItem(POSTED_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function rememberPosted(entry) {
  try {
    localStorage.setItem(POSTED_KEY, JSON.stringify([entry, ...posted()].slice(0, 200)));
  } catch { /* private mode: you lose the ability to delete, not the post */ }
}

// ---------------------------------------------------------------- the dialog

/**
 * @param {{id: string, name: string, data: object}} save a saved formation
 */
export function openSubmit(save) {
  if (!isConfigured()) { toast('This copy is not connected to a community list'); return; }

  const cells = save?.data?.cells ?? [];
  const { placed, modeLabel, steps } = statsOf(save.data);
  if (!placed) { toast('Put some Tatari on the field first'); return; }

  held = save;
  const dlg = $('#dlg-submit');
  const missing = unknownSlugs(cells);
  const me = whoAmI();

  $('#submit-map').innerHTML = mapHTML(cells, { cell: 22 });
  $('#submit-facts').textContent =
    [modeLabel, `${placed} placed`, steps ? `${steps} level-up steps` : ''].filter(Boolean).join(' · ');
  $('#submit-name').value = (save.name ?? '').slice(0, MAX_NAME);
  $('#submit-note').value = '';

  /*
   * Refused before the network, not after it. A build using Tatari that only
   * exist in this browser is unreadable to everybody else, and posting it would
   * put a row in the list that nobody can render. Better not posted than posted
   * wrong.
   */
  const blocked = missing.length > 0;
  const why = $('#submit-why');
  why.hidden = !blocked;
  why.textContent = blocked
    ? `This build uses ${missing.length} Tatari that ${missing.length === 1 ? 'only exists' : 'only exist'} `
      + 'in your browser. Nobody else could read it, so it cannot be posted.'
    : '';

  const go = $('#submit-go');
  go.disabled = blocked;
  go.textContent = signedIn() ? 'Post it publicly' : 'Sign in with Discord and post';

  $('#submit-who').textContent = me
    ? `Posting as ${me.name}.`
    : 'You will be asked to sign in with Discord first.';

  dlg.showModal();
}

/** Sends it. The server derives everything except these four fields. */
async function post() {
  if (!held) return;
  const go = $('#submit-go');
  const name = $('#submit-name').value.trim().slice(0, MAX_NAME) || held.name || 'Untitled formation';
  const note = $('#submit-note').value.trim().slice(0, MAX_NOTE);

  // Not signed in yet: stash what we were doing and leave for Discord. The
  // dialog reopens on the way back, filled in the same way.
  if (!signedIn()) {
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id: held.id, name, note }));
    } catch { /* it will just reopen empty */ }
    signIn();
    return;
  }

  go.disabled = true;
  go.textContent = 'Posting…';

  /*
   * `?select=id` is load-bearing, not tidiness. `return=representation` alone
   * makes PostgREST do RETURNING *, and * includes author_id, author_avatar and
   * fingerprint — three columns nobody is granted read on, by design. The row
   * inserts fine and then the *return* is refused, which surfaces as a flat
   * "permission denied" on a post that actually worked. Naming the one column
   * we use keeps the write and the read inside the same grant.
   */
  const res = await rest('/formations?select=id', {
    method: 'POST',
    auth: true,
    body: { name, note: note || null, snapshot: held.data, app_version: APP_VERSION },
    headers: { Prefer: 'return=representation' },
  });

  go.disabled = false;
  go.textContent = 'Post it publicly';

  if (!res.ok) {
    // The database's own refusals are written to be read by whoever pressed the
    // button — "Five posts an hour is the limit" arrives intact.
    toast(res.why, 'error', { label: 'Try again', fn: post });
    return;
  }

  /*
   * The gallery's page cache is now wrong, and it has to be told so from here.
   *
   * That cache lives in sessionStorage with a three-minute life, which means a
   * reload does not clear it — sessionStorage survives F5. So posting from the
   * drafter and then going to the gallery showed the list as it was *before*
   * the post, and refreshing did nothing, for three minutes: "it said it was
   * created and it is not there", which is the worst possible answer to give
   * somebody who has just published something.
   *
   * Every other writer here already does this — voting, editing and deleting
   * all call it. Posting is the one that never did, and it is the one where
   * being out of date is most alarming.
   */
  forgetCache();

  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  if (row?.id) rememberPosted({ id: row.id, name, at: Date.now() });

  $('#dlg-submit').close();
  track('community-posted');

  /*
   * Straight to the formation, not to a toast offering to take you there.
   *
   * "Uploaded a formation. Wasn't immediately obvious how to find it though" is
   * what a player said about the old ending, and both halves of why are real. A
   * toast is gone in six seconds and takes its only link with it. And the link
   * it carried went to the gallery, which sorts by upvotes — so a formation
   * posted a second ago, with none, is not at the top and may not be on the
   * first page at all. The one thing that could not happen was the thing
   * expected: seeing it.
   *
   * `#f=<id>` is the address of that one formation, and community.js fetches a
   * row by id when it is not in the page it loaded — so this works whether the
   * post landed first or hundredth. It is also the link worth copying, which is
   * the next thing anybody does after posting.
   */
  if (row?.id) {
    location.href = `community.html#f=${encodeURIComponent(row.id)}`;
    return;
  }

  // No id came back, so there is nowhere specific to go. The row did post.
  toast(`Posted "${name}"`, 'ok', {
    label: 'See it',
    fn: () => { location.href = 'community.html'; },
  });
}

// ---------------------------------------------------------------- build

export function buildSubmit() {
  const dlg = $('#dlg-submit');
  if (!dlg) return;

  $('#submit-go').addEventListener('click', post);

  dismissOnBackdrop(dlg);

  // Came back from Discord mid-post. readCallback() has already consumed the
  // fragment by now — app.js calls it before this runs.
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null');
    sessionStorage.removeItem(PENDING_KEY);
  } catch { /* nothing was pending */ }
  return pending;
}

/** Reopens the dialog for a save that was mid-post when sign-in interrupted it. */
export function resumeSubmit(save, pending) {
  openSubmit(save);
  if (pending?.name) $('#submit-name').value = pending.name;
  if (pending?.note) $('#submit-note').value = pending.note;
}
