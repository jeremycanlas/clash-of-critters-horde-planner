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
  /**
   * @type {Zobo[]} the enemies, kept apart from the roster on purpose.
   *
   * A Zobo shares almost nothing with a Tatari — no tier, no evolution line, no
   * role, and above all no bench — so folding them into `all` would mean every
   * consumer of the roster testing `kind` before it could trust a field. The one
   * place they do meet is the field itself, and `pieceBySlug` is what resolves an
   * occupant there without either side needing to know about the other.
   */
  zobos: [],
  /**
   * @type {Map<string, {direction: 'buff'|'nerf'|'adjusted', line: string, changes: string[]}>}
   * What the last game update did to each Tatari, keyed by slug. Empty when
   * data/changes.json has no entries, which is how a copy that is not tracking
   * updates behaves.
   */
  changes: new Map(),
  /** @type {{label: string, patch: string}|null} the update those changes describe */
  patch: null,
  /** @type {Map<string, Zobo>} by slug */
  zoboBySlug: new Map(),
  /** @type {Map<string|number, Tatari[]>} members of each evolution family */
  families: new Map(),
  /** family name -> extra search terms */
  aliases: {},
  /** hand-recorded attack ranges, see data/ranges.json */
  ranges: null,
  /** hand-recorded heal / buff / debuff reach, see data/effect-ranges.json */
  effectRanges: null,
  /**
   * @type {Map<string, number[]>} boss slug -> the stages it arrives at.
   *
   * A list rather than a number, because the run sends some bosses more than
   * once -- Goonch turns up three times -- and a single "stage" field would have
   * to pick one of them and be wrong about the rest. Read from data/boss-order.json
   * and empty when that file is missing, which is how a copy without it behaves.
   */
  bossStages: new Map(),
  /** @type {string|null} who worked the boss order out. Shown with it. */
  bossOrderBy: null,
  /** @type {number} how many stages the order covers, 0 when it is not loaded */
  bossStageCount: 0,
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

function loadCustom() {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveCustom(list) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

function loadLocalAliases() {
  try { return JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}') || {}; }
  catch { return {}; }
}

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

  /*
   * The tier-1 form of each evolution line, by familyId.
   *
   * range.js and contribute.js both need it to resolve a line's shared range,
   * and both were reaching for `state.all.find(...)`, a 218-item scan, from
   * inside loops over the whole roster. On the recorder that is 218 cards times
   * four reaches times 218, about 190,000 array steps for one tile click. The
   * families map is already sorted by tier here, so the answer is its head.
   */
  state.baseOfFamily = new Map();
  for (const [familyId, members] of state.families) {
    state.baseOfFamily.set(familyId, members[0]);
  }
}

/** Case- and order-insensitive multi-word match. */
export function matches(t, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((word) => t._search.includes(word));
}

// ---------------------------------------------------------------- boot

export async function load() {
  const [meta, roster, zobos, aliases, ranges, effectRanges, changes, bossOrder] = await Promise.all([
    fetch('data/meta.json').then((r) => r.json()),
    fetch('data/tatari.json').then((r) => r.json()),
    // A copy without the Zobo file still drafts; it simply has no enemies to
    // place, which is what every build before this one did.
    fetch('data/zobos.json').then((r) => r.json()).catch(() => []),
    fetch('data/aliases.json').then((r) => r.json()).catch(() => ({})),
    fetch('data/ranges.json').then((r) => r.json()).catch(() => ({})),
    fetch('data/effect-ranges.json').then((r) => r.json()).catch(() => ({})),
    // Hand-authored, so a copy that has not been updated for the current game
    // update simply marks nothing rather than failing to load the roster.
    fetch('data/changes.json').then((r) => r.json()).catch(() => ({})),
    // Hand-authored from play, like the ranges. A copy without it shows the
    // bosses exactly as it always did, with no stage numbers on them.
    fetch('data/boss-order.json').then((r) => r.json()).catch(() => ({})),
  ]);

  delete aliases._readme;
  state.meta = meta;
  state.aliases = aliases;
  state.ranges = ranges;
  state.effectRanges = effectRanges;
  /*
   * Flattened from lines to members on the way in, because everything that asks
   * this question asks it about one Tatari -- a card being drawn, a detail sheet
   * being opened -- and none of them know or care which family it belongs to.
   * The file is authored by line because that is how the patch notes are written
   * and how the skills actually work; the lookup is by slug because that is how
   * it is read. Doing the fan-out once here beats doing it per card.
   */
  state.patch = changes?.lines?.length ? { label: changes.label, patch: changes.patch } : null;
  state.changes = new Map();
  for (const entry of changes?.lines ?? []) {
    for (const slug of entry.members ?? []) {
      state.changes.set(slug, { direction: entry.direction, line: entry.line, changes: entry.changes });
    }
  }
  state.all = [...roster, ...loadCustom().map(normalizeCustom)];
  state.zobos = Array.isArray(zobos) ? zobos : [];
  for (const z of state.zobos) {
    z.kind = 'zobo';
    z._search = [z.name, z.slug.replace(/-/g, ' '), z.type ?? '', z.boss ? 'boss' : '',
      z.skill?.name ?? '', z.skill?.text ?? '', z.description ?? '']
      .join(' ').toLowerCase();
  }
  state.zoboBySlug = new Map(state.zobos.map((z) => [z.slug, z]));
  /*
   * Inverted on the way in, for the same reason the patch changes are: the file
   * is authored as "stage 15 sends Sandworm and Golf", because that is how it is
   * observed and how it is checked, and every reader asks the opposite question
   * -- "this card, which stages?" -- while drawing one card.
   */
  const stages = Array.isArray(bossOrder?.stages) ? bossOrder.stages : [];
  state.bossStages = new Map();
  state.bossStageCount = stages.length;
  state.bossOrderBy = stages.length ? (bossOrder.by ?? null) : null;
  stages.forEach((slugs, i) => {
    for (const slug of slugs ?? []) {
      if (!state.bossStages.has(slug)) state.bossStages.set(slug, []);
      state.bossStages.get(slug).push(i + 1);
    }
  });
  reindex();
  return state;
}

/**
 * Whatever can stand on the field, by slug — Tatari or Zobo.
 *
 * The field holds both and does not want to care which: renderGrid, the share
 * card and the live session all ask "what is this occupant" and want a name, a
 * type and a sprite back. Anything that needs the difference reads `.kind`.
 *
 * Slugs cannot collide, because a Zobo's always ends in `-zobo`; if the wiki
 * ever produces a Tatari that does, the Tatari wins here and the Zobo becomes
 * unplaceable rather than silently replacing it on somebody's board.
 */
export function pieceBySlug(slug) {
  return state.bySlug.get(slug) ?? state.zoboBySlug.get(slug) ?? null;
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
