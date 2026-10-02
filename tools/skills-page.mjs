/**
 * Writes the Skill data page's content from data/skill-numbers.json.
 *
 *   node tools/skills-page.mjs           rewrite skills.html between its markers
 *   node tools/skills-page.mjs --check   exit 1 if skills.html is out of date
 *
 * Static HTML rather than drawn in script, because the page exists to be found:
 * search engines bring most of the people who arrive from anywhere, and these
 * numbers are on no other site. assets/js/skills.js only filters what is here.
 * Run it after adding to skill-numbers.json; the --check keeps the two in step.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PAGE = 'skills.html';
const START = '<!-- skills:start -->';
const END = '<!-- skills:end -->';

const tatari = JSON.parse(readFileSync('data/tatari.json', 'utf8'));
const roster = Array.isArray(tatari) ? tatari : tatari.tatari ?? Object.values(tatari);
const numbers = JSON.parse(readFileSync('data/skill-numbers.json', 'utf8'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const attrs = (t) => `data-name="${esc(t.name.toLowerCase())}" data-type="${esc(t.type)}" data-role="${esc(t.role)}" data-tier="${t.tier}"`;
// The in-game element icons the drafter uses (assets/js/icons.js).
const typeIcon = (type) => `<img class="sk__ticon" src="data/images/icons/${esc(type.toLowerCase())}.png" alt="" width="16" height="16">`;
const art = (t, size) => `<img src="${esc(t.image)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
/* A row can carry what it was at the tier below ("was 120%") or be new there. */
const rows = (list) => `<dl class="sk__rows">${list.map(([label, value, mark]) =>
  `<dt>${esc(label)}${mark === 'new' ? ' <span class="sk__new">new</span>' : ''}</dt><dd>${
    mark && mark !== 'new' ? `<span class="sk__was">was ${esc(mark)}</span>` : ''}${esc(value)}</dd>`).join('')}</dl>`;

/*
 * The pyramid. Each tier of a line keeps the tier below's skill and adds to it,
 * so a card leads with what is new: a box the tier below did not have, marked
 * as such, and any number that moved, beside what it was. Boxes carried over
 * unchanged fold into one line, still in the page for anyone (and any search
 * engine) that opens them. Compared with the nearest lower tier recorded in
 * full; a T1, or a line's first recorded tier, has nothing to fold.
 */
const key = (s) => s.heading ?? '';
const sameRows = (a, b) => JSON.stringify(a.rows) === JSON.stringify(b.rows);
function section(s, prev, tier) {
  const before = prev?.find((p) => key(p) === key(s));
  const marked = s.rows.map(([label, value]) => {
    if (!prev || !before) return [label, value];
    const was = before.rows.find(([l]) => l === label);
    return !was ? [label, value, 'new'] : was[1] !== value ? [label, value, was[1]] : [label, value];
  });
  const fresh = prev && !before;
  return `
        ${s.heading || fresh ? `<h4 class="sk__heading">${esc(s.heading ?? 'Base')}${fresh ? ` <span class="sk__new">New at T${tier}</span>` : ''}</h4>` : ''}
        ${s.text ? `<p class="sk__text">${esc(s.text)}</p>` : ''}
        ${rows(marked)}`;
}

function card(t, n, below) {
  const prev = below?.n.sections;
  const all = n.sections ?? [];
  const kept = prev ? all.filter((s) => { const b = prev.find((p) => key(p) === key(s)); return b && sameRows(s, b); }) : [];
  const shown = all.filter((s) => !kept.includes(s));
  const folded = kept.length ? `
        <details class="sk__same"><summary>Same as ${esc(below.t.name)}: ${
    kept.map((s) => esc(s.heading ?? 'base numbers')).join(', ')}</summary>${
    kept.map((s) => section(s, null, t.tier)).join('')}
        </details>` : '';
  const sections = folded + shown.map((s) => section(s, prev, t.tier)).join('');
  const skill = n.skill ?? (t.skill ? t.skill.split(':')[0] : '');
  /* Last, as the game's panel has it, and in the same table as everything
     else: one tinted box per card made every card shout the same thing. */
  const arena = n.arenaFactor ? `
        <dl class="sk__rows sk__rows--arena" title="Gold Rush and Arena: the skill's damage against another Tatari is multiplied by this">
          <dt>Arena Factor</dt><dd>${esc(n.arenaFactor)}</dd></dl>` : '';
  return `
    <li class="sk" id="${esc(t.slug)}" ${attrs(t)}>
      <div class="sk__head">
        ${art(t, 48)}
        <div>
          <h3 class="sk__name">${esc(t.name)} <span class="sk__tier">T${t.tier}</span></h3>
          <p class="sk__meta">${typeIcon(t.type)}${esc(t.type)} ${esc(t.role)}${skill ? ` · <b>${esc(skill)}</b>` : ''}</p>
        </div>
      </div>
      ${sections}${arena}
      ${sections ? '' : '<p class="sk__more">Other numbers not recorded yet</p>'}
    </li>`;
}

/* A line member with nothing recorded, in its tier's slot, so a row always
   reads T1 to T4 and an empty slot says why it is empty. */
const ghost = (t) => `
    <li class="sk sk--ghost" ${attrs(t)}>${art(t, 36)}
      <span><b>${esc(t.name)}</b> <span class="sk__tier">T${t.tier}</span><br>Not recorded yet</span></li>`;

const recorded = roster.filter((t) => numbers[t.slug]);
const missing = roster.filter((t) => !numbers[t.slug]);
/* One evolution line per row, lowest tier first: a line's skills are read
   against each other ("what does Cribking add over Dreadclaw"), so they sit
   side by side. Lines in roster order. */
const shown = new Set(recorded.map((t) => t.familyId));
const lines = new Map();
for (const t of roster) if (shown.has(t.familyId)) lines.set(t.familyId, [...(lines.get(t.familyId) ?? []), t]);
for (const line of lines.values()) line.sort((a, b) => a.tier - b.tier);
// The bottom list is for lines with nothing recorded; the rest are in their rows.
const untouched = missing.filter((t) => !shown.has(t.familyId));

const body = `${START}
    <p class="sk__count" id="sk-count">${recorded.length} of ${roster.length} Tatari recorded.</p>
    <ol class="sk__list" id="sk-list">${[...lines.values()].map((line) => `
      <li class="sk__line" aria-label="${esc(line[0].family)} line"><ol class="sk__row" tabindex="0" aria-label="${esc(line[0].family)} line, T1 to T4">${
  line.map((t, i) => {
    if (!numbers[t.slug]) return ghost(t);
    // The nearest lower tier with its full panel recorded, to say what this one adds.
    const b = line.slice(0, i).reverse().find((x) => numbers[x.slug]?.sections);
    return card(t, numbers[t.slug], b && numbers[t.slug].sections ? { t: b, n: numbers[b.slug] } : null);
  }).join('')}
      </ol></li>`).join('')}
    </ol>
    <section class="panel sk__missing">
      <h2>Lines not recorded yet <span class="muted" id="sk-missing-n">${untouched.length} Tatari</span></h2>
      <ul class="sk__names" id="sk-names">${untouched.map((t) => `
        <li ${attrs(t)}>${art(t, 28)}<span>${esc(t.name)}</span></li>`).join('')}
      </ul>
    </section>
    ${END}`;

const page = readFileSync(PAGE, 'utf8');
const a = page.indexOf(START);
const b = page.indexOf(END);
if (a === -1 || b === -1) throw new Error(`${PAGE} has no ${START} ... ${END} markers`);
const next = page.slice(0, a) + body + page.slice(b + END.length);
if (process.argv.includes('--check')) {
  if (next !== page) { console.error(`${PAGE} is out of date: run node tools/skills-page.mjs`); process.exit(1); }
  console.log(`${PAGE} is up to date`);
} else {
  writeFileSync(PAGE, next);
  console.log(`${PAGE}: ${recorded.length} recorded, ${missing.length} not yet`);
}
