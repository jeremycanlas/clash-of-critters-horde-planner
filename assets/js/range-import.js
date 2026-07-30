/**
 * Reads back what the recorder writes.
 *
 * The recorder hands a contributor a JSON block and they open an issue with it;
 * tools/apply-ranges.mjs merges that block into the data files. Between those two
 * is the part that actually takes the time — reading somebody else's range and
 * deciding whether it is right — and that was being done by eye, against a file
 * of seven hundred lines of coordinates. Nobody can see a shape in that.
 *
 * So this parses the same text the merge tool accepts, and puts it back on the
 * grid it was drawn on. It accepts what arrives in practice: a whole issue body
 * pasted in, fences and bullet list and all; one or both of the recorder's
 * commented blocks; a bare object of slug to entry; or a whole data file.
 *
 * It reads only. Nothing here writes to the data files, and nothing is uploaded.
 */

const EFFECT_KINDS = ['heal', 'buff', 'debuff'];
const SOURCES = ['range diagram', 'in-game screenshot', 'in-game observation', 'other'];

/**
 * @typedef {object} Incoming
 * @property {string} slug
 * @property {'attack'|'heal'|'buff'|'debuff'} kind
 * @property {'tiles'|'all'} scope
 * @property {string[]} tiles   "dCol,dRow", the recorder's own key format
 * @property {string} note
 * @property {string} from
 */

/**
 * @param {string} text anything from a bare JSON object to a pasted issue
 * @returns {{entries: Incoming[], problems: string[]}}
 */
export function parseContribution(text) {
  const entries = [];
  const problems = [];

  if (!String(text || '').trim()) return { entries, problems: ['Nothing pasted.'] };

  let readAny = false;
  let broken = 0;
  for (const candidate of candidates(text)) {
    for (const block of blocksOf(candidate)) {
      const { objects, unreadable } = objectsIn(block.text);
      broken += unreadable;
      for (const obj of objects) {
        readAny = true;
        collect(obj, block.hint, entries, problems);
      }
    }
  }

  if (broken) {
    problems.push(`${broken === 1 ? 'A block' : `${broken} blocks`} in there could not be read as JSON — look for a missing bracket or a stray comma.`);
  }
  if (!readAny && !broken) {
    problems.push('No JSON was found in that. Paste the issue body, or the block the recorder gave you.');
  } else if (!entries.length && !problems.length) {
    problems.push('That parsed, but there was no range entry in it.');
  }

  // Last one wins, the way the merge tool applies them: a body that quotes the
  // same entry twice should import as one, not as one silently shadowing another.
  const byKey = new Map();
  for (const e of entries) byKey.set(`${e.kind}\n${e.slug}`, e);
  return { entries: [...byKey.values()], problems };
}

// ---------------------------------------------------------------- finding the JSON

/** Fenced code blocks if the text has any, otherwise the whole text. */
function candidates(text) {
  const fenced = [...text.matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  return fenced.length ? fenced : [text];
}

/**
 * Splits on the `// data/…` markers the recorder writes, keeping which file each
 * one names — the same split tools/apply-ranges.mjs does, so a body that works
 * there works here.
 */
function blocksOf(text) {
  const marks = [...text.matchAll(/^\s*\/\/\s*(data\/[\w.-]+)/gm)];
  if (!marks.length) return [{ hint: null, text }];

  return marks.map((m, i) => {
    // From the end of the marker's line: it carries a human-facing tail
    // ("→ bySlug") that is not JSON.
    const nl = text.indexOf('\n', m.index);
    const start = nl === -1 ? text.length : nl + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    return { hint: m[1].includes('effect') ? 'effects' : 'attack', text: text.slice(start, end) };
  });
}

/**
 * Every balanced top-level object in a chunk of prose.
 *
 * Reading the braces rather than parsing the whole string is what lets an
 * unedited issue body work: the summary lines above the block carry no braces
 * and fall away on their own. Counting them rather than slicing first-to-last
 * is what lets two blocks pasted one after another both arrive — and it can
 * tell a block that is not there from one that is there and broken, which is
 * the difference between "paste something else" and "check your commas".
 */
function objectsIn(text) {
  const body = text.replace(/^\s*\/\/.*$/gm, '');
  const objects = [];
  let unreadable = 0;

  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { if (depth++ === 0) start = i; continue; }
    if (c !== '}' || depth === 0) continue;

    if (--depth === 0) {
      try { objects.push(JSON.parse(body.slice(start, i + 1))); }
      catch { unreadable++; }
    }
  }
  // An object that opens and never closes is broken rather than absent.
  if (depth > 0) unreadable++;
  return { objects, unreadable };
}

// ---------------------------------------------------------------- reading it

function collect(obj, hint, out, problems) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;

  // effect-ranges.json, whole or in part: keyed by reach first, then by slug.
  let sawKind = false;
  for (const kind of EFFECT_KINDS) {
    if (!obj[kind] || typeof obj[kind] !== 'object') continue;
    sawKind = true;
    addBook(obj[kind], kind, out, problems);
  }
  if (sawKind) return;

  // ranges.json, whole or in part. A block introduced as effect data but with no
  // reach named cannot be filed, and guessing which of three it is would be
  // inventing the answer.
  if (hint === 'effects') {
    problems.push('A block for data/effect-ranges.json does not say whether it is a heal, a buff or a debuff.');
    return;
  }
  addBook(obj, 'attack', out, problems);
}

/**
 * A book is either `{bySlug, byLine}` — a data file or a slice of one — or the
 * bare slug-to-entry map the recorder writes. Both key on a slug, so both read
 * the same way.
 */
function addBook(book, kind, out, problems) {
  const keyed = [book.bySlug, book.byLine].filter((m) => m && typeof m === 'object');
  for (const map of keyed.length ? keyed : [book]) {
    for (const [slug, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (!Array.isArray(entry.tiles) && entry.scope !== 'all') continue;
      const read = readEntry(slug, kind, entry, problems);
      if (read) out.push(read);
    }
  }
}

function readEntry(slug, kind, entry, problems) {
  const where = `${slug} (${kind})`;
  const note = typeof entry.note === 'string' ? entry.note : '';
  const from = source(entry.from, where, problems);

  if (entry.scope === 'all') {
    if (entry.tiles?.length) {
      problems.push(`${where} says it reaches everything and also lists tiles. It can only be one, so it was left out.`);
      return null;
    }
    return { slug, kind, scope: 'all', tiles: [], note, from };
  }

  if (!Array.isArray(entry.tiles) || !entry.tiles.length) {
    problems.push(`${where} has no tiles and no scope, so it was left out.`);
    return null;
  }

  const tiles = [];
  for (const t of entry.tiles) {
    if (!Array.isArray(t) || t.length !== 2 || !t.every(Number.isInteger)) {
      problems.push(`${where} has a tile that is not a pair of whole numbers: ${JSON.stringify(t)}. It was left out.`);
      return null;
    }
    tiles.push(`${t[0]},${t[1]}`);
  }

  const unique = [...new Set(tiles)];
  if (unique.length !== tiles.length) {
    problems.push(`${where} lists the same tile more than once; the repeats were dropped.`);
  }
  return { slug, kind, scope: 'tiles', tiles: unique, note, from };
}

/**
 * The recorder offers four sources and the page can only show one of those back.
 * A hand-edited entry saying something else is kept as "other" rather than
 * silently blanked, and the swap is said out loud.
 */
function source(value, where, problems) {
  if (SOURCES.includes(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    problems.push(`${where} came from “${value}”, which is not one of the recorder's sources; it reads as “other” here.`);
  } else {
    problems.push(`${where} does not say where it came from.`);
  }
  return 'other';
}
