/**
 * Writes the Skill data page's content from data/skill-numbers.json.
 *
 *   node tools/skills-page.mjs           rewrite skills.html between its markers
 *   node tools/skills-page.mjs --check   exit 1 if skills.html is out of date
 *
 * Static HTML rather than drawn in script, because the page exists to be found:
 * search engines bring most of the people who arrive from anywhere, and these
 * numbers are on no other site. Everything is written here, every line and every
 * tier and the rankings table; assets/js/skills.js only picks which part shows.
 * Run it after adding to skill-numbers.json or horde-numbers.json; the --check
 * keeps the page and the data in step.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PAGE = 'skills.html';
const START = '<!-- skills:start -->';
const END = '<!-- skills:end -->';

const tatari = JSON.parse(readFileSync('data/tatari.json', 'utf8'));
const roster = Array.isArray(tatari) ? tatari : tatari.tatari ?? Object.values(tatari);
const numbers = JSON.parse(readFileSync('data/skill-numbers.json', 'utf8'));
// Horde Invasion level 3/5/7 numbers, read off the deploy screen's skill panel, by family.
// Still being filled in, so a missing file or family just means "not recorded yet".
const hordeNumbers = (() => { try { return JSON.parse(readFileSync('data/horde-numbers.json', 'utf8')); } catch { return {}; } })();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const typeIcon = (type, size = 16) => `<img class="sk-ticon" src="data/images/icons/${esc(type.toLowerCase())}.png" alt="" width="${size}" height="${size}">`;
const art = (t, size) => `<img class="sk-art" src="${esc(t.image)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
// The first number in a panel value, for sorting: "130%" 130, "4s After Dance Ends" 4.
const num = (v) => { const m = /\d+(\.\d+)?/.exec(v ?? ''); return m ? Number(m[0]) : null; };
const skillName = (t) => numbers[t.slug]?.skill ?? (t.skill ?? '').split(':')[0];
const skillDesc = (t) => t.skill?.includes(':') ? t.skill.slice(t.skill.indexOf(':') + 1).trim() : '';

/* The skill's own rows are the box with no heading. Damage Factor and Cooldown
   lead the panel as big numbers beside Arena Factor; the rest stay in a box. */
const BIG = ['Damage Factor', 'Cooldown'];
const base = (n) => n?.sections?.find((s) => !s.heading)?.rows ?? [];
const pick = (n, label) => base(n).find(([l]) => l === label)?.[1];

/* Effect tags for the rankings filter, from the panel's own box names and row
   labels. "Stun" counts the effects that stop a target outright. */
const TAGS = [
  ['aura', 'Aura', (h) => /^Aura:/.test(h)],
  ['stun', 'Stun', (h) => /^(Stun|Paralysis|Sleep|Bind|Electricage)$/.test(h)],
  ['heal', 'Heal', (h, l) => /Heal/.test(`${h} ${l}`)],
  ['shield', 'Shield', (h, l) => /Shield/.test(`${h} ${l}`)],
  ['slow', 'Slow', (h, l) => /^Slow/.test(h) || /Move Speed Reduction/.test(l)],
];
const tagsOf = (n) => TAGS.filter(([, , test]) => (n?.sections ?? []).some((s) =>
  test(s.heading ?? '', s.rows.map(([l]) => l).join(' ')))).map(([k]) => k);

/* A row can carry what it was at the tier below ("was 120%") or be new there. */
const rows = (list) => !list.length ? '' : `<dl class="sk-rows">${list.map(([label, value, mark]) =>
  `<dt>${esc(label)}${mark === 'new' ? ' <span class="sk-new">new</span>' : ''}</dt><dd>${
    mark && mark !== 'new' ? `<span class="sk-was">was ${esc(mark)}</span>` : ''}${esc(value)}</dd>`).join('')}</dl>`;

/*
 * The pyramid. Each tier of a line keeps the tier below's skill and adds to it,
 * so a tier marks what it adds: a box the tier below did not have is "New at
 * T3", and a number that moved shows what it was. Compared with the nearest
 * lower tier recorded in full; a T1 has nothing to compare with.
 */
const key = (s) => s.heading ?? '';
function mark(s, prev) {
  const before = prev?.find((p) => key(p) === key(s));
  return s.rows.map(([label, value]) => {
    if (!before) return [label, value];
    const was = before.rows.find(([l]) => l === label);
    return !was ? [label, value, 'new'] : was[1] !== value ? [label, value, was[1]] : [label, value];
  });
}

const AF_NOTE = 'Gold Rush & Arena';
function stat(label, value, was, big) {
  return `
          <div class="sk-stat${big ? ' sk-stat--big' : ''}">
            <span class="sk-stat__label">${esc(label)}</span>
            <span class="sk-stat__value">${value ? esc(value) : '–'}</span>${
  was && was !== value ? `<span class="sk-was">was ${esc(was)}</span>` : ''}${big ? `<span class="sk-stat__note">${esc(AF_NOTE)}</span>` : ''}
          </div>`;
}

/* One tier of a line: the skill, its big numbers, then its effect boxes. */
function tier(t, line, i) {
  const n = numbers[t.slug];
  const below = line.slice(0, i).reverse().find((x) => numbers[x.slug]?.sections);
  const prev = n?.sections && below ? numbers[below.slug].sections : null;
  const wasOf = (label) => prev?.find((s) => !s.heading)?.rows.find(([l]) => l === label)?.[1];
  const desc = skillDesc(t);
  const extra = base(n).filter(([l]) => !BIG.includes(l));
  const boxes = (n?.sections ?? []).filter((s) => s.heading);
  const baseBox = extra.length ? `
          <section class="sk-box">
            <h4 class="sk-box__title">Skill</h4>
            ${rows(mark({ heading: null, rows: extra }, prev))}
          </section>` : '';
  return `
        <section class="sk-tier" id="${esc(t.slug)}" data-tier="${t.tier}" aria-label="${esc(t.name)}, tier ${t.tier}">
          <div class="sk-hero">
            ${art(t, 112)}
            <div class="sk-hero__text">
              <h3 class="sk-hero__name">${esc(t.name)} <span class="sk-tierpill">T${t.tier}</span></h3>
              <p class="sk-hero__meta">${typeIcon(t.type)}${esc(t.type)} · ${esc(t.role)}</p>
              <p class="sk-hero__skill">${esc(skillName(t))}</p>
              ${desc ? `<p class="sk-hero__desc">${esc(desc)}</p>` : ''}
            </div>
          </div>
          <div class="sk-stats">${stat('Arena Factor', n?.arenaFactor, null, true)}${
  BIG.map((l) => stat(l, pick(n, l), wasOf(l))).join('')}
          </div>
          ${n?.sections ? `<div class="sk-boxes">${baseBox}${boxes.map((s) => {
    const fresh = prev && !prev.some((p) => key(p) === key(s));
    return `
            <section class="sk-box${fresh ? ' sk-box--new' : ''}">
              <h4 class="sk-box__title">${esc(s.heading)}${fresh ? ` <span class="sk-new">New at T${t.tier}</span>` : ''}</h4>
              ${s.text ? `<p class="sk-box__text">${esc(s.text)}</p>` : ''}
              ${rows(fresh ? s.rows : mark(s, prev))}
            </section>`;
  }).join('')}
          </div>` : '<p class="sk-none">The rest of this skill panel is not recorded yet.</p>'}
        </section>`;
}

/* Horde Invasion's level 3, 5 and 7 skills belong to the whole line. Their
   numbers are grouped by effect box: rows carry the box's name third. */
const LEVELS = [['level3', 3], ['level5', 5], ['level7', 7]];
function hordeRows(list) {
  if (!list?.length) return '<p class="sk-none">Numbers not recorded yet</p>';
  const groups = [];
  for (const [label, value, box] of list) {
    const last = groups.at(-1);
    if (last && last.box === box) last.rows.push([label, value]);
    else groups.push({ box, rows: [[label, value]] });
  }
  return groups.map((g) => `${g.box ? `<h5 class="sk-hbox">${esc(g.box)}</h5>` : ''}${rows(g.rows)}`).join('');
}
function horde(t) {
  const h = t.hordeSkills;
  if (!h) return `
          <p class="sk-none">Horde Invasion skills not recorded yet.</p>`;
  return `
          <section class="sk-horde" aria-label="Horde Invasion skills">
            <h3 class="sk-horde__title">Horde Invasion <span>the whole line learns these as it levels up</span></h3>
            <ol class="sk-levels">${LEVELS.filter(([k]) => h[k]).map(([k, lv]) => `
              <li class="sk-level">
                <p class="sk-level__lv">Lv ${lv}</p>
                <h4 class="sk-level__name">${esc(h[k].name)}</h4>
                <p class="sk-level__text">${esc(h[k].text)}</p>
                ${hordeRows(hordeNumbers[t.family]?.[k]?.rows)}
              </li>`).join('')}
            </ol>
          </section>`;
}

/* Evolution lines, lowest tier first, in roster order. */
const lines = new Map();
for (const t of roster) lines.set(t.familyId, [...(lines.get(t.familyId) ?? []), t]);
const ordered = [...lines.values()].map((l) => l.sort((a, b) => a.tier - b.tier));
const lineAF = (line) => line.map((t) => numbers[t.slug]?.arenaFactor).filter(Boolean).at(-1);
// What the search box reads for a line: names, skills, effect boxes, horde skills.
const lineQ = (line) => [...new Set(line.flatMap((t) => [t.name, skillName(t),
  ...(numbers[t.slug]?.sections ?? []).map((s) => s.heading ?? '')])
  .concat(Object.values(line[0].hordeSkills ?? {}).map((h) => h.name)))].join(' ').toLowerCase();
const hordeDone = ordered.filter((l) => hordeNumbers[l[0].family]).length;

const index = `
      <nav class="sk-index" aria-label="Evolution lines">
        <ol class="sk-index__list" id="sk-list">${ordered.map((line) => {
  const top = line.at(-1);
  return `
          <li class="sk-index__item" data-type="${esc(top.type)}" data-q="${esc(lineQ(line))}">
            <a class="sk-pick" href="#${esc(line[0].slug)}" data-line="line-${line[0].familyId}">
              ${art(top, 40)}
              <span class="sk-pick__text">
                <span class="sk-pick__name">${esc(line[0].family)}</span>
                <span class="sk-pick__sub">${typeIcon(top.type, 14)}${esc(top.role)} · T1–T${top.tier}</span>
              </span>
              <span class="sk-pick__af"><span class="sr-only">Arena Factor </span>${esc(lineAF(line) ?? '–')}</span>
            </a>
          </li>`;
}).join('')}
        </ol>
      </nav>`;

const detail = `
      <div class="sk-detail" id="sk-detail">${ordered.map((line) => `
        <article class="sk-line" id="line-${line[0].familyId}" data-type="${esc(line.at(-1).type)}">
          <header class="sk-line__head">
            <button class="sk-back" type="button" data-back>All lines</button>
            <h2 class="sk-line__name">${esc(line[0].family)} line</h2>
            <div class="sk-switch" role="group" aria-label="Tier">${line.map((t) => `
              <button class="sk-switch__btn" type="button" data-slug="${esc(t.slug)}" aria-pressed="false">${art(t, 32)}<span><b>T${t.tier}</b> <span class="sk-switch__name">${esc(t.name)}</span></span></button>`).join('')}
            </div>
          </header>${line.map((t, i) => tier(t, line, i)).join('')}${horde(line[0])}
        </article>`).join('')}
      </div>`;

/* Rankings: every Tatari in one table, Arena Factor first. The sort buttons
   and filters only reorder and hide these rows. */
const ranked = [...roster].sort((a, b) => (num(numbers[b.slug]?.arenaFactor) ?? -1) - (num(numbers[a.slug]?.arenaFactor) ?? -1));
// A phone has room for the short names only; the button keeps the full one.
const sortBtn = (k, label, short, on) => `<th scope="col" class="sk-num"${on ? ' aria-sort="descending"' : ''}><button class="sk-sort" type="button" data-sort="${k}" aria-label="${label}"><span class="sk-long">${label}</span><span class="sk-short">${short}</span></button></th>`;
const tagLabel = Object.fromEntries(TAGS.map(([k, l]) => [k, l]));
const rankings = `
      <section class="sk-rank" id="sk-rank" aria-label="Rankings">
        <div class="sk-rank__tools">
          <div class="segmented" role="group" aria-label="Tier" id="sk-tiers">
            <button class="segmented__btn" type="button" data-tier="" aria-pressed="true">Any tier</button>${[1, 2, 3, 4].map((n) => `
            <button class="segmented__btn" type="button" data-tier="${n}" aria-pressed="false">T${n}</button>`).join('')}
          </div>
          <div class="segmented" role="group" aria-label="Has effect" id="sk-tags">
            <button class="segmented__btn" type="button" data-tag="" aria-pressed="true">Any effect</button>${TAGS.map(([k, l]) => `
            <button class="segmented__btn" type="button" data-tag="${k}" aria-pressed="false">${l}</button>`).join('')}
          </div>
        </div>
        <table class="sk-table">
          <caption class="sr-only">Every Tatari's skill numbers, sortable</caption>
          <thead><tr><th scope="col">Tatari</th>${sortBtn('af', 'Arena Factor', 'AF', true)}${sortBtn('dmg', 'Damage Factor', 'DMG')}${sortBtn('cd', 'Cooldown', 'CD')}</tr></thead>
          <tbody id="sk-rows">${ranked.map((t) => {
  const n = numbers[t.slug];
  const tags = tagsOf(n);
  const v = (x) => num(x) ?? '';
  return `
            <tr data-type="${esc(t.type)}" data-tier="${t.tier}" data-tags="${tags.join(' ')}" data-q="${esc([t.name, skillName(t), ...(n?.sections ?? []).map((s) => s.heading ?? '')].join(' ').toLowerCase())}" data-af="${v(n?.arenaFactor)}" data-dmg="${v(pick(n, 'Damage Factor'))}" data-cd="${v(pick(n, 'Cooldown'))}">
              <th scope="row"><a class="sk-who" href="#${esc(t.slug)}">${art(t, 36)}<span><span class="sk-who__name">${esc(t.name)}</span><span class="sk-who__sub">${typeIcon(t.type, 14)}T${t.tier} · ${esc(skillName(t))}${tags.map((k) => ` <span class="sk-tag">${tagLabel[k]}</span>`).join('')}</span></span></a></th>
              <td class="sk-num">${esc(n?.arenaFactor ?? '–')}</td><td class="sk-num">${esc(pick(n, 'Damage Factor') ?? '–')}</td><td class="sk-num">${esc(pick(n, 'Cooldown') ?? '–')}</td>
            </tr>`;
}).join('')}
          </tbody>
        </table>
      </section>`;

const body = `${START}
    <p class="sk-count" id="sk-count">${ordered.length} lines, ${roster.length} Tatari. Arena Factor multiplies a skill's damage against other Tatari, in Gold Rush and Arena only. Horde Invasion numbers: ${hordeDone} of ${ordered.length} lines so far.</p>
    <div class="sk-app" id="sk-app">
      <div class="sk-lines" id="sk-lines">${index}${detail}
      </div>${rankings}
    </div>
    ${END}`;

const page = readFileSync(PAGE, 'utf8');
const a = page.indexOf(START);
const b = page.indexOf(END);
if (a === -1 || b === -1) throw new Error(`${PAGE} has no ${START} ... ${END} markers`);
// Indentation is a sixth of the page's weight and nobody reads this source by hand.
const next = page.slice(0, a) + body.replace(/\n\s+/g, '\n    ') + page.slice(b + END.length);
if (process.argv.includes('--check')) {
  if (next !== page) { console.error(`${PAGE} is out of date: run node tools/skills-page.mjs`); process.exit(1); }
  console.log(`${PAGE} is up to date`);
} else {
  writeFileSync(PAGE, next);
  console.log(`${PAGE}: ${ordered.length} lines, ${roster.length} Tatari, horde numbers for ${hordeDone}`);
}
