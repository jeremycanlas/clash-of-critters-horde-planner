// Is the banquet tracker answering? Posts to Discord when it is not.
//
//   node tools/health-check.mjs        (DISCORD_ALERT_WEBHOOK set to post; unset, it only prints)
//
// Run every 10 minutes by .github/workflows/health.yml. On 7 Oct the tracker
// was down for hours at the reset and the first anyone heard was members
// complaining; this is meant to say so first.
//
// Three probes, from GitHub's network, needing no sign-in:
//   database  a call only a signed-in user may make, sent signed out. The
//             database itself refuses it (401), so a quick 401 means it is up
//             and answering; anything else, or slow, means it is not.
//   sign-in   Supabase's sign-in service health check.
//   site      the banquet page from GitHub Pages.
// The database is asked three times, 20 s apart, so one slow moment is not an alarm.

const SUPABASE = 'https://bjcumuhpblevbiqzzmli.supabase.co';
const KEY = 'sb_publishable_oT6efCRk05pz6vICkJUjAA_QKbtp902'; // the public key the site ships
const SITE = 'https://jeremycanlas.github.io/clash-of-critters-horde-planner/banquet.html';
const SLOW_MS = 5000;

async function probe(url, init = {}) {
  const t = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    return { status: res.status, ms: Date.now() - t };
  } catch (e) {
    return { status: e.name === 'TimeoutError' ? 'timeout' : 'no answer', ms: Date.now() - t };
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const db = [];
for (let i = 0; i < 3; i++) {
  if (i) await wait(20000);
  db.push(await probe(`${SUPABASE}/rest/v1/rpc/banquet_check`, { method: 'POST', headers, body: '{}' }));
}
const auth = await probe(`${SUPABASE}/auth/v1/health`, { headers: { apikey: KEY } });
const site = await probe(SITE);

const badDb = db.filter((x) => x.status !== 401 || x.ms > SLOW_MS);
const problems = [];
if (badDb.length >= 2) problems.push(`**Database** not answering properly: ${db.map((x) => `${x.status} in ${(x.ms / 1000).toFixed(1)} s`).join(', ')}`);
if (auth.status !== 200 || auth.ms > SLOW_MS) problems.push(`**Sign-in** service: ${auth.status} in ${(auth.ms / 1000).toFixed(1)} s`);
if (site.status !== 200) problems.push(`**Site** (GitHub Pages): ${site.status} in ${(site.ms / 1000).toFixed(1)} s`);

const line = `database ${db.map((x) => `${x.status}/${x.ms}ms`).join(' ')} | sign-in ${auth.status}/${auth.ms}ms | site ${site.status}/${site.ms}ms`;
console.log(problems.length ? `PROBLEM: ${line}` : `ok: ${line}`);

if (problems.length && process.env.DISCORD_ALERT_WEBHOOK) {
  const res = await fetch(process.env.DISCORD_ALERT_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `⚠️ **MVP banquet tracker health check**\n${problems.map((p) => `- ${p}`).join('\n')}\n`
        + `Checked ${new Date().toISOString().slice(11, 16)} UTC. If it keeps failing: Supabase dashboard → Reports → CPU, then Restart project.`,
      allowed_mentions: { parse: [] },
    }),
  });
  console.log(`posted to Discord: ${res.status}`);
}
