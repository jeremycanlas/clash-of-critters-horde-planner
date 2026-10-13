// The packed banquet list (049) against the plain one, card by card, on the
// load test project: a member and a viewer, the full list and what changed.
// Times are compared to the second, as packed ones are whole seconds.
//
//   node tools/banquet-sim/pack-check.mjs
//
// Reads E:/caches/loadtest/project.json: never the live project.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { unpack } from '../../assets/js/banquet-pack.js';

const P = JSON.parse(readFileSync(process.env.LOADTEST_PROJECT ?? 'E:/caches/loadtest/project.json', 'utf8'));
if (P.url.includes('bjcumuhpblevbiqzzmli')) throw new Error('refusing: that is the live project');

async function rpc(user, fn, body) {
  const res = await fetch(`${P.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: P.anon, Authorization: `Bearer ${P.anon}`, 'Content-Type': 'application/json', 'x-sim-user': user },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(res.ok, `${fn} ${res.status}: ${text.slice(0, 200)}`);
  return { data: text ? JSON.parse(text) : null, bytes: text.length };
}

// To the second, as the packed ones are; the page only ever reads them as dates.
const sec = (t) => (t == null ? t : new Date(Math.floor(Date.parse(t) / 1000) * 1000).toISOString());
const norm = (b) => ({
  ...b,
  posted: sec(b.posted),
  full_at: sec(b.full_at),
  ...Object.fromEntries(['open', 'not_yet', 'likes_before', 'likes_now'].map((k) => [k, b[k] && { ...b[k], at: sec(b[k].at) }])),
});
const byKey = (list) => new Map(list.map((b) => [`${b.grp ?? ''}:${b.uid}`, norm(b)]));

function same(plain, packed, what) {
  const a = byKey(plain);
  const b = byKey(packed);
  assert.equal(b.size, a.size, `${what}: ${b.size} packed cards, ${a.size} plain`);
  for (const [k, card] of a) assert.deepEqual(b.get(k), card, `${what}: card ${k}`);
}

for (const [who, label] of [['sim600', 'member'], ['sim1', 'viewer']]) {
  const plain = await rpc(who, 'banquet_state', {});
  const packedRaw = await rpc(who, 'banquet_state', { packed: true });
  const packed = unpack(packedRaw.data, 'banquets');
  assert.equal(packedRaw.data.banquets.length, 0, 'packed: the cards are only in `packed`');
  // The snapshot can be rebuilt between the two asks; the moved cards then sit in a second pack.
  same(plain.data.banquets, packed.banquets, `${label} full list`);
  console.log(`${label}: ${plain.data.banquets.length} cards, ${plain.bytes} bytes plain, ${packedRaw.bytes} packed`
    + ` (${(plain.bytes / packedRaw.bytes).toFixed(1)}x smaller)`);

  // What changed: claim one, then both forms of the answer, from just before.
  const since = new Date(Date.now() - 60_000).toISOString();
  const target = plain.data.banquets.find((b) => !b.claimed_by.length && !b.full);
  await rpc(who, 'banquet_claim', { target: Number(target.uid), claimed: true, ...(target.grp ? { g: target.grp } : {}) });
  const c1 = await rpc(who, 'banquet_changes', { since });
  const c2 = unpack((await rpc(who, 'banquet_changes', { since, packed: true })).data, 'cards');
  same(c1.data.cards, c2.cards, `${label} changes`);
  const mine = c2.cards.find((b) => b.uid === target.uid);
  assert.ok(mine?.claimed, `${label}: the claim shows as yours`);
  await rpc(who, 'banquet_claim', { target: Number(target.uid), claimed: false, ...(target.grp ? { g: target.grp } : {}) });
  console.log(`${label}: changes match (${c1.data.cards.length} cards)`);
}
console.log('pack-check: ok');
