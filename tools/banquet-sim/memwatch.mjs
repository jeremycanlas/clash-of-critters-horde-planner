// The load test project's memory while a load test runs: free memory, swap in
// use, and pages swapped in per 10 s. The free plan's server has about 400 MB
// for the database and the API together; the 13 Oct tests broke on swap, not
// on the database's own work.
//
//   node tools/banquet-sim/memwatch.mjs 240     # seconds to watch
//
// Reads E:/caches/loadtest/project.json (url, service): never the live project.
import { readFileSync } from 'node:fs';

const P = JSON.parse(readFileSync(process.env.LOADTEST_PROJECT ?? 'E:/caches/loadtest/project.json', 'utf8'));
if (P.url.includes('bjcumuhpblevbiqzzmli')) throw new Error('refusing: that is the live project');
const END = Date.now() + Number(process.argv[2] ?? 240) * 1000;
const auth = `Basic ${Buffer.from(`service_role:${P.service}`).toString('base64')}`;
const mb = (x) => `${Math.round(x / 1048576)}`.padStart(4);

let lastIn = null;
let last = null;
let worst = Infinity;
while (Date.now() < END) {
  try {
    const t = await (await fetch(`${P.url}/customer/v1/privileged/metrics`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(9000) })).text();
    const g = (n) => Number(t.split('\n').find((l) => l.startsWith(`${n}{`))?.split(' ').pop());
    const avail = g('node_memory_MemAvailable_bytes');
    const swapIn = g('node_vmstat_pswpin');
    worst = Math.min(worst, avail);
    // CPU time by mode across both cores, and disk writes, since the last sample.
    const sum = (re) => t.split('\n').filter((l) => re.test(l)).reduce((a, l) => a + Number(l.split(' ').pop()), 0);
    const now = { at: Date.now(), idle: sum(/^node_cpu_seconds_total\{.*mode="idle"/), iowait: sum(/^node_cpu_seconds_total\{.*mode="iowait"/),
      all: sum(/^node_cpu_seconds_total\{/), writes: sum(/^node_disk_writes_completed_total\{/) };
    const d = last && now.all > last.all ? now.all - last.all : 0;
    const cpu = d ? `cpu ${String(Math.round((100 * (d - (now.idle - last.idle) - (now.iowait - last.iowait))) / d)).padStart(3)}%  iowait ${String(Math.round((100 * (now.iowait - last.iowait)) / d)).padStart(3)}%  writes ${String(Math.round((now.writes - last.writes) / ((now.at - last.at) / 1000))).padStart(4)}/s` : '';
    if (!last || now.all !== last.all) last = now;
    console.log(`${new Date().toISOString().slice(11, 19)}  free ${mb(avail)} MB  swap used ${mb(g('node_memory_SwapTotal_bytes') - g('node_memory_SwapFree_bytes'))} MB`
      + `  swapped in ${lastIn === null ? '-' : String(swapIn - lastIn).padStart(7)} pages  ${cpu}`);
    lastIn = swapIn;
  } catch { console.log(`${new Date().toISOString().slice(11, 19)}  no answer`); }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log(`lowest free: ${mb(worst)} MB`);
