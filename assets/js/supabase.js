/**
 * The one service this project talks to.
 *
 * Everything else in Horde Drafter runs off files in this repo, and the drafter
 * itself still does — index.html and contribute.html never import this module.
 * Only the community gallery does, which is why an unreachable database costs
 * you a gallery and nothing else.
 *
 * ## The key below is public on purpose
 *
 * `anonKey` is a JWT whose entire content is `role: anon`. It is an address, not
 * a secret: every table it can reach is behind row-level security, and those
 * policies are in `supabase/migrations/` where anyone can read them. Shipping it
 * in client JavaScript is how the product is designed to work. The service key,
 * which does bypass those policies, is never in this repo and only ever lives in
 * a maintainer's environment.
 *
 * ## Failure is not an error state
 *
 * Every function here returns `{ok: false, why}` rather than throwing — the same
 * contract `issues.js` uses, for the same reason. A page that shows somebody a
 * red banner because a free-tier database was asleep is a worse page than the
 * one that never asked.
 *
 * The one refinement on that policy: silence is right for work nobody asked for,
 * like a list loading on arrival. It is wrong for a button. When somebody presses
 * Post or Like, they are owed an answer either way, so those callers surface the
 * `why` in a toast with a Retry rather than swallowing it.
 *
 * No SDK. The client library would be this project's first runtime dependency and
 * would have to be vendored to keep a clone working offline, and PostgREST is a
 * plain REST API — the whole transport is one `fetch` wrapper.
 */

/*
 * Fill these in to connect a copy of this site to a community list.
 *
 *   Supabase dashboard -> your project -> Settings (the gear) -> API
 *     url     : "Project URL",  https://<something>.supabase.co
 *     anonKey : the key marked "anon" / "public" — or, on newer projects,
 *               "Publishable key" (sb_publishable_…). Either works.
 *
 * The key marked "service_role" / "secret" does NOT go here, or anywhere else
 * in this repository. It bypasses every row-level security policy in
 * supabase/migrations/, so a copy of it is a copy of the whole database. It
 * belongs in the environment of whoever runs tools/, and nowhere a browser or
 * a git history can reach.
 *
 * Left blank on purpose: a fork gets a gallery that says it is not connected
 * rather than one that silently posts into somebody else's database.
 */
export const CONFIG = {
  url: 'https://bjcumuhpblevbiqzzmli.supabase.co',
  anonKey: 'sb_publishable_oT6efCRk05pz6vICkJUjAA_QKbtp902',
};

/**
 * Three minutes. Long enough that browsing does not re-fetch on every paint,
 * short enough that a formation posted mid-session turns up before it ends.
 * Callers say whether a request is cacheable; how long is this module's problem.
 */
const FRESH_FOR = 3 * 60 * 1000;
const CACHE_KEY = 'coc.community.cache.v1';

/**
 * False in a fork, or before the maintainer has filled CONFIG in.
 *
 * Deliberately loose about the key's shape: Supabase issues both the legacy
 * `eyJ…` JWT and the newer `sb_publishable_…` form, and a self-hosted project
 * is not on supabase.co at all. Anything that looks like a host and a key of
 * plausible length is treated as configured — a wrong one fails at the first
 * request with a message, which is a better place to find out than a silent
 * "not connected" that looks identical to having filled in nothing.
 */
export function isConfigured() {
  return /^https:\/\/[^/\s]+\.[^/\s]+/.test(CONFIG.url) && CONFIG.anonKey.trim().length >= 20;
}

/**
 * One PostgREST call.
 *
 * @param {string} path e.g. `/formation_cards?select=*&order=submitted_at.desc`
 * @param {{method?: string, body?: object, headers?: object, cache?: boolean,
 *          signal?: AbortSignal}} [opts]
 *   `cache` marks a request as repeatable within a tab. Only GETs are cached.
 * @returns {Promise<{ok: true, data: any, total: number|null}
 *                 | {ok: false, why: string, status: number}>}
 */
export async function rest(path, opts = {}) {
  const { method = 'GET', body, headers = {}, cache = false, auth = false, signal } = opts;

  if (!isConfigured()) {
    return { ok: false, why: 'This copy of Horde Drafter is not connected to a community list.', status: 0 };
  }

  if (method === 'GET' && cache) {
    const held = readCache(path);
    if (held) return { ok: true, data: held.data, total: held.total };
  }

  // Anything that writes goes out as the signed-in person, so the policies in
  // 001_community.sql can see an auth.uid() to check against.
  let bearer = CONFIG.anonKey;
  if (auth) {
    const got = await token();
    if (!got.ok) return { ok: false, why: got.why, status: 401 };
    bearer = got.jwt;
  }

  let res;
  try {
    res = await fetch(`${CONFIG.url}/rest/v1${path}`, {
      method,
      signal,
      headers: {
        apikey: CONFIG.anonKey,
        authorization: `Bearer ${bearer}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // Abort is the caller changing its mind, not a failure worth wording.
    if (err?.name === 'AbortError') return { ok: false, why: '', status: 0 };
    return { ok: false, why: 'Could not reach the community list.', status: 0 };
  }

  if (!res.ok) return { ok: false, why: await reasonFor(res, method), status: res.status };

  let data = null;
  if (res.status !== 204) {
    try { data = await res.json(); } catch { data = null; }
  }

  // `Prefer: count=exact` answers in Content-Range as `0-19/431`.
  const total = countOf(res.headers.get('content-range'));

  if (method === 'GET' && cache) writeCache(path, { data, total });
  return { ok: true, data, total };
}

/**
 * Something a person could act on, never a status code on its own.
 *
 * PostgREST puts a useful sentence in `message` and often a better one in
 * `hint`, and the RAISE messages in the migrations are written to be read by
 * whoever pressed the button — "Five posts an hour is the limit" comes straight
 * through.
 */
async function reasonFor(res, method = 'GET') {
  let body = null;
  try { body = await res.json(); } catch { /* an empty or non-JSON body is just a body */ }
  const code = body?.code;
  const said = body?.message || body?.hint || body?.details;

  /*
   * The code first, then the status. Postgres answers a missing GRANT with a
   * 401, which is indistinguishable at the status line from an expired
   * session — and telling somebody to sign in again when the fault is in this
   * site's own setup sends them round a loop that cannot end. 42501 is ours to
   * fix, and the message says so.
   */
  if (code === '42501') {
    return 'The community list is set up wrong and refused that. Nothing you did. '
      + 'This one is for the maintainer.';
  }
  /*
   * PostgREST reports an undefined function as 404, which at the status line is
   * indistinguishable from a row that is not there — so a broken trigger came
   * back as "that formation is not there any more" on a POST that was creating
   * one. Anything in this family is a fault in the schema, and saying so beats
   * inventing a story about the data.
   */
  if (code === 'PGRST205' || code === '42P01' || code === '42883' || code === '42704') {
    return 'The community list is not finished being set up yet. This one is for the maintainer.';
  }
  if (code === '23505') return 'You have already posted this one.';
  // P0001 is a RAISE from the migrations, worded for whoever pressed the button.
  if (code === 'P0001' && said) return String(said);

  if (res.status === 401 || res.status === 403) {
    return 'Your sign-in was refused. Press Post again to sign in.';
  }
  // Only meaningful when we were fetching one. A 404 on a write is a routing
  // or schema problem and has been handled by code above.
  if (res.status === 404 && method === 'GET') return 'That formation is not there any more.';
  if (res.status === 404) return 'The community list could not accept that. This one is for the maintainer.';
  if (res.status === 429 || res.status === 503) {
    return 'The community list is busy. Try again in a moment.';
  }
  if (said) return String(said);
  return res.status === 409
    ? 'That is already there.'
    : `The community list answered ${res.status}.`;
}

function countOf(contentRange) {
  const slash = contentRange?.lastIndexOf('/') ?? -1;
  if (slash === -1) return null;
  const n = Number(contentRange.slice(slash + 1));
  return Number.isInteger(n) ? n : null;
}

// ---------------------------------------------------------------- who you are

/**
 * Signing in, and why it looks like this.
 *
 * Discord rather than an account of our own: the people this tool is for are
 * already on Discord, where formations get posted and where every
 * feature request in the changelog came from, and a password nobody wanted to
 * invent is a password we would then have to keep.
 *
 * A note on scope, because the obvious thing does not work. Supabase's Discord
 * provider hard-codes `email identify` and *appends* anything passed as
 * `scopes` rather than replacing it — asking for `scopes=identify` produces
 * `scope=email+identify+identify` and changes nothing. There is no way from
 * here to stop Discord returning an email address, so Supabase stores one in
 * `auth.users`. This app never reads it, never shows it, and never copies it
 * into a formation row; the only thing that leaves `auth.users` is the display
 * name, put there by derive_formation(). The README says exactly this rather
 * than claiming an address is never collected, because it is.
 *
 * It is lazy on purpose. Nothing in here runs until somebody presses Post —
 * browsing the gallery signs you into nothing and asks you for nothing.
 */

const SESSION_KEY = 'coc.community.v1';

/** The access token, in memory only. Short-lived, and refreshed from the store. */
let live = { jwt: '', until: 0 };

function session() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null'); } catch { return null; }
}

function keepSession(next) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* private mode */ }
}

/** True when there is something to refresh from. Does not prove it still works. */
export const signedIn = () => !!session()?.refresh_token;

/** @returns {{uid: string, name: string, avatar: string|null}|null} */
export function whoAmI() {
  const held = session();
  return held?.uid ? { uid: held.uid, name: held.name || 'Someone', avatar: held.avatar ?? null } : null;
}

/** Discord's own words for who somebody is, in the order they are worth showing. */
function nameOf(user) {
  const m = user?.user_metadata ?? {};
  return m.custom_claims?.global_name || m.full_name || m.name || m.user_name || 'Someone';
}

function remember(payload) {
  if (!payload?.refresh_token) return;
  live = {
    jwt: payload.access_token ?? '',
    // A minute of slack, so a request never leaves with a token that expires
    // while it is in flight.
    until: Date.now() + Math.max(0, (Number(payload.expires_in) || 3600) - 60) * 1000,
  };
  keepSession({
    refresh_token: payload.refresh_token,
    uid: payload.user?.id ?? session()?.uid ?? '',
    name: payload.user ? nameOf(payload.user) : session()?.name ?? '',
    avatar: payload.user?.user_metadata?.avatar_url ?? session()?.avatar ?? null,
  });
}

/**
 * Leaves for Discord and does not come back — the browser navigates away, and
 * the answer arrives as a fragment on `returnTo`, which readCallback() picks up.
 *
 * `returnTo` defaults to this page's address with neither its fragment nor its
 * query, so you land back where you were rather than somewhere central.
 *
 * Dropping the query is not tidiness. Supabase checks this against the
 * project's allowed redirect URLs, matched as a glob over the whole string —
 * so every `?something` that can appear in the address is another shape the
 * allow-list has to cover, and a miss does not fail loudly: it silently returns
 * the visitor to the Site URL instead, which on a phone pointed at a dev server
 * means being thrown to the production site mid-sign-in. Nothing here reads its
 * own query string, so there is nothing to preserve and one less way to be
 * wrong.
 *
 * A new deployment, or a new address you develop against, still needs adding to
 * that list — origin and port included, since both are part of the match.
 */
export function signIn(returnTo = `${location.origin}${location.pathname}`) {
  if (!isConfigured()) return;
  // No `scopes` param: Supabase appends to its own defaults rather than
  // replacing them, so passing `identify` only ever produced a duplicate.
  const url = `${CONFIG.url}/auth/v1/authorize`
    + `?provider=discord`
    + `&redirect_to=${encodeURIComponent(returnTo)}`;
  location.href = url;
}

/**
 * Takes the session out of the URL on the way back from Discord.
 *
 * Must run before anything else reads `location.hash`. On the drafter that hash
 * is the share-link format, and an `#access_token=…` left lying in it would sit
 * in the address bar looking like a formation and get copied into a share link
 * by somebody who trusted the address bar.
 *
 * @returns {'signed-in'|'failed'|null} null when this was an ordinary page load
 */
export function readCallback() {
  const hash = location.hash.slice(1);
  if (!hash || !/(^|&)(access_token|error|error_description)=/.test(hash)) return null;

  const got = new URLSearchParams(hash);
  const clean = () => history.replaceState(null, '', location.pathname + location.search);

  if (got.get('error') || !got.get('access_token')) { clean(); return 'failed'; }

  remember({
    access_token: got.get('access_token'),
    refresh_token: got.get('refresh_token'),
    expires_in: got.get('expires_in'),
  });
  clean();

  // The fragment carries no profile, so the name is fetched once, here, rather
  // than on every later request.
  refreshProfile();
  return 'signed-in';
}

async function refreshProfile() {
  const got = await token();
  if (!got.ok) return;
  try {
    const res = await fetch(`${CONFIG.url}/auth/v1/user`, {
      headers: { apikey: CONFIG.anonKey, authorization: `Bearer ${got.jwt}` },
    });
    if (!res.ok) return;
    const user = await res.json();
    const held = session() ?? {};
    keepSession({
      ...held,
      uid: user?.id ?? held.uid ?? '',
      name: nameOf(user),
      avatar: user?.user_metadata?.avatar_url ?? null,
    });
  } catch { /* a missing display name is not worth interrupting anyone over */ }
}

/**
 * A usable access token, refreshing it if the one in memory has gone stale.
 * @returns {Promise<{ok: true, jwt: string} | {ok: false, why: string}>}
 */
export async function token() {
  if (live.jwt && Date.now() < live.until) return { ok: true, jwt: live.jwt };

  const held = session();
  if (!held?.refresh_token) return { ok: false, why: 'You are not signed in.' };

  let res;
  try {
    res = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: CONFIG.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: held.refresh_token }),
    });
  } catch {
    return { ok: false, why: 'Could not reach the community list.' };
  }

  if (!res.ok) {
    // A refused refresh is a session that has ended, not a transient failure —
    // holding onto it would make every later attempt fail the same way.
    signOut();
    return { ok: false, why: 'Your sign-in has expired. Press Post again to sign in.' };
  }

  const payload = await res.json().catch(() => null);
  if (!payload?.access_token) return { ok: false, why: 'The sign-in service sent something unreadable.' };
  remember(payload);
  return { ok: true, jwt: payload.access_token };
}

/**
 * Forgets the session here, and ends it on the server too.
 *
 * The local half was all this used to do, and it was not enough. What is kept
 * in `localStorage` is a *refresh token*, and localStorage does not expire, so a
 * browser somebody else opens later could post, delete and vote as whoever last
 * signed in. Dropping the token locally leaves the session alive on the server,
 * along with the IP recorded against it; only the logout endpoint ends it.
 *
 * The session behind it is now time-boxed as well -- 30 days, or 7 days unused,
 * enforced by `expire-stale-sessions` in supabase/migrations/008. That bounds
 * the damage; it does not replace this. Thirty days is a long time to be able to
 * post as somebody else, and a sign-out is the only thing that ends it now.
 *
 * `scope=local` rather than the default `global`: signing out of a borrowed
 * laptop should not sign you out on your phone.
 *
 * Local state is cleared first and unconditionally. A logout that cannot reach
 * the network must still sign you out of the browser in front of you —
 * refusing to would be exactly backwards, since the person asking is most
 * likely the one at a machine they do not own.
 *
 * Not awaited by callers, and it takes its own copy of the token before
 * clearing, because after this returns there is nothing left to authenticate
 * with.
 */
export function signOut() {
  const jwt = live.jwt;
  live = { jwt: '', until: 0 };
  try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing to drop */ }

  if (!jwt || !isConfigured()) return;
  fetch(`${CONFIG.url}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: { apikey: CONFIG.anonKey, authorization: `Bearer ${jwt}` },
    // The tab may be closing; this asks the browser to send it anyway.
    keepalive: true,
  }).catch(() => { /* signed out here regardless — see above */ });
}

// ---------------------------------------------------------------- cache

/**
 * Per tab, not per browser. A community list is somebody else's data and it
 * changes; keeping it past the tab would mean opening the page tomorrow to
 * yesterday's ranking with no way to tell.
 */
function readCache(path) {
  try {
    const all = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '{}');
    const held = all[path];
    if (!held || Date.now() - held.at > FRESH_FOR) return null;
    return held;
  } catch { return null; }
}

function writeCache(path, value) {
  try {
    const all = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '{}');
    all[path] = { ...value, at: Date.now() };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* private mode, or full - the fetch just repeats */ }
}

/** Drops the cache, so the next read is live. For a Retry button. */
export function forgetCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* nothing to drop */ }
}
