/**
 * Writes the Skill data page's content from data/skill-numbers.json.
 *
 *   node tools/skills-page.mjs           rewrite skills.html between its markers
 *   node tools/skills-page.mjs --check   exit 1 if skills.html is out of date
 *
 * Static HTML rather than drawn in script, because the page exists to be found:
 * search engines bring most of the people who arrive from anywhere, and these
 * numbers are on no other site. Everything is written here, every line and every
 * tier; assets/js/skills.js only picks which part shows.
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
const hordeOverrides = (() => { try { return JSON.parse(readFileSync('data/horde-overrides.json', 'utf8')); } catch { return {}; } })();
const hordeNumbers = (() => { try { return JSON.parse(readFileSync('data/horde-numbers.json', 'utf8')); } catch { return {}; } })();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* The drafter's own badges (app.css .badge): the game's type disc and role plate. */
// alt is empty where the name is written beside it anyway.
const badge = (name, alt = name) => `<span class="badge" title="${esc(name)}"><img class="icon__art" src="data/images/icons/${esc(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}.png" alt="${esc(alt)}" width="17" height="17"></span>`;
// The roster card's meta row: tier, then type and role.
const meta = (tierText, t, roleAlt = t.role) => `<span class="sk-meta"><span class="card__tier">${tierText}</span>${badge(t.type)}${badge(t.role, roleAlt)}</span>`;
const art = (t, size) => `<img class="sk-art" src="${esc(t.image)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
// The first number in a panel value, for sorting: "130%" 130, "4s After Dance Ends" 4.
const num = (v) => { const m = /\d+(\.\d+)?/.exec(v ?? ''); return m ? Number(m[0]) : null; };
const skillName = (t) => numbers[t.slug]?.skill ?? (t.skill ?? '').split(':')[0];
const skillDesc = (t) => t.skill?.includes(':') ? t.skill.slice(t.skill.indexOf(':') + 1).trim() : '';

/* The skill's own rows are the box with no heading. */
const base = (n) => n?.sections?.find((s) => !s.heading)?.rows ?? [];
const pick = (n, label) => base(n).find(([l]) => l === label)?.[1];

/* A row can carry what it was at the tier below ("was 120%") or be new there.
   Each label and value pair is wrapped, so it can be one of the game's pills. */
const rows = (list) => !list.length ? '' : `<dl class="sk-rows">${list.map(([label, value, mark]) =>
  // A row too long to share its line with another takes the whole width.
  `<div class="sk-row${String(label).length + String(value).length + (mark && mark !== 'new' ? String(mark).length + 4 : 0) > 30 ? ' sk-row--wide' : ''}"><dt>${esc(label)}${mark === 'new' ? ' <span class="sk-new">new</span>' : ''}</dt><dd>${
    mark && mark !== 'new' ? `<span class="sk-was">was ${esc(mark)}</span>` : ''}${esc(value)}</dd></div>`).join('')}</dl>`;

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

/* The game's skill panel: an icon, the skill's name and what it does, then an
   inset list of its numbers and its effect boxes. The icon is the Tatari with
   its tier as the roman numeral the game puts on a skill's icon. */
const ROMAN = ['', 'I', 'II', 'III', 'IV'];
const icon = (t, size, numeral) => `<span class="sk-icon">${art(t, size)}${numeral ? `<span class="sk-numeral" aria-hidden="true">${numeral}</span>` : ''}</span>`;
const panelHead = (ic, name, desc, h, extra = '') => `
            <div class="sk-panel__head">${ic}
              <div class="sk-panel__title"><${h} class="sk-skill">${esc(name)}</${h}>${desc ? `<p class="sk-desc">${esc(desc)}</p>` : ''}</div>${extra}
            </div>`;
const box = (title, text, body, cls = '', badge = '') => `
              <section class="sk-box${cls}">
                <h5 class="sk-box__title">${esc(title)}${badge}</h5>
                ${text ? `<p class="sk-box__text">${esc(text)}</p>` : ''}${body}
              </section>`;
const AF_TEXT = 'Multiplies the skill\'s base damage when it hits another Tatari. Gold Rush and Arena only.';

/* One tier of a line: the Tatari, then its skill panel. */
function tier(t, line, i) {
  const n = numbers[t.slug];
  const below = line.slice(0, i).reverse().find((x) => numbers[x.slug]?.sections);
  const prev = n?.sections && below ? numbers[below.slug].sections : null;
  const boxes = (n?.sections ?? []).filter((s) => s.heading).map((s) => {
    const fresh = prev && !prev.some((p) => key(p) === key(s));
    return box(s.heading, s.text, rows(fresh ? s.rows : mark(s, prev)), fresh ? ' sk-box--new' : '', fresh ? ` <span class="sk-new">New at T${t.tier}</span>` : '');
  });
  if (n?.arenaFactor) boxes.push(box('Arena Factor', AF_TEXT, rows([['Arena Factor', n.arenaFactor]]), ' sk-box--af'));
  return `
        <section class="sk-tier" id="${esc(t.slug)}" data-tier="${t.tier}" aria-label="${esc(t.name)}, tier ${t.tier}">
          <h3 class="sk-tier__name">${esc(t.name)} <span class="sk-tier__tags"><span class="tag">${badge(t.type, '')}${esc(t.type)}</span><span class="tag">${badge(t.role, '')}${esc(t.role)}</span><span class="tag">T${t.tier} of ${line.length}</span></span></h3>
          <div class="sk-panel">${panelHead(icon(t, 64, ROMAN[t.tier]), skillName(t), skillDesc(t), 'h4')}
            <div class="sk-list">
              ${n?.sections ? rows(mark({ heading: null, rows: base(n) }, prev)) : '<p class="sk-none">The rest of this skill panel is not recorded yet.</p>'}${boxes.length ? `
              <div class="sk-boxes">${boxes.join('')}
              </div>` : ''}
            </div>
          </div>
        </section>`;
}

/* Horde Invasion's level 3, 5 and 7 skills belong to the whole line. Their
   numbers are grouped by effect box: rows carry the box's name third. */
const LEVELS = [['level3', 3], ['level5', 5], ['level7', 7]];
function hordeRows(list) {
  if (!list?.length) return '<p class="sk-none">Numbers not recorded yet</p>';
  const groups = [];
  for (const [label, value, b] of list) {
    const last = groups.at(-1);
    if (last && last.box === b) last.rows.push([label, value]);
    else groups.push({ box: b, rows: [[label, value]] });
  }
  return groups.map((g) => g.box ? box(g.box, '', rows(g.rows)) : rows(g.rows)).join('');
}
// The game's padlock beside a level a Tatari has not reached.
const LOCK = '<svg class="sk-lock" viewBox="0 0 12 14" width="11" height="13" aria-hidden="true"><path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="1" y="6" width="10" height="8" rx="2" fill="currentColor"/></svg>';
function horde(line) {
  // A line the wiki has no Horde skills for yet takes them from data/horde-overrides.json, read off the game.
  const h = line[0].hordeSkills ?? hordeOverrides[line[0].family];
  if (!h) return `
          <p class="sk-none">Horde Invasion skills not recorded yet.</p>`;
  return `
          <section class="sk-horde" aria-label="Horde Invasion skills">
            <h3 class="sk-horde__title">Horde Invasion <span>the whole line learns these as it levels up</span></h3>
            <ol class="sk-levels">${LEVELS.filter(([k]) => h[k]).map(([k, lv]) => `
              <li class="sk-level sk-panel">${panelHead(icon(line.at(-1), 40), h[k].name, h[k].text, 'h4', `<p class="sk-lv">${LOCK}Lvl ${lv}</p>`)}
                <div class="sk-list">${hordeRows(hordeNumbers[line[0].family]?.[k]?.rows)}</div>
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
  .concat(Object.values(line[0].hordeSkills ?? hordeOverrides[line[0].family] ?? {}).filter((h) => h?.name).map((h) => h.name)))].join(' ').toLowerCase();
const hordeDone = ordered.filter((l) => hordeNumbers[l[0].family]).length;

const index = `
      <nav class="sk-index panel" aria-label="Evolution lines">
        <div class="panel__head"><h2>Lines <span class="muted" id="sk-lines-n">${ordered.length}</span></h2>
          <span class="sk-index__key" title="In Gold Rush and Arena, a skill's damage against another Tatari is multiplied by its Arena Factor">% = Arena Factor</span></div>
        <ol class="sk-index__list" id="sk-list">${ordered.map((line) => {
  const top = line.at(-1);
  return `
          <li class="sk-index__item" data-type="${esc(top.type)}" data-q="${esc(lineQ(line))}">
            <a class="sk-pick" href="#${esc(line[0].slug)}" data-line="line-${line[0].familyId}">
              ${art(top, 40)}
              <span class="sk-pick__text">
                <span class="sk-pick__name">${esc(line[0].family)}</span>
                <span class="sk-pick__sub">${meta(`T1–T${top.tier}`, top, '')}${esc(top.role)}</span>
              </span>
              <span class="sk-pick__af" title="Arena Factor: in Gold Rush and Arena, this line's skill damage against another Tatari is multiplied by this"><span class="sk-pick__aflabel">Arena</span>${esc(lineAF(line) ?? '–')}</span>
            </a>
          </li>`;
}).join('')}
        </ol>
      </nav>`;

const detail = `
      <div class="sk-detail" id="sk-detail">${ordered.map((line) => `
        <article class="sk-line panel" id="line-${line[0].familyId}" data-type="${esc(line.at(-1).type)}">
          <header class="sk-line__head panel__head">
            <button class="sk-back btn" type="button" data-back>All lines</button>
            <h2 class="sk-line__name">${esc(line[0].family)} line</h2>
            <div class="sk-switch" role="group" aria-label="Tier">${line.map((t) => `
              <button class="sk-switch__btn" type="button" data-slug="${esc(t.slug)}" aria-pressed="false">${art(t, 36)}<span class="sk-switch__text">${meta(`T${t.tier}`, t)}<span class="sk-switch__name">${esc(t.name)}</span></span></button>`).join('')}
            </div>
          </header>${line.map((t, i) => tier(t, line, i)).join('')}${horde(line)}
        </article>`).join('')}
      </div>`;

const body = `${START}
    <p class="sk-count" id="sk-count">${ordered.length} lines, ${roster.length} Tatari. Arena Factor multiplies a skill's damage against other Tatari, in Gold Rush and Arena only. Horde Invasion numbers: ${hordeDone} of ${ordered.length} lines so far.</p>
    <div class="sk-app" id="sk-app">
      <div class="sk-lines" id="sk-lines">${index}${detail}
      </div>
    </div>
    ${END}`;

const page = readFileSync(PAGE, 'utf8');
const a = page.indexOf(START);
const b = page.indexOf(END);
if (a === -1 || b === -1) throw new Error(`${PAGE} has no ${START} ... ${END} markers`);
// Indentation is a sixth of the page's weight and nobody reads this source by hand.
const next = page.slice(0, a) + body.replace(/\n\s+/g, '\n') + page.slice(b + END.length);
if (process.argv.includes('--check')) {
  if (next !== page) { console.error(`${PAGE} is out of date: run node tools/skills-page.mjs`); process.exit(1); }
  console.log(`${PAGE} is up to date`);
} else {
  writeFileSync(PAGE, next);
  console.log(`${PAGE}: ${ordered.length} lines, ${roster.length} Tatari, horde numbers for ${hordeDone}`);
}
