/**
 * The Cozy Farm sums, with no page attached, so a test can import them.
 *
 * `farm` is data/farm.json as parsed: tiers ascending, each paying once when the
 * score reaches it, then `overflow.bonus` for every `overflow.every` points past
 * the last tier.
 */

/* "354", "45k", "1.2M", "1,450,000" -- the game prints K and M, so people type them. */
export function parseScore(text) {
  const m = String(text).trim().toLowerCase().replace(/[,\s_]/g, '').match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * { '': 1, k: 1e3, m: 1e6 }[m[2]]);
}

function add(into, prizes, times = 1) {
  if (times > 0) for (const [item, n] of Object.entries(prizes)) into[item] = (into[item] ?? 0) + n * times;
  return into;
}

function overflowCount(farm, score) {
  const last = farm.tiers.at(-1)[0];
  return score > last ? Math.floor((score - last) / farm.overflow.every) : 0;
}

/** Everything a score has paid out, as {item: count}. */
export function earned(farm, score) {
  const total = {};
  for (const [at, prizes] of farm.tiers) if (score >= at) add(total, prizes);
  return add(total, farm.overflow.bonus, overflowCount(farm, score));
}

/** The next thing a score will unlock: {at, prizes}. Never runs out, the bonus repeats. */
export function nextTier(farm, score) {
  const tier = farm.tiers.find(([at]) => at > score);
  if (tier) return { at: tier[0], prizes: tier[1] };
  const at = farm.tiers.at(-1)[0] + (overflowCount(farm, score) + 1) * farm.overflow.every;
  return { at, prizes: farm.overflow.bonus };
}

/** What going from `from` to `to` adds. Empty when `to` is not higher. */
export function gain(farm, from, to) {
  const a = earned(farm, from);
  const b = earned(farm, to);
  const out = {};
  for (const [item, n] of Object.entries(b)) if (n - (a[item] ?? 0) > 0) out[item] = n - (a[item] ?? 0);
  return out;
}
