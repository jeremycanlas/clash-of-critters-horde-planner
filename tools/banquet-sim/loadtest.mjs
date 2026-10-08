// Simulated members on a throwaway Supabase project (set up by loadtest-setup.sh),
// through Supabase's real API, to see how many the banquet code holds.
//
//   node tools/banquet-sim/loadtest.mjs before 80 3     # mode, people, minutes
//
// Each person is one open tab, arriving at a random moment in the first minute
// (as at a reset):
//   before   the page as it was on 7 Oct: the whole list every 15 s
//   after    the page now: the whole list on opening, what changed every 10 s
// and both claim and mark now and then (about one person in 50 per round of
// asking). Every 30 s it prints how many requests there were, how many failed,
// and how long they took, with how busy the database's API connections were.
// Reads E:/caches/loadtest/project.json (url, anon key, db_url): never the live project.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const P = JSON.parse(readFileSync(process.env.LOADTEST_PROJECT ?? 'E:/caches/loadtest/project.json', 'utf8'));
if (P.url.includes('bjcumuhpblevbiqzzmli')) throw new Error('refusing: that is the live project');
const [mode = 'after', people = '80', minutes = '3'] = process.argv.slice(2);
const N = Number(people);
const END = Date.now() + Number(minutes) * 60_000;
const RAMP = 60_000;
const GROUPS = { 1: [20000001, 966], 2: [30000001, 1241], 4: [50000001, 1432] };

// Who: the 3 viewers, then members spread over the 1,200 (40% Group 1, 30% Group 2, rest MVPgoats).
const who = [2, 3, 1].slice(0, Math.min(3, N)).map((n) => ({ n, grp: null }));
for (let i = 0; who.length < N; i++) {
  const n = 4 + Math.floor((i * 1196) / Math.max(1, N - 3)) % 1196;
  who.push({ n, grp: n <= 483 ? 1 : n <= 843 ? 2 : 4 });
}

const log = []; // { at, fn, status, ms }
async function rpc(user, fn, body) {
  const t = Date.now();
  let status;
  try {
    const res = await fetch(`${P.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: P.anon, Authorization: `Bearer ${P.anon}`, 'Content-Type': 'application/json', 'x-sim-user': `sim${user.n}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    status = res.status;
    const text = await res.text(); // claims and marks answer 204, with no body
    const data = res.ok && text ? JSON.parse(text) : null;
    log.push({ at: Date.now(), fn, status, ms: Date.now() - t });
    return data;
  } catch (e) {
    log.push({ at: Date.now(), fn, status: e.name === 'TimeoutError' ? 'timeout' : 'error', ms: Date.now() - t });
    return null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab(user) {
  await sleep(Math.random() * RAMP);
  let hash = null;
  let since = null;
  const first = await rpc(user, 'banquet_state', {});
  hash = first?.hash ?? null;
  since = first?.since ?? null;
  const every = mode === 'before' ? 15_000 : 10_000;
  // After a failure the page now leaves about 20 s, 40 s, 80 s, up to 5 minutes (as before: every 10 s).
  let failures = mode === 'after' && !first ? 1 : 0;
  while (Date.now() < END) {
    await sleep(failures ? Math.min(300_000, 20_000 * 2 ** (failures - 1) * (0.75 + Math.random() / 2))
      : every * (0.9 + Math.random() * 0.2));
    if (Date.now() >= END) break;
    if (user.grp && Math.random() < 0.02) {
      const [base, n] = GROUPS[user.grp];
      const target = base + Math.floor(Math.random() * n);
      await rpc(user, 'banquet_claim', { target, claimed: true });
      await rpc(user, 'banquet_mark', { target, state: 'open' });
    }
    let a;
    if (mode === 'before' || !since) {
      a = await rpc(user, 'banquet_state', { known: hash });
      if (a?.hash) hash = a.hash;
    } else {
      a = await rpc(user, 'banquet_changes', { since });
    }
    if (a?.since) since = a.since;
    if (mode === 'after') failures = a ? 0 : failures + 1;
  }
}

// How busy the database's API connections are, every 15 s, straight from the database.
const busy = [];
const sample = () => execFile('psql', [P.db_url, '-At', '-c',
  "select count(*) filter (where application_name like 'PostgREST%' and state = 'active'), coalesce(round(max(extract(epoch from now() - query_start)) filter (where application_name like 'PostgREST%' and state = 'active')::numeric, 1), 0) from pg_stat_activity"],
{ timeout: 20_000 }, (err, out) => { busy.push(err ? 'no answer' : out.trim().replace('|', ' busy, slowest ') + 's'); });
const sampler = setInterval(sample, 15_000);

const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);
function report(from, to, label) {
  const w = log.filter((x) => x.at >= from && x.at < to);
  const ms = w.map((x) => x.ms).sort((a, b) => a - b);
  const bad = w.filter((x) => typeof x.status !== 'number' || x.status >= 500).length;
  const secs = (to - from) / 1000;
  console.log(`${label.padEnd(10)} ${String(w.length).padStart(6)} req  ${(w.length / secs).toFixed(1).padStart(6)}/s  `
    + `failed ${String(bad).padStart(5)} (${(w.length ? (100 * bad) / w.length : 0).toFixed(1).padStart(5)}%)  `
    + `median ${String(pct(ms, 50)).padStart(6)} ms  95% ${String(pct(ms, 95)).padStart(6)} ms  slowest ${String(ms.at(-1) ?? 0).padStart(6)} ms  `
    + `db ${busy.at(-1) ?? '-'}`);
}

console.log(`mode ${mode}, ${N} people, ${minutes} min (arriving over the first minute)`);
const start = Date.now();
let last = start;
const ticker = setInterval(() => { const now = Date.now(); report(last, now, `${Math.round((now - start) / 1000)}s`); last = now; }, 30_000);
await Promise.all(who.map(tab));
clearInterval(ticker);
clearInterval(sampler);
report(last, Date.now(), 'end');
report(start, Date.now(), 'TOTAL');
const statuses = {};
for (const x of log) statuses[`${x.fn} ${x.status}`] = (statuses[`${x.fn} ${x.status}`] ?? 0) + 1;
console.log('by call and result:', JSON.stringify(statuses));
