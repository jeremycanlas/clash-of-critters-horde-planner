/**
 * Applies a contributed range entry to the data files.
 *
 * The recorder hands a contributor JSON and they open an issue with it. This is
 * the other end: merging that JSON in, without hand-editing a 700-line file
 * where a stray comma or a duplicated key is easy to make and hard to see.
 *
 * Usage:
 *   node tools/apply-ranges.mjs entry.json
 *   pbpaste | node tools/apply-ranges.mjs -
 *   node tools/apply-ranges.mjs entry.json --dry
 *   node tools/apply-ranges.mjs entry.json --verified --by "@minhmax0r"
 *   node tools/apply-ranges.mjs entry.json --by "@minhmax0r" --issue 12
 *
 * Nothing is marked verified by default. Verified means a maintainer checked the
 * range against the game, and applying somebody else's reading is not that - it
 * is the same claim the contributor already made. Pass --verified only for ones
 * you have actually looked at.
 *
 * --by records who read it, which is where the README credits list comes from.
 * With a @handle it also writes a commit message carrying a Co-authored-by
 * trailer, so the commit that lands their reading carries their name and their
 * profile shows the contribution - the person who did the reading should be
 * visible in the repo, not just in a changelog line. Resolving the trailer asks
 * api.github.com for that account's public id (no token, nothing sent but the
 * handle); --email skips the lookup and --issue links the commit to their issue.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { updateCredits } from './credits.mjs';

const RANGES = 'data/ranges.json';
const EFFECTS = 'data/effect-ranges.json';
const ROSTER = 'data/tatari.json';
const MSG_FILE = '.git/RANGE_COMMIT_MSG';
const KINDS = ['heal', 'buff', 'debuff'];

const args = process.argv.slice(2);
/** The flags that swallow the word after them, so it is never the input file. */
const TAKES_VALUE = ['--by', '--issue', '--email'];
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
const source = args.find((a, i) => !a.startsWith('--') && !TAKES_VALUE.includes(args[i - 1]));

if (!source) {
  console.error('Usage: node tools/apply-ranges.mjs <entry.json|-> [--dry] [--verified]'
    + ' [--by "@who"] [--issue N] [--email addr]');
  process.exit(1);
}

/** Names, for the commit message and for catching a slug that is not a Tatari. */
const roster = (() => {
  try {
    const all = JSON.parse(readFileSync(ROSTER, 'utf8'));
    return new Map(all.map((t) => [t.slug, t.name]));
  } catch { return new Map(); }
})();

const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');

/**
 * Reads what the recorder produces: one or two JSON blocks, each introduced by
 * a comment naming the file it belongs in. A plain JSON file works too, and is
 * guessed by shape — an object whose values look like reaches is attack data.
 */
function parse(text) {
  const blocks = { attack: null, effects: null };
  const marks = [...text.matchAll(/^\/\/\s*(data\/[\w.-]+)/gm)];

  if (!marks.length) {
    const obj = JSON.parse(stripComments(text));
    const looksEffect = KINDS.some((k) => obj[k]?.bySlug);
    if (looksEffect) blocks.effects = obj;
    else blocks.attack = obj;
    return blocks;
  }

  marks.forEach((m, i) => {
    // From the end of the marker's line, not the end of the match: the line
    // carries a human-facing tail ("→ bySlug") that is not JSON.
    const nl = text.indexOf('\n', m.index);
    const start = nl === -1 ? text.length : nl + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const obj = JSON.parse(stripComments(text.slice(start, end)));
    if (m[1].includes('effect')) blocks.effects = obj;
    else blocks.attack = obj;
  });
  return blocks;
}

const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '').trim();

/** Sorted, so a diff shows what changed rather than everything moving. */
function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function validate(slug, entry, where) {
  const problems = [];
  if (entry.scope === 'all') {
    if (entry.tiles?.length) problems.push('has scope "all" and tiles; it can only be one');
  } else if (!Array.isArray(entry.tiles) || !entry.tiles.length) {
    problems.push('has no tiles and no scope');
  } else {
    for (const t of entry.tiles) {
      if (!Array.isArray(t) || t.length !== 2 || !t.every(Number.isInteger)) {
        problems.push(`has a tile that is not a pair of whole numbers: ${JSON.stringify(t)}`);
        break;
      }
    }
    const seen = new Set(entry.tiles.map(String));
    if (seen.size !== entry.tiles.length) problems.push('lists the same tile twice');
  }
  if (!entry.from) problems.push('does not say where it came from');
  return problems.map((p) => `  ${where} ${slug} ${p}`);
}

const applied = [];
/** The same, structured, for the commit message. */
const records = [];
const complaints = [];
const warnings = [];

function merge(book, incoming, where) {
  book.bySlug ??= {};
  for (const [slug, entry] of Object.entries(incoming)) {
    const bad = validate(slug, entry, where);
    if (bad.length) { complaints.push(...bad); continue; }

    // A slug nobody recognises is usually a typo, and it would sit in the file
    // reaching nothing. Not fatal, though: a Tatari can exist in the game before
    // the wiki scrape has it.
    if (roster.size && !roster.has(slug)) {
      warnings.push(`  ${where} ${slug} is not in ${ROSTER} — check the spelling`);
    }

    const had = book.bySlug[slug];
    const next = { ...entry };
    if (flag('--verified')) next.verified = true;
    else delete next.verified;
    if (opt('--by')) next.by = opt('--by');

    book.bySlug[slug] = next;
    applied.push(`${had ? 'replaced' : 'added'}  ${where.padEnd(7)} ${slug}${
      entry.scope === 'all' ? '  (reaches everything)' : `  ${entry.tiles.length} tiles`}${
      had ? '' : ''}`);
    records.push({
      slug,
      kind: where,
      replaced: Boolean(had),
      scope: entry.scope === 'all' ? 'all' : 'tiles',
      tiles: entry.tiles?.length ?? 0,
      from: entry.from,
    });
  }
  book.bySlug = sortKeys(book.bySlug);
}

const blocks = parse(raw);

const ranges = JSON.parse(readFileSync(RANGES, 'utf8'));
const effects = JSON.parse(readFileSync(EFFECTS, 'utf8'));

if (blocks.attack) merge(ranges, blocks.attack, 'attack');
if (blocks.effects) {
  for (const kind of KINDS) {
    if (blocks.effects[kind]?.bySlug) {
      effects[kind] ??= { bySlug: {}, byLine: {} };
      merge(effects[kind], blocks.effects[kind].bySlug, kind);
    }
  }
}

if (complaints.length) {
  console.error('Refused:');
  console.error(complaints.join('\n'));
  console.error('\nNothing was written.');
  process.exit(1);
}

if (!applied.length) {
  console.error('Nothing to apply — no entries found in that input.');
  process.exit(1);
}

console.log(applied.join('\n'));
if (warnings.length) console.log(`\nWorth a look:\n${warnings.join('\n')}`);
console.log(`\n${applied.length} entr${applied.length === 1 ? 'y' : 'ies'}${
  flag('--verified') ? ', marked verified' : ', left unverified'}.`);

// ---------------------------------------------------------------- credit

const nameOf = (slug) => roster.get(slug) ?? slug;

/** The recorder's four sources, said as a sentence rather than as a value. */
const SOURCE_SAYS = {
  'range diagram': "the wiki's range diagram",
  'in-game screenshot': 'an in-game screenshot',
  'in-game observation': 'watching it in a run',
  other: 'a source given in the note',
};

/**
 * The GitHub account behind a @handle, as the trailer git wants.
 *
 * Every account has a permanent noreply address built from its numeric id, and
 * that address is the one GitHub matches back to the profile - so a commit
 * carrying it shows their avatar and lands on their contribution graph. The id
 * comes from the public API, which needs no token.
 *
 * Only a @handle is looked up. A bare name could be anybody's login and
 * crediting the wrong stranger is worse than crediting nobody; a u/reddit name
 * has no GitHub account to point at at all.
 */
async function coAuthor(who) {
  if (!who) return { trailer: null };

  const login = /^@([\w-]+)$/.exec(who)?.[1];
  if (opt('--email')) {
    return { trailer: `Co-authored-by: ${login ?? who} <${opt('--email')}>` };
  }
  if (!login) {
    return { trailer: null, why: `${who} is not a GitHub @handle, so there is no account to co-author with. Pass --email to name one.` };
  }

  try {
    const res = await ask(`https://api.github.com/users/${encodeURIComponent(login)}`);
    if (res.status !== 200) {
      return { trailer: null, why: `GitHub answered ${res.status} for @${login}. Check the handle, or pass --email.` };
    }
    const user = JSON.parse(res.body);
    return { trailer: `Co-authored-by: ${user.login} <${user.id}+${user.login}@users.noreply.github.com>` };
  } catch (err) {
    return { trailer: null, why: `Could not reach api.github.com (${err.message}). Pass --email to skip the lookup.` };
  }
}

/**
 * One GET, no connection pool.
 *
 * fetch() would do, but it keeps its socket alive for reuse and this process
 * exits immediately afterwards — on Windows that combination trips an assertion
 * inside libuv and the tool dies after doing its work correctly, which is the
 * worst way for a tool to fail. `agent: false` closes the socket with the
 * response.
 */
function ask(url) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, {
      agent: false,
      timeout: 8000,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'clash-of-critters-horde-planner',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/**
 * The commit that lands these entries, written out rather than left to be typed.
 *
 * Somebody read a range off their own screen and sent it in; the least the
 * history can do is say so where it will still be legible in a year - in the
 * commit, next to the numbers, rather than in a changelog line that ages out.
 */
function commitMessage(trailer) {
  const who = opt('--by');
  const issue = opt('--issue')?.replace(/^#/, '');
  const kinds = [...new Set(records.map((r) => r.kind))];

  const subject = records.length === 1
    ? `Record ${nameOf(records[0].slug)}'s ${records[0].kind} range`
    : `Record ${records.length} ${kinds.length === 1 ? `${kinds[0]} ` : ''}ranges`;

  const lead = who
    ? `${who} read ${records.length === 1 ? 'this' : 'these'} off the game and sent ${
      records.length === 1 ? 'it' : 'them'} in${issue ? ` as #${issue}` : ''}, applied as ${
      records.length === 1 ? 'it' : 'they'} came.`
    : issue ? `From #${issue}, applied as it came.` : 'Applied from a contributed entry.';

  const list = records.map((r) => `- ${nameOf(r.slug)} (${r.slug}) — ${r.kind}, ${
    r.scope === 'all' ? 'reaches everything' : `${r.tiles} tiles`}${
    r.from ? `, from ${SOURCE_SAYS[r.from] ?? r.from}` : ''}${
    r.replaced ? ', replacing what was on file' : ''}`);

  const standing = flag('--verified')
    ? 'Checked against the game before applying.'
    : 'Left unverified: this is their reading, not a check of my own.';

  const trailers = [issue ? `Closes #${issue}` : '', trailer ?? ''].filter(Boolean);

  return [subject, '', lead, '', ...list, '', standing, ...(trailers.length ? ['', ...trailers] : [])]
    .join('\n').concat('\n');
}

const credit = await coAuthor(opt('--by'));
if (credit.why) console.log(`\nNo co-author trailer: ${credit.why}`);
const message = commitMessage(credit.trailer);
const indented = message.trimEnd().split('\n').map((l) => (l ? `    ${l}` : '')).join('\n');
console.log(`\nThe commit this wants:\n\n${indented}\n`);

if (flag('--dry')) {
  console.log('--dry, so nothing was written.');
  process.exit(0);
}

/**
 * Two-space indent, but each tiles array kept on one line — which is how the
 * files are already written, and the only way the diff of adding one entry is
 * one entry. Left to itself JSON.stringify puts every number on its own line
 * and applying a single range rewrites 1800 lines, which is unreviewable.
 *
 * Done by substitution rather than a regex over the output: tiles are nested
 * arrays, and matching their closing bracket in text is guesswork.
 */
function format(obj) {
  const held = new Map();
  let n = 0;
  const staged = JSON.parse(JSON.stringify(obj), (k, v) => {
    if (k !== 'tiles' || !Array.isArray(v)) return v;
    const token = `@@tiles${n++}@@`;
    held.set(token, `[${v.map(([c, r]) => `[${c}, ${r}]`).join(', ')}]`);
    return token;
  });

  let out = JSON.stringify(staged, null, 2);
  for (const [token, text] of held) out = out.replace(`"${token}"`, text);
  // A reach nobody has recorded yet is one line in the file and should stay one
  // line: applying a heal range otherwise rewrites the empty buff and debuff
  // books beside it, and the diff stops being about the entry that was added.
  out = out.replace(/\{\s*"bySlug": \{\},\s*"byLine": \{\}\s*\}/g, '{ "bySlug": {}, "byLine": {} }');
  return `${out}\n`;
}

if (blocks.attack) writeFileSync(RANGES, format(ranges));
if (blocks.effects) writeFileSync(EFFECTS, format(effects));

// The credits list is generated from the `by` fields, so it is rewritten here
// rather than remembered later. Nobody has ever remembered later.
//
// The data is already on disk by this point, so a README that cannot be
// rewritten is a note to the user, not a crash: dying here would report failure
// for work that succeeded, and the next run would apply it all a second time.
try {
  if (updateCredits().changed) console.log('\nREADME credits list updated.');
} catch (err) {
  console.log(`\nCredits list not updated: ${err.message}`);
}

/*
 * Inside .git so it is never something you have to remember not to commit, and
 * as a file rather than as text to copy because a multi-line message with an
 * email in it does not survive being pasted through a shell.
 */
const inRepo = existsSync('.git') && statSync('.git').isDirectory();
if (inRepo) writeFileSync(MSG_FILE, message);

console.log('\nWritten. Check the diff before committing — this trusts the numbers, not the reading.');
if (inRepo) console.log(`\n    git commit -a -F ${MSG_FILE}`);
