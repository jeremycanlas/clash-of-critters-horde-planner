/**
 * What a formation brings, beyond damage.
 *
 * Two sources, and the difference matters to the player:
 *
 *   The *base* skill is tagged by the wiki itself — a template files each page
 *   into `Category:Skill Type: X`, so "Heal", "Slow", "ATK Boost" is the wiki's
 *   vocabulary rather than anything invented here. Those you get for free.
 *
 *   The *Horde level-up* skills at level 3, 5 and 7 are only free text on the
 *   wiki, with no tags, so the same vocabulary is matched against the wording.
 *   Those you only get once you have actually levelled that Tatari, which is
 *   why every effect carries the level it arrives at and the summary says so.
 *
 * Grouping the types into heals, buffs and debuffs is this app's editorial
 * call; the wiki does not make that distinction.
 */

import { state } from './data.js';

const GROUPS = {
  heal: ['Heal', 'Self Heal'],
  buff: [
    'ATK Boost', 'ATK Speed Boost', 'DEF Boost', 'DMG Boost', 'Damage Boost',
    'DMG Boost (Solo)', 'DMG Reduction', 'HP Boost', 'Shield', 'Invincible', 'Buff',
  ],
  debuff: [
    'Slow', 'Stun', 'Paralyze', 'Burn', 'Fragile', 'Weaken', 'Shredded',
    'Knockback', 'Blind', 'Bind', 'Sting',
  ],
};

/** Everything else — how a skill lands rather than what it inflicts. */
const GROUP_OF = new Map();
for (const [group, types] of Object.entries(GROUPS)) {
  for (const type of types) GROUP_OF.set(type, group);
}

export const GROUP_LABELS = { heal: 'Heals', buff: 'Buffs', debuff: 'Debuffs' };

export const groupOf = (type) => GROUP_OF.get(type) ?? 'other';

/**
 * Horde skill text to the wiki's own skill-type names.
 *
 * Word boundaries throughout, and the wording the wiki actually uses rather
 * than the tag spelling — a skill inflicts "Paralysis", it does not inflict
 * "Paralyze". Only effects are matched: how a skill lands (AoE, Chain, Summon)
 * is not a buff, a debuff or a heal, so it is left out.
 */
const TEXT_PATTERNS = [
  // The self-heal test has to run before the general one, since "heals itself"
  // satisfies both and only the narrower reading is right.
  ['Self Heal', /\bheals?\s+(itself|themselves)\b|\bself[- ]heal/i],
  ['Heal', /\bheal(s|ing|ed)?\b/i],

  ['Shield', /\bshield(s|ed|ing)?\b/i],
  ['Invincible', /\binvincib\w*/i],
  ['ATK Speed Boost', /\b(atk|attack)\s+speed\b/i],
  ['ATK Boost', /\b(atk|attack)\s+boost\b|\bboosts?\s+(the\s+)?(atk|attack)\b/i],
  ['DEF Boost', /\b(def|defen[cs]e)\s+boost\b|\bboosts?\s+(the\s+)?(def|defen[cs]e)\b/i],
  ['DMG Boost', /\b(dmg|damage)\s+boost\b|\bboosts?\s+(the\s+)?(dmg|damage)\b/i],
  ['DMG Reduction', /\b(dmg|damage)\s+reduction\b|\breduces?\s+(the\s+)?(dmg|damage)\s+taken\b/i],
  ['HP Boost', /\bhp\s+boost\b|\bmax(imum)?\s+hp\b/i],
  ['Buff', /\bbuff(s|ed|ing)?\b/i],

  ['Slow', /\bslow(s|ed|ing)?\b/i],
  ['Stun', /\bstun(s|ned|ning)?\b/i],
  ['Paralyze', /\bparaly(ze|zes|zed|sis|sed)\b/i],
  ['Burn', /\bburn(s|ed|ing|t)?\b/i],
  ['Fragile', /\bfragile\b/i],
  ['Weaken', /\bweaken(s|ed|ing)?\b/i],
  ['Shredded', /\bshred(s|ded|ding)?\b/i],
  ['Knockback', /\bknock\s?back\b/i],
  ['Blind', /\bblind(s|ed|ing)?\b/i],
  ['Bind', /\bbind(s|ing)?\b|\bbound\b/i],
  ['Sting', /\bsting(s|ing)?\b/i],
];

/**
 * A leading "When ...," names what sets the skill off, not what it does:
 * Clucky's "When Weakened allies are nearby, provides continuous healing" is a
 * heal, not a Weaken, and Blueflick's "When inflicting Burn, ..." gets its Burn
 * from its base skill. Only clauses closed by a comma are dropped, because at
 * least one skill is missing its comma and the rest of that sentence is the
 * effect.
 */
const TRIGGER_CLAUSE = /\bwhen\b[^,.]*,/gi;

/** The skill types a Horde level-up skill's wording describes. */
export function typesInText(text) {
  if (!text) return [];
  const said = text.replace(TRIGGER_CLAUSE, ' ');
  const out = [];
  for (const [type, re] of TEXT_PATTERNS) {
    if (!re.test(said)) continue;
    // "heals itself" is a Self Heal and not also a Heal
    if (type === 'Heal' && out.includes('Self Heal')) continue;
    out.push(type);
  }
  return out;
}

/**
 * Memoised, because this is the app's hot path.
 *
 * Every keystroke in the roster search rebuilds all 218 cards, and each card
 * asks what its Tatari brings. Answering means running the 22 wording patterns
 * over up to three level-up skill texts — about 66 regex tests per Tatari, so
 * roughly 14,000 per repaint, and three times that again when an effect chip is
 * pressed and the filter asks as well.
 *
 * A Tatari is immutable once data.js has loaded it, so the answer never changes.
 * A WeakMap keyed on the object means custom Tatari that get replaced are
 * collected rather than pinned.
 */
const sourceCache = new WeakMap();

/** Every effect one Tatari brings: base skill first, then each levelled skill. */
export function effectSources(t) {
  if (t && sourceCache.has(t)) return sourceCache.get(t);
  const out = [];
  for (const type of t?.skillTypes ?? []) out.push({ type, level: null });

  for (const [key, skill] of Object.entries(t?.hordeSkills ?? {})) {
    const level = Number(key.replace('level', ''));
    if (!Number.isFinite(level)) continue;
    for (const type of typesInText(skill?.text)) {
      out.push({ type, level, skillName: skill?.name ?? '' });
    }
  }
  if (t) sourceCache.set(t, out);
  return out;
}

/**
 * Tallies the skill types across a set of Tatari.
 *
 * `count` is how many Tatari bring the effect at all, so a Tatari that both
 * starts with Shield and gains it again at level 7 counts once — but both
 * sources are listed, because which one you get depends on how far you level.
 *
 * @returns {{heal: Tally[], buff: Tally[], debuff: Tally[], other: Tally[], untagged: number}}
 *   Tally is {type, count, sources, fromBase, fromLevel, minLevel}
 *   and a source is {name, level, skillName}
 */
export function effectsOf(tatari) {
  const seen = new Map();
  let untagged = 0;

  for (const t of tatari) {
    const sources = effectSources(t);
    if (!sources.length) { untagged++; continue; }

    const here = new Set();
    for (const { type, level, skillName } of sources) {
      if (!seen.has(type)) {
        seen.set(type, {
          type, count: 0, sources: [], fromBase: false, fromLevel: false, minLevel: null,
        });
      }
      const tally = seen.get(type);
      if (!here.has(type)) { tally.count++; here.add(type); }
      tally.sources.push({ name: t.name, level, skillName });
      if (level === null) tally.fromBase = true;
      else {
        tally.fromLevel = true;
        tally.minLevel = tally.minLevel === null ? level : Math.min(tally.minLevel, level);
      }
    }
  }

  const out = { heal: [], buff: [], debuff: [], other: [], untagged };
  for (const tally of seen.values()) {
    // base skills first, then by level, so the free ones read first
    tally.sources.sort((a, b) =>
      (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
    out[groupOf(tally.type)].push(tally);
  }
  for (const list of Object.values(out)) {
    if (Array.isArray(list)) list.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }
  return out;
}

/** "Clucky, Shellshy at 5" — who brings this, and what it costs to get. */
export function sourceLabel(source) {
  return source.level === null ? source.name : `${source.name} at ${source.level}`;
}

/**
 * What one Tatari brings, collapsed to the three groups, for filtering and for
 * the roster's markers.
 *
 * `base` is true when it has the effect from the start. `level` is the earliest
 * level-up that grants it, or null — so a Tatari can be both (has a Shield, and
 * gains another at 7), which is why these are not one field.
 *
 * @returns {{heal: G, buff: G, debuff: G}} where G is {base: boolean, level: number|null}
 */
const groupCache = new WeakMap();

export function effectGroupsOf(t) {
  if (t && groupCache.has(t)) return groupCache.get(t);
  const out = {
    heal: { base: false, level: null },
    buff: { base: false, level: null },
    debuff: { base: false, level: null },
  };
  for (const { type, level } of effectSources(t)) {
    const group = out[groupOf(type)];
    if (!group) continue;                       // 'other': how it lands, not what it does
    if (level === null) group.base = true;
    else group.level = group.level === null ? level : Math.min(group.level, level);
  }
  if (t) groupCache.set(t, out);
  return out;
}

/** Whether this Tatari brings `group` at all, from the start or by levelling. */
export const bringsEffect = (t, group) => {
  const g = effectGroupsOf(t)[group];
  return !!g && (g.base || g.level !== null);
};

/**
 * Whether this Tatari brings one named effect, from the start or by levelling.
 *
 * The narrow twin of bringsEffect. That one asks "any debuff at all", which is
 * the right question when you are filling a bench; this one asks "Stun", which
 * is the right question when a wave keeps killing you and you have worked out
 * why. Both read the same memoised sources, so asking 23 of these per card
 * costs no more than asking three.
 */
export const bringsType = (t, type) => effectSources(t).some((s) => s.type === type);

/**
 * What each skill type does, in the wiki's own words.
 *
 * Every tag has a `Category:Skill Type: X` page, and that page carries a
 * one-line definition — "The Skills with ATK Boost effect can buff the ATK stat
 * of the affected ally(s)". The scraper collects those into meta.json, so this
 * is documentation rather than a guess.
 *
 * 19 of the 32 tags are described. The rest either have no category page yet
 * (Shield, Stun) or still read "known to TBA" on the wiki (Bind, Blind), and
 * the scraper drops those — an invented definition would be worse than none.
 * Guessing here was in fact wrong: Paralyze turns out to be Lightning damage
 * over time that delays movement, not the plain stun it sounds like.
 */
export const helpFor = (type) => state.meta?.skillTypeInfo?.[type] ?? null;
