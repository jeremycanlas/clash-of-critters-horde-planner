/**
 * The tracker's filtering and sorting, with no page attached, so a test can
 * import it. A row is one tracker_players record.
 */

export const FRUITS = [
  { key: 'dragonfruit', name: 'DragonFruit', tatari: 'frugling', who: 'Frugling' },
  { key: 'bamboo', name: 'Bamboo', tatari: 'pandaroo', who: 'Pandaroo' },
  { key: 'carrot', name: 'Carrot', tatari: 'droppit', who: 'Droppit' },
  { key: 'phantom', name: 'Phantom', tatari: 'maskfry', who: 'Maskfry' },
  { key: 'clock', name: 'Clock', tatari: 'hootlet', who: 'Hootlet' },
  { key: 'berry', name: 'Berry', tatari: null, who: '' },
];

const DAY = 864e5;

/** Sum of the fruits recorded, and how many of the six are. */
export function totals(row) {
  let total = 0, filled = 0;
  for (const f of FRUITS) {
    if (row[f.key] != null) { total += row[f.key]; filled += 1; }
  }
  return { total, filled };
}

/**
 * @param {object[]} rows
 * @param {{q?: string, progress?: 'all'|'none'|'some'|'full'|'stale'|'never', staleDays?: number,
 *          ranges?: Record<string, {min?: number|null, max?: number|null}>}} f
 * @param {number} now ms, for "checked more than N days ago"
 */
export function filterRows(rows, f, now = Date.now()) {
  const q = (f.q ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !`${r.uid} ${r.name} ${r.aliases ?? ''}`.toLowerCase().includes(q)) return false;

    const { filled } = totals(r);
    switch (f.progress) {
      case 'none': if (filled !== 0) return false; break;
      case 'some': if (filled === 0 || filled === FRUITS.length) return false; break;
      case 'full': if (filled !== FRUITS.length) return false; break;
      case 'never': if (r.checked_at) return false; break;
      case 'stale': {
        // Never checked by hand counts as stale: an imported number has no date.
        const at = r.checked_at ? Date.parse(r.checked_at) : null;
        if (at != null && now - at <= (f.staleDays ?? 30) * DAY) return false;
        break;
      }
      default: break;
    }

    for (const [key, { min = null, max = null } = {}] of Object.entries(f.ranges ?? {})) {
      if (min == null && max == null) continue;
      const v = r[key];
      // A range on a fruit asks about that fruit, so an unrecorded one fails it.
      if (v == null) return false;
      if (min != null && v < min) return false;
      if (max != null && v > max) return false;
    }
    return true;
  });
}

/**
 * Sorted copy. `key` is a fruit, 'total', 'name', 'uid' or 'checked_at'.
 * Empty values always go last, whichever way the column is sorted.
 */
export function sortRows(rows, key, dir = 'desc') {
  const val = (r) => {
    if (key === 'total') return totals(r).filled ? totals(r).total : null;
    if (key === 'checked_at') return r.checked_at ? Date.parse(r.checked_at) : null;
    if (key === 'name') return (r.name || '').toLowerCase() || null;
    return r[key] ?? null;
  };
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return a.uid - b.uid;
    if (x == null) return 1;
    if (y == null) return -1;
    if (x < y) return -sign;
    if (x > y) return sign;
    return a.uid - b.uid;
  });
}

/** The best `n` players on one fruit, recorded values only. */
export function topFor(rows, key, n = 10) {
  return sortRows(rows.filter((r) => r[key] != null), key, 'desc').slice(0, n);
}
