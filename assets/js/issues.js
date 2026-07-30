/**
 * What is already in flight.
 *
 * The recorder's whole problem is duplicated effort. Somebody reads Clucky's
 * heal reach off the game, opens an issue, and it sits there until a maintainer
 * gets to it — during which the roster still shows Clucky as "nothing recorded",
 * so the next contributor reads exactly the same range and opens exactly the
 * same issue. Neither of them ever finds out.
 *
 * So the open issues are read back and the roster says which Tatari already
 * have one. It is the only thing on the page that talks to the network, and it
 * is one-way: a GET to the public issues endpoint, no token, no body, nothing
 * about what you are recording. What you have drawn stays where it always was.
 *
 * Failure is not an error state here. Rate-limited, offline, fork with issues
 * turned off — the page works exactly as it did before, minus one hint. Making
 * a contributor look at a red banner because GitHub is busy would be a worse
 * page than the one that never asked.
 */

import { parseContribution } from './range-import.js';

/** Cached per tab: the roster is repainted on every filter keystroke. */
const CACHE_KEY = 'coc.issues.v1';
/**
 * Ten minutes. Unauthenticated GitHub allows 60 requests an hour per address,
 * and a contributor working through a handful of Tatari will reload a few
 * times — long enough to stay well clear of the ceiling, short enough that an
 * issue opened mid-session shows up before the session ends.
 */
const FRESH_FOR = 10 * 60 * 1000;

/** The recorder's own issue title: "Attack range: Clucky", "Heal range: Shellshy". */
const TITLE = /^\s*(attack|heal|buff|debuff)\s+range:\s*(.+?)\s*$/i;

/**
 * @typedef {object} OpenIssue
 * @property {number} number
 * @property {string} title
 * @property {string} url
 */

/** @type {Map<string, OpenIssue>} "kind\nslug" → the issue that covers it */
let found = new Map();

export const issueKey = (slug, kind) => `${kind}\n${slug}`;

/** The open issue covering this Tatari and reach, or null. */
export function issueFor(slug, kind) {
  return found.get(issueKey(slug, kind)) ?? null;
}

/** True once a lookup has actually produced something to show. */
export function haveIssues() {
  return found.size > 0;
}

/**
 * Reads the repo's open issues and works out which entries they carry.
 *
 * @param {string} repo "owner/name"
 * @param {(name: string) => string|null} slugOfName resolves a display name, for
 *   issues that carry only the recorder's title and no JSON body
 * @returns {Promise<{ok: boolean, count: number, why?: string}>}
 */
export async function loadIssues(repo, slugOfName) {
  const cached = readCache(repo);
  if (cached) {
    found = index(cached, slugOfName);
    return { ok: true, count: found.size };
  }

  let raw;
  try {
    // `state=open` because a closed issue has been applied or rejected, and
    // either way it is no longer something to avoid duplicating.
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`,
      { headers: { accept: 'application/vnd.github+json' } });

    if (!res.ok) {
      return { ok: false, count: 0, why: res.status === 403
        ? 'GitHub is rate-limiting this address, so open issues are not shown.'
        : `GitHub answered ${res.status}, so open issues are not shown.` };
    }
    raw = await res.json();
  } catch {
    return { ok: false, count: 0, why: 'Could not reach GitHub, so open issues are not shown.' };
  }

  if (!Array.isArray(raw)) return { ok: false, count: 0, why: 'GitHub sent something unreadable.' };

  // The issues endpoint returns pull requests too, and only the body and title
  // are wanted — keeping the rest would put a few hundred KB of unrelated JSON
  // in sessionStorage for no reason.
  const slim = raw
    .filter((i) => i && !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: String(i.title ?? ''),
      body: String(i.body ?? ''),
      url: String(i.html_url ?? ''),
    }));

  writeCache(repo, slim);
  found = index(slim, slugOfName);
  return { ok: true, count: found.size };
}

/**
 * Which Tatari and reach each issue is about.
 *
 * Two readings, in order of how much they prove:
 *
 * 1. The JSON in the body, through the same parser the import dialog uses. An
 *    issue opened by the recorder carries the entry verbatim, so this is exact.
 * 2. Failing that, the recorder's own title format. Somebody who deleted the
 *    body but kept the generated subject still told us what they recorded.
 *
 * Anything else is left alone. A bug report that happens to mention Clucky is
 * not a range submission, and painting a card because a name appeared in some
 * sentence would make the mark mean nothing.
 */
function index(issues, slugOfName) {
  const map = new Map();
  const claim = (slug, kind, issue) => {
    const k = issueKey(slug, kind);
    // Oldest wins. The first person to send one in is the one whose issue a
    // second contributor would be duplicating.
    const held = map.get(k);
    if (!held || issue.number < held.number) {
      map.set(k, { number: issue.number, title: issue.title, url: issue.url });
    }
  };

  for (const issue of issues) {
    let any = false;
    try {
      for (const e of parseContribution(issue.body).entries) {
        claim(e.slug, e.kind, issue);
        any = true;
      }
    } catch { /* an unparseable body is just a body */ }
    if (any) continue;

    const m = TITLE.exec(issue.title);
    if (!m) continue;
    const slug = slugOfName(m[2]);
    if (slug) claim(slug, m[1].toLowerCase(), issue);
  }
  return map;
}

// ---------------------------------------------------------------- cache

function readCache(repo) {
  try {
    const held = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null');
    if (!held || held.repo !== repo || !Array.isArray(held.issues)) return null;
    return Date.now() - held.at < FRESH_FOR ? held.issues : null;
  } catch { return null; }
}

function writeCache(repo, issues) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ repo, at: Date.now(), issues }));
  } catch { /* private mode, or full — the lookup just repeats next reload */ }
}
