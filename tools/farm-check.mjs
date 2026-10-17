// Checks the Cozy Farm sums against data/farm.json.  node tools/farm-check.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScore, earned, nextTier, gain } from '../assets/js/farm-math.js';

const farm = JSON.parse(readFileSync(new URL('../data/farm.json', import.meta.url)));
const zobo = JSON.parse(readFileSync(new URL('../data/zobo.json', import.meta.url)));

// Zobo Shooter runs on the same sums: past 100,000K, one glitter fruit per 1,000K.
assert.equal(zobo.tiers.length, 70);
assert.ok(zobo.tiers.every(([at], i) => i === 0 || at > zobo.tiers[i - 1][0]), 'zobo tiers ascending');
for (const [, prizes] of zobo.tiers) for (const k of Object.keys(prizes)) assert.ok(zobo.items[k], k);
assert.deepEqual(earned(zobo, 47556000).wishbox, 5 + 5 + 3 + 2, 'wishboxes by 47,556K: 36M, 24M, 8M, 2.8M');
assert.deepEqual(nextTier(zobo, 47556000), { at: 52000000, prizes: { pinball: 180, candy: 3102000, 'scan-capsule': 100 } });
assert.equal(earned(zobo, 100000000)['glitter-fruit'], undefined);
assert.equal(earned(zobo, 100999999)['glitter-fruit'], undefined, 'whole steps only');
assert.equal(earned(zobo, 101000000)['glitter-fruit'], 1);
assert.equal(earned(zobo, 105500000)['glitter-fruit'], 5);
assert.deepEqual(nextTier(zobo, 100000000), { at: 101000000, prizes: { 'glitter-fruit': 1 } });
assert.equal(earned(zobo, 1e9).pinball, earned(zobo, 100000000).pinball, 'nothing else past the list');

assert.equal(farm.tiers.length, 100);
assert.ok(farm.tiers.every(([at], i) => i === 0 || at > farm.tiers[i - 1][0]), 'tiers ascending');
for (const [, prizes] of farm.tiers) for (const k of Object.keys(prizes)) assert.ok(farm.items[k], k);

assert.equal(parseScore('354'), 354);
assert.equal(parseScore('45k'), 45000);
assert.equal(parseScore('1.2M'), 1200000);
assert.equal(parseScore('1,450,000'), 1450000);
assert.equal(parseScore('abc'), null);

assert.deepEqual(earned(farm, 0), {});
assert.deepEqual(earned(farm, 354), { pinball: 60, candy: 246000 });
assert.deepEqual(earned(farm, 2000), { pinball: 60, candy: 492000, capsule: 3 });
assert.deepEqual(nextTier(farm, 354), { at: 2000, prizes: { candy: 246000, capsule: 3 } });

// Past the last tier: one glitter fruit per 30K, whole steps only.
const top = earned(farm, 1450000);
assert.equal(top['glitter-fruit'], undefined);
assert.equal(earned(farm, 1479999)['glitter-fruit'], undefined);
assert.equal(earned(farm, 1480000)['glitter-fruit'], 1);
assert.equal(earned(farm, 1540000)['glitter-fruit'], 3);
assert.deepEqual(nextTier(farm, 1450000), { at: 1480000, prizes: { 'glitter-fruit': 1 } });
assert.deepEqual(nextTier(farm, 1480000), { at: 1510000, prizes: { 'glitter-fruit': 1 } });

assert.deepEqual(gain(farm, 354, 3200), { candy: 492000, capsule: 3, wishbox: 1 });
assert.deepEqual(gain(farm, 3200, 354), {});

console.log('farm: ok');
