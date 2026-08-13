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
import { CELLS, ALL_CELLS, MODES } from './rules.js';

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

/** Lazily, because data.js fills this in after its fetch resolves. */
const zoboSlugs = () => state.zoboBySlug ?? new Map();

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

  /*
   * Zobos ride in the same list under player 0, which the grammar already
   * allows — a token is `<player>.<slug>@<cell>` and nothing ever said the
   * player had to be 1 or 2. They are written after both players so a reader
   * that stops at the players it knows still gets a whole formation.
   *
   * There is no `@-` half for them: a Zobo is either standing somewhere or it
   * is not part of the picture. Nobody benches an enemy.
   */
  for (const [cell, occ] of cells.entries()) {
    if (occ?.kind === 'zobo') tokens.push(`0.${occ.slug}@${cell}`);
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
  /*
   * Sandbox rides in the meta segment rather than beside the mode, because it is
   * not one: `sandbox/` where `solo/` goes would have to be spelled
   * `sandbox-coop/` to say the other half, and a reader older than this line
   * would fall back to solo and silently drop player 2.
   *
   * As a meta field it degrades the right way instead. An older build ignores
   * `sb=1` — every key it does not know is skipped — reads the mode it
   * understands, and rejects the cells past 35 on the bound it already has. It
   * draws the field half of a Sandbox formation, trimmed to its caps, which is
   * the most honest thing it could do with a board it cannot represent.
   */
  if (snap.sandbox) meta.push('sb=1');
  // The ground past the line, carried separately because it is a separate
  // question: a link can open the Zobo rows inside a legal 15, or lift the caps
  // without them, and both have to survive being pasted.
  if (snap.zoboGround) meta.push('zg=1');

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

  /*
   * Allocated at full size and bounded by what the link says, not by what this
   * reader would allow. A link without `sb=1` cannot contain a cell above 35 in
   * the first place — nothing writes one — so the narrower bound is enforced
   * where it belongs: reconcile() clears anything beyond the line whenever
   * Sandbox is off, including from a hand-edited link that put it there.
   */
  const cells = Array(ALL_CELLS).fill(null);
  const bench = { 1: [], 2: [] };
  const unknown = [];

  for (const token of layoutPart.split(',')) {
    const at = token.lastIndexOf('@');
    if (at === -1) continue;
    const dot = token.indexOf('.');
    /*
     * `|| 1` would be wrong now: 0 is a real player number here, the one that
     * means "a Zobo, owned by nobody". Only a genuinely unparseable prefix
     * defaults to player 1, which is what that fallback was ever for.
     */
    const parsed = Number(token.slice(0, dot));
    const player = Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
    const slug = token.slice(dot + 1, at);
    const where = token.slice(at + 1);
    if (!slug) continue;

    /*
     * Player 0 is a Zobo. Checked before the roster lookup, and before the bench
     * back-fill below — an enemy must never end up in somebody's 15, and a link
     * naming a Zobo this build has not heard of is a skipped token rather than
     * an unknown Tatari.
     */
    if (player === 0 || zoboSlugs().has(slug)) {
      if (!zoboSlugs().has(slug)) { unknown.push(slug); continue; }
      const at = Number(where);
      if (Number.isInteger(at) && at >= 0 && at < ALL_CELLS && !cells[at]) {
        cells[at] = { slug, player: 0, kind: 'zobo' };
      }
      continue;
    }

    if (!state.bySlug.has(slug)) { unknown.push(slug); continue; }
    if (!bench[player]) continue;
    if (!bench[player].includes(slug)) bench[player].push(slug);
    if (where === '-') continue;
    const cell = Number(where);
    if (!Number.isInteger(cell) || cell < 0 || cell >= ALL_CELLS || cells[cell]) continue;
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
  let sandbox = false;
  let zoboGround = false;
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
    else if (key === 'sb') sandbox = value === '1';
    else if (key === 'zg') zoboGround = value === '1';
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
    blob: { mode, sandbox, zoboGround, cells, bench, plan, name, lf, lfWants, lfMode, lines },
    unknown,
  };
}
