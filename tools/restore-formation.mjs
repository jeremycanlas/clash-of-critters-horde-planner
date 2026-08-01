/**
 * Putting a deleted formation back.
 *
 * 005 made Delete a soft delete: the row stops being readable, keeps its votes,
 * and is erased by `purge_deleted_formations()` after thirty days. Between
 * those two moments it can be brought back, and this is what brings it back.
 *
 * Deliberately a tool and not a feature. A "recently deleted" list in the
 * gallery is real interface — empty states, a second confirmation, a policy
 * letting somebody read rows the whole point of which is being unreadable — for
 * something that will happen a handful of times a year. This costs one file and
 * covers it until it doesn't.
 *
 * It runs on SUPABASE_DB_URL, which is the service connection, so it can see
 * and restore anybody's formation rather than only your own. That is the point:
 * the person asking for a formation back is usually not the person with a psql
 * prompt.
 *
 * Usage:
 *   node tools/restore-formation.mjs                 what can be restored
 *   node tools/restore-formation.mjs <id>            restore it
 *   node tools/restore-formation.mjs <id> --dry      say what would happen
 *
 * <id> may be any unambiguous leading chunk of the uuid — the first eight
 * characters are shown in the listing for exactly that reason.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The window from 005, so the days-left column and the purge agree. */
const KEEP_DAYS = 30;

function psql(sql) {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('SUPABASE_DB_URL is not set. It lives in .env, which is not committed.');
    process.exit(1);
  }
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function rows(out) {
  return out.split('\n').filter(Boolean).map((line) => line.split('\t'));
}

/**
 * Hex and dashes only, checked rather than escaped.
 *
 * This is the one value here that comes from a person's shell, and it is
 * interpolated into SQL. A uuid has no legal character that needs quoting, so
 * the honest defence is to refuse anything that is not one rather than to trust
 * an escaping routine nobody will re-read.
 */
function safeId(raw) {
  const id = String(raw ?? '').trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(id)) {
    console.error(`"${raw}" is not a formation id or the start of one.`);
    process.exit(1);
  }
  return id;
}

/* ----------------------------------------------------------------- listing */

const LIST_SQL = `
  select f.id,
         f.name,
         coalesce(nullif(f.author_name, ''), 'someone'),
         to_char(f.deleted_at, 'YYYY-MM-DD'),
         greatest(0, ${KEEP_DAYS} - floor(extract(epoch from now() - f.deleted_at) / 86400))::int,
         f.placed,
         f.score,
         coalesce((select count(*) from public.votes v where v.formation_id = f.id), 0)
    from public.formations f
   where f.deleted_at is not null
   order by f.deleted_at desc;`;

function list() {
  const found = rows(psql(LIST_SQL));
  if (!found.length) {
    console.log('Nothing is waiting to be restored.');
    console.log('Deleted formations appear here for 30 days, then the purge takes them.');
    return found;
  }

  console.log(`${found.length} deleted formation${found.length === 1 ? '' : 's'}:\n`);
  for (const [id, name, who, when, left, placed, score, votes] of found) {
    const urgency = Number(left) === 0 ? 'PAST ITS 30 DAYS — the next purge takes it'
      : `${left} day${Number(left) === 1 ? '' : 's'} left`;
    console.log(`  ${id.slice(0, 8)}  ${name}`);
    console.log(`            by ${who} · deleted ${when} · ${urgency}`);
    console.log(`            ${placed} placed · score ${score} · ${votes} vote${Number(votes) === 1 ? '' : 's'} held\n`);
  }
  console.log('Restore one with:  node tools/restore-formation.mjs <id>');
  return found;
}

/* --------------------------------------------------------------- restoring */

/**
 * What the row looks like now, and whether putting it back would be refused.
 *
 * The collision is the whole reason this does a lookup first. 005 scoped
 * `formations_one_per_author` to `where deleted_at is null`, so that deleting a
 * formation and posting the same board again would work — which means the board
 * may well have been posted again in the meantime. Restoring the old row then
 * puts two live rows with one (author_id, fingerprint) into a unique index, and
 * Postgres refuses it with a constraint name and nothing a person can act on.
 */
function inspect(id) {
  const sql = `
    select f.id,
           f.name,
           (f.deleted_at is not null)::text,
           coalesce(other.id::text, ''),
           coalesce(other.name, '')
      from public.formations f
      left join public.formations other
        on other.author_id  = f.author_id
       and other.fingerprint = f.fingerprint
       and other.deleted_at is null
       and other.id <> f.id
     where f.id::text like '${id}%';`;

  const found = rows(psql(sql));
  if (!found.length) {
    console.error(`No formation starts with ${id}.`);
    console.error('It may already have been purged — 30 days is the whole window.');
    process.exit(1);
  }
  if (found.length > 1) {
    console.error(`${id} matches ${found.length} formations. Use more of the id:`);
    for (const [rid, name] of found) console.error(`  ${rid}  ${name}`);
    process.exit(1);
  }
  return found[0];
}

function restore(id, { dry = false } = {}) {
  const [rid, name, isDeleted, blockerId, blockerName] = inspect(id);

  if (isDeleted !== 'true') {
    console.log(`"${name}" is not deleted. Nothing to do.`);
    return;
  }

  if (blockerId) {
    console.error(`Cannot restore "${name}": its author has since posted the same board again`);
    console.error(`as "${blockerName}" (${blockerId.slice(0, 8)}).`);
    console.error('');
    console.error('One person cannot hold two live copies of one board — that constraint is');
    console.error('why reposting worked at all while this one was deleted. Delete the newer');
    console.error('one first if the older is the one that should survive.');
    process.exit(1);
  }

  if (dry) {
    console.log(`Would restore "${name}" (${rid.slice(0, 8)}), votes and all. Nothing written.`);
    return;
  }

  psql(`update public.formations set deleted_at = null where id = '${rid}';`);
  console.log(`Restored "${name}".`);
  console.log('It is back in the gallery with its score, at the position its votes earn it.');
}

/* -------------------------------------------------------------------- main */

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry');
  const target = argv.find((a) => !a.startsWith('--'));

  if (!target) { list(); return; }
  restore(safeId(target), { dry });
}

// argv[1] is undefined when this file is imported rather than run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { LIST_SQL, safeId };
