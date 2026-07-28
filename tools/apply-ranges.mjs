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
 *
 * Nothing is marked verified by default. Verified means a maintainer checked the
 * range against the game, and applying somebody else's reading is not that - it
 * is the same claim the contributor already made. Pass --verified only for ones
 * you have actually looked at.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const RANGES = 'data/ranges.json';
const EFFECTS = 'data/effect-ranges.json';
const KINDS = ['heal', 'buff', 'debuff'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
const source = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--by');

if (!source) {
  console.error('Usage: node tools/apply-ranges.mjs <entry.json|-> [--dry] [--verified] [--by "@who"]');
  process.exit(1);
}

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
const complaints = [];

function merge(book, incoming, where) {
  book.bySlug ??= {};
  for (const [slug, entry] of Object.entries(incoming)) {
    const bad = validate(slug, entry, where);
    if (bad.length) { complaints.push(...bad); continue; }

    const had = book.bySlug[slug];
    const next = { ...entry };
    if (flag('--verified')) next.verified = true;
    else delete next.verified;
    if (opt('--by')) next.by = opt('--by');

    book.bySlug[slug] = next;
    applied.push(`${had ? 'replaced' : 'added'}  ${where.padEnd(7)} ${slug}${
      entry.scope === 'all' ? '  (reaches everything)' : `  ${entry.tiles.length} tiles`}${
      had ? '' : ''}`);
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
console.log(`\n${applied.length} entr${applied.length === 1 ? 'y' : 'ies'}${
  flag('--verified') ? ', marked verified' : ', left unverified'}.`);

if (flag('--dry')) {
  console.log('\n--dry, so nothing was written.');
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
  return `${out}\n`;
}

if (blocks.attack) writeFileSync(RANGES, format(ranges));
if (blocks.effects) writeFileSync(EFFECTS, format(effects));
console.log(`\nWritten. Check the diff before committing — this trusts the numbers, not the reading.`);
