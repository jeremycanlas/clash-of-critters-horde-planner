/**
 * What a formation brings, beyond damage.
 *
 * The wiki tags every Tatari's skill with types — Heal, Slow, ATK Boost — via a
 * template that files the page into `Category:Skill Type: X`, so the vocabulary
 * is the wiki's own rather than anything invented here. Grouping them into
 * heals, buffs and debuffs is this app's editorial call, since the wiki does not
 * make that distinction.
 *
 * These describe the *base* skill. Anything a Tatari picks up at level 3, 5 or 7
 * lives in the Horde skill text and is not counted here.
 */

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
 * Tallies the skill types across a set of Tatari.
 * @returns {{heal: Tally[], buff: Tally[], debuff: Tally[], other: Tally[], untagged: number}}
 *   where a Tally is {type, count, names}
 */
export function effectsOf(tatari) {
  const seen = new Map();
  let untagged = 0;

  for (const t of tatari) {
    if (!t?.skillTypes?.length) { untagged++; continue; }
    for (const type of t.skillTypes) {
      if (!seen.has(type)) seen.set(type, { type, count: 0, names: [] });
      const tally = seen.get(type);
      tally.count++;
      tally.names.push(t.name);
    }
  }

  const out = { heal: [], buff: [], debuff: [], other: [], untagged };
  for (const tally of seen.values()) out[groupOf(tally.type)].push(tally);
  for (const list of Object.values(out)) {
    if (Array.isArray(list)) list.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }
  return out;
}
