/**
 * The share-link codec.
 *
 * `#v6=<mode>/<layout>;<plan>;<meta>` where layout is `player.slug@cell,...`,
 * plan is `player.slug+player.slug.level$note,...` in the order the level-ups
 * should be taken, and meta is `n=<name>~lf=<note>~w=<slug+slug>` — everything
 * about a formation that is not a placement. Benched but unplaced Tatari ride
 * along as `player.slug@-`, a step with no level writes `-`, and a step with no
 * note leaves off the `$` entirely.
 *
 * v4 links wrote one Tatari and no note per step, and v5 had no meta segment.
 * Both are contained by this grammar, so they are still read.
 *
 * Lifted out of store.js because it took its input from the live formation, and
 * the community gallery needs to write a link for a formation it is not editing
 * — a build somebody else posted. So `toFragment` takes a snapshot, and the one
 * in store.js is that call with `location.href` wrapped round it.
 *
 * The other half of the reason is what it lets the gallery avoid: opening a
 * community build is a plain navigation to `index.html#v6=…`, which the drafter
 * already knows how to read. No handoff, no shared storage, and no network code
 * anywhere in the drafter. The link is also pasteable, which a handoff is not.
 */

import { state } from './data.js';
import { CELLS, MODES } from './rules.js';

export const HASH_VERSION = 'v6';

/** Anything this codec can read, oldest first. */
const FRAGMENT = /(?:v6|v5|v4)=([^&]+)/;

/**
 * Notes are free text, and fromFragment() decodes the whole thing in one go
 * before splitting it. Encoding twice means that after that first pass a note
 * still holds none of the separators this grammar uses - `,` `+` `.` and `$`
 * all survive as escapes until the note itself is decoded.
 */
const encodeNote = (note) => encodeURIComponent(encodeURIComponent(note));

/** A hand-edited link can hold a stray `%`, which decodeURIComponent throws on. */
function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

const playersIn = (mode) => Array.from(
  { length: MODES[mode]?.players ?? 1 }, (_, i) => i + 1);

/**
 * The fragment for a snapshot, without the `#`. Empty when there is nothing to
 * carry, so a caller can clear the hash rather than write a link to nothing.
 * @param {object} snap a store.snapshot()
 */
export function toFragment(snap) {
  const cells = Array.isArray(snap?.cells) ? snap.cells : [];
  const mode = MODES[snap?.mode] ? snap.mode : 'solo';

  const tokens = [];
  for (const player of playersIn(mode)) {
    const placed = new Set();
    cells.forEach((occ, cell) => {
      if (!occ || occ.player !== player) return;
      placed.add(occ.slug);
      tokens.push(`${player}.${occ.slug}@${cell}`);
    });
    // Benched but never placed. Worth carrying: it is the other half of what a
    // player decided to bring.
    for (const slug of snap?.bench?.[player] ?? []) {
      if (!placed.has(slug)) tokens.push(`${player}.${slug}@-`);
    }
  }
  if (!tokens.length) return '';

  const plan = (Array.isArray(snap.plan) ? snap.plan : []).map((s) => {
    const body = `${(s.members ?? []).map((m) => `${m.player}.${m.slug}`).join('+')}.${s.level ?? '-'}`;
    return s.note ? `${body}$${encodeNote(s.note)}` : body;
  }).join(',');

  // `~` separates the meta fields rather than `&`, because the fragment is
  // matched up to the first `&` so other hash params can sit alongside it.
  const meta = [];
  const lf = snap.lines?.lf ?? { wants: [], note: '' };
  const have = snap.lines?.have ?? { wants: [], note: '' };
  if (snap.name?.trim()) meta.push(`n=${encodeNote(snap.name.trim())}`);
  if (lf.note?.trim()) meta.push(`lf=${encodeNote(lf.note.trim())}`);
  if (lf.wants?.length) meta.push(`w=${lf.wants.join('+')}`);
  if (have.note?.trim()) meta.push(`hn=${encodeNote(have.note.trim())}`);
  if (have.wants?.length) meta.push(`hw=${have.wants.join('+')}`);

  return `${HASH_VERSION}=${mode}/${tokens.join(',')};${plan};${meta.join('~')}`;
}

/**
 * Reads a fragment into the raw blob store.apply() takes.
 *
 * Unknown slugs are reported rather than swallowed - usually it means a link
 * was written by a copy of the tool carrying custom Tatari this one has not
 * heard of, and saying "skipped 3" is more use than quietly drawing 12.
 *
 * @param {string} hash the whole `location.hash`, or any string holding a fragment
 * @returns {{blob: object, unknown: string[]}|null} null when there is no formation in it
 */
export function fromFragment(hash) {
  const m = FRAGMENT.exec(String(hash ?? ''));
  if (!m) return null;

  const raw = safeDecode(m[1]);
  const slash = raw.indexOf('/');
  const mode = slash === -1 ? 'solo' : raw.slice(0, slash);
  const [layoutPart = '', planPart = '', metaPart = ''] = raw.slice(slash + 1).split(';');

  const cells = Array(CELLS).fill(null);
  const bench = { 1: [], 2: [] };
  const unknown = [];

  for (const token of layoutPart.split(',')) {
    const at = token.lastIndexOf('@');
    if (at === -1) continue;
    const dot = token.indexOf('.');
    const player = Number(token.slice(0, dot)) || 1;
    const slug = token.slice(dot + 1, at);
    const where = token.slice(at + 1);
    if (!slug) continue;
    if (!state.bySlug.has(slug)) { unknown.push(slug); continue; }
    if (!bench[player]) continue;
    if (!bench[player].includes(slug)) bench[player].push(slug);
    if (where === '-') continue;
    const cell = Number(where);
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS || cells[cell]) continue;
    cells[cell] = { slug, player };
  }

  const plan = [];
  for (const token of planPart.split(',')) {
    if (!token) continue;
    const [body, rawNote] = token.split('$');
    const dot = body.lastIndexOf('.');
    if (dot === -1) continue;
    const members = body.slice(0, dot).split('+').map((one) => {
      const at = one.indexOf('.');
      return at === -1 ? null : { player: Number(one.slice(0, at)) || 1, slug: one.slice(at + 1) };
    }).filter((one) => one?.slug);
    if (!members.length) continue;
    const level = body.slice(dot + 1);
    plan.push({
      members,
      level: level === '-' ? null : Number(level),
      note: rawNote ? safeDecode(rawNote) : '',
    });
  }

  // v4 and v5 links carry no meta segment, so these stay undefined and apply()
  // leaves whatever is already there alone.
  let name;
  let lf;
  let lfWants;
  let lfMode;
  let haveNote;
  let haveWants;
  for (const field of metaPart.split('~')) {
    const eq = field.indexOf('=');
    if (eq === -1) continue;
    const key = field.slice(0, eq);
    const value = field.slice(eq + 1);
    if (key === 'n') name = safeDecode(value);
    else if (key === 'lf') lf = safeDecode(value);
    else if (key === 'w') lfWants = value.split('+').filter(Boolean);
    else if (key === 'hn') haveNote = safeDecode(value);
    else if (key === 'hw') haveWants = value.split('+').filter(Boolean);
    // v6 links written before the two lines existed said which side they meant.
    else if (key === 'm') lfMode = value;
  }

  // A link from before the split carries one line plus the side it was on;
  // apply() folds that into the right half on its own.
  const lines = (haveNote !== undefined || haveWants !== undefined)
    ? {
      lf: { wants: lfWants ?? [], note: lf ?? '' },
      have: { wants: haveWants ?? [], note: haveNote ?? '' },
    }
    : undefined;

  return {
    blob: { mode, cells, bench, plan, name, lf, lfWants, lfMode, lines },
    unknown,
  };
}
