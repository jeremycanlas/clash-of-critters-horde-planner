/**
 * Custom Tatari support.
 *
 * There is no longer an editor in the UI, but the data layer stays: an exported
 * formation bundles any custom Tatari it uses under `customTatari`, and importing
 * that file has to register them before the placements referencing them resolve.
 * Without this, a plan built around a homebrew critter would open with holes.
 */

import { state, customList, setCustom, normalizeCustom } from './data.js';

/** Drops the fields that are derived rather than authored. */
function strip(t) {
  const { _search, custom, familyId, stages, evolutionLine, ...rest } = t;
  return rest;
}

/**
 * Accepts a `{tatari: [...]}` bundle, a bare array, or the `customTatari` block
 * of an exported formation. Existing slugs are left alone rather than overwritten.
 * @returns {number} how many were added
 */
export function importTatari(data) {
  const incoming = Array.isArray(data) ? data
    : Array.isArray(data?.tatari) ? data.tatari
      : Array.isArray(data?.customTatari) ? data.customTatari
        : [];
  if (!incoming.length) return 0;

  const existing = customList().map(strip);
  const known = new Set(state.all.map((t) => t.slug));
  const fresh = [];

  for (const raw of incoming) {
    const t = normalizeCustom(raw, existing.length + fresh.length);
    if (known.has(t.slug)) continue;
    known.add(t.slug);
    fresh.push(strip(t));
  }
  if (fresh.length) setCustom([...existing, ...fresh]);
  return fresh.length;
}
