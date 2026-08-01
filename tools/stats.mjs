/**
 * The usage numbers in the README, read from GoatCounter rather than retyped.
 *
 * The README leads with how many people use this and how many of them get as far
 * as building a formation. Those are the most persuasive lines in the file and
 * the first ones to rot: they were last correct on the day somebody opened the
 * dashboard and typed them in. A number presented as current and quietly two
 * months old is worse than no number, because a reader has no way to tell.
 *
 * So the same trick tools/credits.mjs uses: generate the block, rewrite it in
 * place between markers, leave everything else alone. Running it twice changes
 * nothing.
 *
 * Nothing here reads a formation. GoatCounter only ever received page paths and
 * the fixed labels in assets/js/analytics.js, so that is the whole universe of
 * what can come back, and the privacy promise in the README stays true.
 *
 * Usage:
 *   node tools/stats.mjs             rewrite the blocks in README.md
 *   node tools/stats.mjs --check     print them, write nothing
 *   node tools/stats.mjs --probe     dump what the API returned, write nothing
 *   node tools/stats.mjs --since 2025-01-01   count from a date (default: all)
 *
 * Needs GOATCOUNTER_TOKEN in the environment or in .env, which is gitignored.
 * Make one at jacc.goatcounter.com under [your name] -> API, with "read
 * statistics" permission. It is a read-only credential for a dashboard that
 * holds no personal data, but it is still a credential: it does not go in the
 * repo, and CI reads it from a repository secret.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const README = 'README.md';
const SITE = process.env.GOATCOUNTER_SITE || 'jacc';

/**
 * Two regions, not one. The lede is a sentence and the usage block is a table
 * plus a paragraph, and they sit in different sections with static prose in
 * between that this tool has no business rewriting.
 */
const REGIONS = {
  lede: ['<!-- stats-lede:start -->', '<!-- stats-lede:end -->'],
  usage: ['<!-- stats-usage:start -->', '<!-- stats-usage:end -->'],
};

/**
 * The labels assets/js/analytics.js sends, and what each one is called in the
 * README. Anything the API returns that is not named here is ignored rather than
 * guessed at, so adding a track() call does not silently change the funnel.
 */
const FUNNEL = [
  { label: 'used', say: 'Built a formation', ofArrivals: true },
  { label: 'formation-saved', say: 'Saved a formation in the browser' },
  { label: 'save-kept', say: 'Exported a `.json`' },
  { label: 'card-downloaded', say: 'Downloaded a share card' },
];

/**
 * Referrer hosts collapse to the place a reader would recognise. GoatCounter
 * reports them as it finds them, so Reddit alone arrives as several hosts
 * (`reddit.com`, `out.reddit.com`, `m.reddit.com`) and counting them separately
 * would understate the channel that actually brings people here.
 */
const CHANNELS = [
  { say: 'a Google search', match: /(^|\.)google\./i },
  { say: 'Reddit', match: /(^|\.)reddit\.com$/i },
  { say: 'YouTube', match: /(^|\.)(youtube\.com|youtu\.be)$/i },
  { say: 'Discord', match: /(^|\.)discord(app)?\.com$/i },
];

// ---------------------------------------------------------------- transport

/** .env is gitignored and holds the token locally; CI passes it as an env var. */
function envFile(name) {
  if (process.env[name]) return process.env[name];
  if (!existsSync('.env')) return '';
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

async function api(path, token, params = {}) {
  const url = new URL(`https://${SITE}.goatcounter.com/api/v0/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    // The status is the whole diagnosis here, so it is said plainly rather than
    // wrapped in a stack trace. 401 is by far the likeliest and means the token,
    // not the code.
    const why = res.status === 401 || res.status === 403
      ? 'the token was refused - check it has "read statistics" permission'
      : `the API answered ${res.status}`;
    throw new Error(`GET ${path}: ${why}`);
  }
  return res.json();
}

/**
 * Everything the README needs, in four calls.
 *
 * `stats/hits` carries both pages and events in one list, told apart by the
 * `event` flag, so the funnel and the pageview count come from the same request
 * and cannot disagree with each other.
 */
export async function fetchStats(token, { since = '' } = {}) {
  const range = { start: since };
  const [total, hits, refs, systems] = await Promise.all([
    api('stats/total', token, range),
    api('stats/hits', token, { ...range, limit: 200 }),
    api('stats/toprefs', token, { ...range, limit: 50 }),
    api('stats/systems', token, { ...range, limit: 50 }),
  ]);
  return { total, hits, refs, systems, since };
}

// ---------------------------------------------------------------- shaping

const sum = (rows) => rows.reduce((n, r) => n + (r.count ?? 0), 0);
const commas = (n) => n.toLocaleString('en-GB');
const pct = (n, of) => (of > 0 ? Math.round((n / of) * 100) : 0);

/**
 * The README is hand-wrapped at 78 columns and a generated paragraph that runs
 * to 200 makes the diff of every future edit unreadable. Table rows are left
 * alone: a wrapped row is not a table any more.
 */
function wrap(text, width = 78) {
  return text.split('\n').map((line) => {
    if (line.startsWith('|') || line.length <= width) return line;
    const out = [];
    let row = '';
    for (const word of line.split(' ')) {
      if (row && `${row} ${word}`.length > width) { out.push(row); row = word; }
      else row = row ? `${row} ${word}` : word;
    }
    if (row) out.push(row);
    return out.join('\n');
  }).join('\n');
}

/**
 * Turns the four payloads into the handful of numbers the README prints.
 *
 * Kept separate from both the fetching and the formatting so the arithmetic can
 * be read on its own, and so a shape that comes back differently from the live
 * API is one function to correct rather than a rewrite.
 */
export function shape({ total, hits, refs, systems }) {
  const rows = hits?.hits ?? [];
  const pages = rows.filter((r) => !r.event);
  const events = rows.filter((r) => r.event);

  const countOf = (label) =>
    sum(events.filter((r) => (r.path ?? '').replace(/^\//, '') === label));

  const visits = total?.total ?? sum(rows);
  const pageviews = sum(pages);

  const funnel = FUNNEL.map((f) => ({ ...f, count: countOf(f.label) }))
    .filter((f) => f.count > 0);

  // Referrers are a share of the referred, not of everyone: GoatCounter does not
  // report direct arrivals as a referrer, so dividing by total visits would
  // silently shrink every channel by however much direct traffic there is.
  const refRows = refs?.stats ?? [];
  const referred = sum(refRows);
  const channels = CHANNELS.map((c) => ({
    say: c.say,
    count: sum(refRows.filter((r) => c.match.test(String(r.name ?? '')))),
  })).filter((c) => c.count > 0).sort((a, b) => b.count - a.count);

  const sysRows = systems?.stats ?? [];
  const known = sum(sysRows);
  const phone = sum(sysRows.filter((r) => /^(ios|android)$/i.test(String(r.name ?? ''))));
  const ios = sum(sysRows.filter((r) => /^ios$/i.test(String(r.name ?? ''))));

  return {
    visits,
    pageviews,
    funnel,
    channels: channels.map((c) => ({ ...c, pct: pct(c.count, referred) })),
    referred,
    phonePct: pct(phone, known),
    iosOfPhonePct: pct(ios, phone),
    known,
  };
}

// ---------------------------------------------------------------- blocks

/** The opening sentence. The one number most readers will ever look at. */
export function ledeBlock(s) {
  const built = s.funnel.find((f) => f.ofArrivals);
  const tail = built
    ? `, and ${commas(built.count)} of those people actually built a formation.`
    : '.';
  return wrap('A planning tool for Clash of Critters\' Horde Invasion mode. '
    + `${commas(s.visits)} visits so far${tail}`);
}

/**
 * The table and the channel mix.
 *
 * Percentages are printed beside their raw count rather than instead of it, so a
 * reader can see the denominator and judge the number themselves. "46% of
 * arrivals" alone invites a confidence that 651 out of 1,412 does not support.
 */
export function usageBlock(s) {
  const lines = ['| | |', '| --- | --- |', `| Visits | ${commas(s.visits)} |`];
  for (const f of s.funnel) {
    // Against pageviews, not total visits. "Arrivals" means people who loaded a
    // page; the visits figure also counts events, so dividing by it would
    // understate activation by however busy the buttons were.
    const share = f.ofArrivals ? ` (${pct(f.count, s.pageviews)}% of arrivals)` : '';
    lines.push(`| ${f.say} | ${commas(f.count)}${share} |`);
  }

  const out = [lines.join('\n')];

  if (s.channels.length) {
    const parts = s.channels.map((c, i) =>
      (i === 0 ? `${c.pct}% come from ${c.say}` : `${c.pct}% from ${c.say}`));
    const last = parts.pop();
    const list = parts.length ? `${parts.join(', ')} and ${last}` : last;
    out.push(wrap(`Of the visits that carry a referrer, ${list}. The rest arrive direct.`));
  }

  if (s.known > 0) {
    out.push(wrap(`About ${s.phonePct}% are on a phone, and iOS is roughly `
      + `${s.iosOfPhonePct}% of those.`));
  }

  // Blank line between each, because these are paragraphs rather than a list and
  // Markdown would otherwise run them together.
  return out.join('\n\n');
}

// ---------------------------------------------------------------- writing

function replaceRegion(text, [start, end], block, readme) {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${readme} has no ${start} ... ${end} block to fill in.`);
  }
  return `${text.slice(0, from + start.length)}\n${block}\n${text.slice(to)}`;
}

/**
 * Rewrites both regions, leaving the rest of the README alone.
 * @returns {{changed: boolean, blocks: {lede: string, usage: string}}}
 */
export function updateReadme(stats, { readme = README, write = true } = {}) {
  const blocks = { lede: ledeBlock(stats), usage: usageBlock(stats) };

  const text = readFileSync(readme, 'utf8');
  let next = replaceRegion(text, REGIONS.lede, blocks.lede, readme);
  next = replaceRegion(next, REGIONS.usage, blocks.usage, readme);

  const changed = next !== text;
  if (write && changed) writeFileSync(readme, next);
  return { changed, blocks };
}

// ---------------------------------------------------------------- cli

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const probe = argv.includes('--probe');
  const sinceAt = argv.indexOf('--since');
  const since = sinceAt === -1 ? '' : (argv[sinceAt + 1] ?? '');

  const token = envFile('GOATCOUNTER_TOKEN');
  if (!token) {
    console.error('No GOATCOUNTER_TOKEN in the environment or .env.\n'
      + `Make one at https://${SITE}.goatcounter.com/user/api with "read `
      + 'statistics" permission, then put it in .env as:\n'
      + '  GOATCOUNTER_TOKEN=...');
    process.exit(1);
  }

  const raw = await fetchStats(token, { since });

  if (probe) {
    // The first real run is the only chance to check that these payloads mean
    // what this file assumes. Printed rather than asserted, because a wrong
    // assumption should be visible rather than throw.
    console.log(JSON.stringify({
      total: raw.total,
      hits: (raw.hits?.hits ?? []).map(({ path, title, count, event }) =>
        ({ path, title, count, event })),
      refs: raw.refs?.stats ?? [],
      systems: raw.systems?.stats ?? [],
    }, null, 2));
    console.log('\n--probe, so README.md was not touched.');
    process.exit(0);
  }

  const stats = shape(raw);
  const { changed, blocks } = updateReadme(stats, { write: !check });

  console.log(blocks.lede);
  console.log();
  console.log(blocks.usage);

  if (check) console.log(`\n--check, so ${README} was not touched.`);
  else console.log(`\n${changed ? `Rewrote the stats blocks in ${README}.` : `${README} was already up to date.`}`);
}
