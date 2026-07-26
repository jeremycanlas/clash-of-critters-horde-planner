/**
 * Loads the roster and builds the search index.
 *
 * The roster is the wiki scrape (data/tatari.json) merged with any custom
 * Tatari the user has added locally. Custom entries look exactly like scraped
 * ones plus `custom: true`, so everything downstream treats them the same.
 */

const CUSTOM_KEY = 'coc.custom.v1';
const ALIAS_KEY = 'coc.aliases.v1';

export const state = {
  meta: null,
  /** @type {Tatari[]} every Tatari, scraped + custom */
  all: [],
  /** @type {Map<string, Tatari>} by slug */
  bySlug: new Map(),
  /** @type {Map<string|number, Tatari[]>} members of each evolution family */
  families: new Map(),
  /** family name -> extra search terms */
  aliases: {},
};

/**
 * @typedef {object} Tatari
 * @property {string} name
 * @property {string} slug
 * @property {'Water'|'Fire'|'Grass'|'Lightning'|'Rock'} type
 * @property {'DPS'|'Guardian'|'Tank'|'Healer'|'Support'|'Specialist'} role
 * @property {number} tier          1-4
 * @property {string} family        name of the T1
 * @property {string|number} familyId
 * @property {number} stages        how many tiers the line has
 * @property {'Common'|'Rare'} rarity
 * @property {string[]} evolutionLine
 * @property {'front'|'back'|null} battleRow
 * @property {string|null} image
 * @property {boolean} [custom]
 */

// ---------------------------------------------------------------- local extras

export function loadCustom() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function saveCustom(list) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

function loadLocalAliases() {
  try { return JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {}; }
  catch { return {}; }
}

export function saveLocalAliases(map) {
  localStorage.setItem(ALIAS_KEY, JSON.stringify(map));
}

export function localAliases() { return loadLocalAliases(); }

// ---------------------------------------------------------------- normalising

export function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Fills in everything a custom Tatari can reasonably be missing so it behaves
 * like a scraped one. A custom entry with no explicit family becomes a
 * one-member family of its own, which is what you want for a homebrew critter.
 */
export function normalizeCustom(raw, index = 0) {
  const name = String(raw.name || `Custom ${index + 1}`).trim();
  const slug = raw.slug || `custom-${slugify(name)}`;
  const family = raw.family || name;
  const line = Array.isArray(raw.evolutionLine) && raw.evolutionLine.length
    ? raw.evolutionLine : [name];
  return {
    name,
    slug,
    type: raw.type || 'Rock',
    role: raw.role || 'DPS',
    tier: Number(raw.tier) || 1,
    family,
    familyId: raw.familyId ?? `custom:${slugify(family)}`,
    stages: Number(raw.stages) || line.length,
    rarity: raw.rarity || 'Rare',
    evolutionLine: line,
    battleRow: raw.battleRow || null,
    previousRole: raw.previousRole || null,
    etymology: raw.etymology || null,
    skill: raw.skill || '',
    description: raw.description || '',
    image: raw.image || null,
    glitterImage: raw.glitterImage || null,
    wikiUrl: raw.wikiUrl || null,
    custom: true,
  };
}

// ---------------------------------------------------------------- search index

/**
 * Everything a Tatari can be found by: its own name, its whole evolution line
 * (so "frostnip" surfaces Frostluna), type, role, tier, rarity, the wiki
 * etymology, the skill text, and the community aliases for its family.
 */
function searchTerms(t, aliases) {
  const parts = [
    t.name, t.slug.replace(/-/g, ' '), t.type, t.role, t.rarity,
    `t${t.tier}`, t.family, ...t.evolutionLine,
    t.etymology || '', t.skill || '',
    ...(aliases[t.family] || []),
    ...(aliases[t.name] || []),
  ];
  return parts.join(' ').toLowerCase();
}

export function reindex() {
  const merged = { ...state.aliases };
  for (const [k, v] of Object.entries(loadLocalAliases())) {
    merged[k] = [...new Set([...(merged[k] || []), ...(Array.isArray(v) ? v : [v])])];
  }
  state.mergedAliases = merged;

  state.bySlug = new Map();
  state.families = new Map();
  for (const t of state.all) {
    t._search = searchTerms(t, merged);
    state.bySlug.set(t.slug, t);
    if (!state.families.has(t.familyId)) state.families.set(t.familyId, []);
    state.families.get(t.familyId).push(t);
  }
  for (const members of state.families.values()) members.sort((a, b) => a.tier - b.tier);
}

/** Case- and order-insensitive multi-word match. */
export function matches(t, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((word) => t._search.includes(word));
}

// ---------------------------------------------------------------- boot

export async function load() {
  const [meta, roster, aliases] = await Promise.all([
    fetch('data/meta.json').then((r) => r.json()),
    fetch('data/tatari.json').then((r) => r.json()),
    fetch('data/aliases.json').then((r) => r.json()).catch(() => ({})),
  ]);

  delete aliases._readme;
  state.meta = meta;
  state.aliases = aliases;
  state.all = [...roster, ...loadCustom().map(normalizeCustom)];
  reindex();
  return state;
}

export function setCustom(list) {
  const normalized = list.map(normalizeCustom);
  saveCustom(normalized);
  state.all = [...state.all.filter((t) => !t.custom), ...normalized];
  reindex();
}

export function customList() {
  return state.all.filter((t) => t.custom);
}
