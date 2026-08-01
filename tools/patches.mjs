/**
 * Patch windows, from the repo into the database.
 *
 * `data/patches.json` is the authoring copy — reviewable, diffable, and the one
 * a fork inherits. `public.patches` is what `patch_at()` joins against when a
 * formation is posted. This walks the first into the second.
 *
 * Why a tool rather than a migration: a patch is not schema. The game changes
 * on its own schedule and the list grows for as long as anyone is playing, so
 * every entry would otherwise be a new numbered file whose only content is one
 * row. And a boundary read wrongly should be *correctable* — see --refile.
 *
 * Only `label`, `starts_at`, `note` and `source_url` are written. `ends_at` is
 * never sent: each window ends where the next begins, so the tool derives it
 * from the order rather than asking anyone to keep two boundaries agreeing.
 *
 * Needs the service_role key's connection string, because `public.patches` has
 * no insert policy at all — by design, so only this can write it:
 *
 *   SUPABASE_DB_URL=postgres://…   (in .env, never committed)
 *
 * Usage:
 *   node tools/patches.mjs --dry       say what would change, write nothing
 *   node tools/patches.mjs --apply     write it
 *   node tools/patches.mjs --refile    re-derive every formation's patch_id
 *
 * Running --apply twice changes nothing.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FILE = 'data/patches.json';

/* -------------------------------------------------------------- reading */

/**
 * The entries, checked hard enough that a typo fails here rather than at the
 * database's exclusion constraint, where the error names a GiST index and not
 * the line you got wrong.
 */
export function readPatches(text) {
  const book = JSON.parse(text);
  const list = Array.isArray(book?.patches) ? book.patches : [];

  const seen = new Set();
  const out = list.map((p, i) => {
    const where = `patches[${i}]`;
    const label = String(p?.label ?? '').trim();
    if (!label) throw new Error(`${where}: needs a label`);
    if (label.length > 24) throw new Error(`${where}: label is over 24 characters`);
    if (seen.has(label)) throw new Error(`${where}: duplicate label ${label}`);
    seen.add(label);

    const startsAt = Date.parse(p?.startsAt);
    if (!Number.isFinite(startsAt)) {
      throw new Error(`${where} (${label}): startsAt is not a date this can read`);
    }
    if (p?.endsAt !== undefined) {
      throw new Error(`${where} (${label}): endsAt is never written by hand — `
        + 'a window ends where the next one begins');
    }
    return {
      label,
      startsAt: new Date(startsAt).toISOString(),
      note: typeof p?.note === 'string' ? p.note.trim() : '',
      source: typeof p?.source === 'string' ? p.source.trim() : '',
    };
  });

  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  // Equal starts would produce two windows covering the same instant, which the
  // database refuses anyway — but it refuses it as a constraint violation on a
  // GiST index, and this says which two.
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].startsAt === out[i - 1].startsAt) {
      throw new Error(`${out[i - 1].label} and ${out[i].label} both start at `
        + `${out[i].startsAt}; a patch window cannot be empty`);
    }
  }

  /*
   * The readme in the JSON asks for a source on every entry, so that a
   * judgement about when the game changed can be checked rather than trusted.
   * A warning rather than an error: an unsourced patch is worth less than a
   * sourced one and still worth more than none at all.
   */
  for (const p of out) {
    if (!p.source) console.warn(`! ${p.label} has no source — the judgement cannot be checked`);
  }
  return out;
}

/** `ends_at` for each window: where the next one starts, and null for the last. */
export function withEnds(list) {
  return list.map((p, i) => ({ ...p, endsAt: list[i + 1]?.startsAt ?? null }));
}

/* -------------------------------------------------------------- writing */

const q = (v) => (v === null || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

/**
 * One statement, so a half-applied list is not a state this can end in.
 *
 * Upsert on `label` rather than delete-and-insert: formations reference
 * `patches(id)`, and recreating a row would either be refused by the foreign
 * key or, with `on delete set null`, quietly unfile every formation under it.
 *
 * `ends_at` is cleared on every row before the new values go in. Without that,
 * inserting a newer patch collides with the previous open-ended one on the
 * no-overlap constraint — the old row still claims everything to the end of
 * time until this statement has finished telling it otherwise.
 */
export function sqlFor(list) {
  const rows = withEnds(list).map((p) => `(${[
    q(p.label), q(p.startsAt), q(p.endsAt), q(p.note), q(p.source),
  ].join(', ')})`);

  if (!rows.length) return null;

  return `
begin;

-- Widen nothing and narrow everything: clearing the ends first means the
-- exclusion constraint is only ever asked about the final arrangement.
update public.patches set ends_at = starts_at;

insert into public.patches (label, starts_at, ends_at, note, source_url)
values
  ${rows.join(',\n  ')}
on conflict (label) do update set
  starts_at  = excluded.starts_at,
  ends_at    = excluded.ends_at,
  note       = excluded.note,
  source_url = excluded.source_url;

-- Anything in the table but not in the file is gone from the file on purpose.
delete from public.patches
 where label not in (${list.map((p) => q(p.label)).join(', ')});

commit;`;
}

/**
 * Re-files every formation under the window its own submitted_at falls in.
 *
 * The point of correcting a boundary. patch_id is set by a BEFORE INSERT
 * trigger, so moving a boundary changes nothing already posted until this runs
 * — and this is why the JSON readme can promise that a correction re-files
 * rather than loses anything.
 */
export const REFILE_SQL = `
update public.formations f
   set patch_id = public.patch_at(f.submitted_at)
 where f.patch_id is distinct from public.patch_at(f.submitted_at);`;

function run(sql) {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('SUPABASE_DB_URL is not set. It lives in .env, which is not committed.');
    process.exit(1);
  }
  const out = execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.stdout.write(out);
}

/* ---------------------------------------------------------------- main */

function main() {
  const args = new Set(process.argv.slice(2));
  const list = readPatches(readFileSync(FILE, 'utf8'));

  if (!list.length) {
    console.log('No patches in data/patches.json.');
    console.log('That is a coherent state: the gallery drops the patch filter and says');
    console.log('it is not tracking game updates, rather than inventing a label.');
    return;
  }

  for (const p of withEnds(list)) {
    console.log(`${p.label.padEnd(12)} ${p.startsAt} → ${p.endsAt ?? 'now'}`
      + `${p.source ? '' : '   (no source)'}`);
  }

  if (args.has('--refile')) { run(REFILE_SQL); console.log('Re-filed.'); return; }
  if (!args.has('--apply')) {
    console.log('\n--dry: nothing written. Re-run with --apply.');
    console.log(sqlFor(list));
    return;
  }
  run(sqlFor(list));
  run(REFILE_SQL);
  console.log('Applied, and every formation re-filed.');
}

// pathToFileURL, not string concatenation: a Windows path builds `file://E:/…`
// by hand and `file:///E:/…` correctly, so the hand-rolled version never
// matched and the tool exited silently having done nothing.
// argv[1] is undefined when this file is imported rather than run — from a
// test, or from `node -e` — and pathToFileURL(undefined) throws.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
