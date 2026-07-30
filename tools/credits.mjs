/**
 * The contributors list, built from the data rather than kept by hand.
 *
 * Every applied entry carries a `by` saying who read it (tools/apply-ranges.mjs
 * --by), so who has contributed what is already recorded — it was just recorded
 * somewhere nobody looks. A hand-maintained list is the kind that goes stale the
 * first busy week, and a contributor whose name quietly stopped appearing is
 * worse than one who was never listed.
 *
 * So the README block is generated from the data files and rewritten in place,
 * between the credits markers. Running it twice changes nothing.
 *
 * Usage:
 *   node tools/credits.mjs           rewrite the block in README.md
 *   node tools/credits.mjs --check   print it, write nothing
 */

import { readFileSync, writeFileSync } from 'node:fs';

const README = 'README.md';
const START = '<!-- credits:start -->';
const END = '<!-- credits:end -->';
const KINDS = ['attack', 'heal', 'buff', 'debuff'];

/**
 * Handles arrive as they are written, and they are not all from one place: the
 * changelog already thanks a @github handle and a u/reddit one. Each is linked
 * where it lives, and anything else is left as plain text rather than guessed at.
 */
function link(who) {
  const github = /^@([\w-]+)$/.exec(who);
  if (github) return `[@${github[1]}](https://github.com/${github[1]})`;
  const reddit = /^u\/([\w-]+)$/i.exec(who);
  if (reddit) return `[u/${reddit[1]}](https://reddit.com/u/${reddit[1]})`;
  return who;
}

/** Every entry in a book, whether it is keyed by slug or by evolution line. */
function* entriesOf(book) {
  for (const map of [book?.bySlug, book?.byLine]) {
    for (const [slug, entry] of Object.entries(map ?? {})) {
      if (entry && typeof entry === 'object') yield [slug, entry];
    }
  }
}

/**
 * Who recorded what, as `{who: {attack: n, heal: n, …, verified: n}}`.
 *
 * Counted per reach rather than totalled, because "read six attack ranges" and
 * "recorded the first heal reach anybody has" are different contributions and
 * flattening them to "7 entries" loses the one worth knowing about.
 */
export function tally(ranges, effects) {
  const by = new Map();

  const add = (entry, kind) => {
    const who = typeof entry.by === 'string' ? entry.by.trim() : '';
    if (!who) return;
    if (!by.has(who)) by.set(who, { verified: 0 });
    const row = by.get(who);
    row[kind] = (row[kind] ?? 0) + 1;
    if (entry.verified === true) row.verified++;
  };

  for (const [, entry] of entriesOf(ranges)) add(entry, 'attack');
  for (const kind of KINDS.slice(1)) {
    for (const [, entry] of entriesOf(effects?.[kind])) add(entry, kind);
  }
  return by;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function creditsBlock(ranges, effects) {
  const by = tally(ranges, effects);
  if (!by.size) {
    return 'Nothing has come in through the recorder yet. The first entry applied with\n'
      + '`tools/apply-ranges.mjs --by "@you"` puts its contributor here.';
  }

  const total = (row) => KINDS.reduce((n, k) => n + (row[k] ?? 0), 0);
  const rows = [...by.entries()].sort(
    ([aWho, a], [bWho, b]) => total(b) - total(a) || aWho.localeCompare(bWho));

  return rows.map(([who, row]) => {
    const parts = KINDS.filter((k) => row[k]).map((k) => plural(row[k], `${k} range`));
    // Worth saying out loud: an entry somebody checked against the game is a
    // different claim from one read off a diagram, and the data records which.
    const checked = row.verified ? ` (${row.verified} checked against the game)` : '';
    return `- ${link(who)} — ${parts.join(', ')}${checked}`;
  }).join('\n');
}

/**
 * Rewrites the block between the markers, leaving the rest of the README alone.
 * @returns {{text: string, changed: boolean, block: string}}
 */
export function updateCredits({ readme = README, write = true } = {}) {
  const ranges = JSON.parse(readFileSync('data/ranges.json', 'utf8'));
  const effects = JSON.parse(readFileSync('data/effect-ranges.json', 'utf8'));
  const block = creditsBlock(ranges, effects);

  const text = readFileSync(readme, 'utf8');
  const from = text.indexOf(START);
  const to = text.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${readme} has no ${START} … ${END} block to fill in.`);
  }

  const next = `${text.slice(0, from + START.length)}\n${block}\n${text.slice(to)}`;
  const changed = next !== text;
  if (write && changed) writeFileSync(readme, next);
  return { text: next, changed, block };
}

// ---------------------------------------------------------------- cli

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const check = process.argv.includes('--check');
  const { changed, block } = updateCredits({ write: !check });
  console.log(block);
  if (check) console.log(`\n--check, so ${README} was not touched.`);
  else console.log(`\n${changed ? `Rewrote the credits block in ${README}.` : `${README} was already up to date.`}`);
}
