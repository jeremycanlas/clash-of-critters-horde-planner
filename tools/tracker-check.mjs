// Checks the tracker's filters and sorting.  node tools/tracker-check.mjs
import assert from 'node:assert/strict';
import { totals, filterRows, sortRows, topFor } from '../assets/js/tracker-filter.js';

const now = Date.parse('2026-09-18T12:00:00Z');
const rows = [
  { uid: 1, name: 'Alpha', aliases: 'Al (D)', dragonfruit: 260, bamboo: 200, carrot: 150, phantom: 100, clock: 250, berry: 90, checked_at: '2026-09-17T00:00:00Z' },
  { uid: 2, name: 'Bravo', dragonfruit: 120, clock: 263, checked_at: '2026-07-01T00:00:00Z' },
  { uid: 3, name: 'Charlie' },
  { uid: 4, name: 'Delta', clock: 180 },
];

assert.deepEqual(totals(rows[0]), { total: 1050, filled: 6 });
assert.deepEqual(totals(rows[2]), { total: 0, filled: 0 });

const ids = (rs) => rs.map((r) => r.uid);
assert.deepEqual(ids(filterRows(rows, { q: 'al' })), [1]);            // name or alias
assert.deepEqual(ids(filterRows(rows, { q: '3' })), [3]);             // uid
assert.deepEqual(ids(filterRows(rows, { progress: 'none' })), [3]);
assert.deepEqual(ids(filterRows(rows, { progress: 'some' })), [2, 4]);
assert.deepEqual(ids(filterRows(rows, { progress: 'full' })), [1]);
// Older than 30 days, or never dated.
assert.deepEqual(ids(filterRows(rows, { progress: 'stale', staleDays: 30 }, now)), [2, 3, 4]);
assert.deepEqual(ids(filterRows(rows, { progress: 'never' })), [3, 4]); // spreadsheet-only rows
// Ranges combine, and an unrecorded fruit fails a range on it.
assert.deepEqual(ids(filterRows(rows, { ranges: { clock: { min: 250 } } })), [1, 2]);
assert.deepEqual(ids(filterRows(rows, { ranges: { clock: { min: 250 }, dragonfruit: { max: 200 } } })), [2]);
assert.deepEqual(ids(filterRows(rows, { ranges: { clock: { min: 150, max: 200 } } })), [4]);

assert.deepEqual(ids(sortRows(rows, 'clock', 'desc')), [2, 1, 4, 3]);   // empty last
assert.deepEqual(ids(sortRows(rows, 'clock', 'asc')), [4, 1, 2, 3]);    // still last
assert.deepEqual(ids(sortRows(rows, 'total', 'desc')), [1, 2, 4, 3]);
assert.deepEqual(ids(sortRows(rows, 'name', 'asc')), [1, 2, 3, 4]);
assert.deepEqual(ids(topFor(rows, 'dragonfruit', 1)), [1]);

console.log('tracker: ok');
