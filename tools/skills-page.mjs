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
const art = (t, size) => `<img src="${esc(t.image)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
const rows = (list) => `<dl class="sk__rows">${list.map(([label, value]) =>
  `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;

function card(t, n) {
  const sections = (n.sections ?? []).map((s) => `
        ${s.heading ? `<h4 class="sk__heading">${esc(s.heading)}</h4>` : ''}
        ${s.text ? `<p class="sk__text">${esc(s.text)}</p>` : ''}
        ${rows(s.rows)}`).join('');
  const skill = n.skill ?? (t.skill ? t.skill.split(':')[0] : '');
  return `
    <li class="sk" id="${esc(t.slug)}" ${attrs(t)}>
      <div class="sk__head">
        ${art(t, 56)}
        <div>
          <h3 class="sk__name">${esc(t.name)}</h3>
          <p class="sk__meta">T${t.tier} ${esc(t.type)} ${esc(t.role)}${skill ? ` · <b>${esc(skill)}</b>` : ''}</p>
        </div>
        ${n.arenaFactor ? `<span class="sk__arena" title="Gold Rush and Arena: the skill's damage against another Tatari is multiplied by this">
          <small>Arena Factor</small>${esc(n.arenaFactor)}</span>` : ''}
      </div>
      ${sections || '<p class="sk__text sk__partial">Only its Arena Factor is recorded so far.</p>'}
    </li>`;
}

const recorded = roster.filter((t) => numbers[t.slug]);
const missing = roster.filter((t) => !numbers[t.slug]);
// Fullest first: a whole panel is more use to a reader than an Arena Factor alone.
recorded.sort((a, b) => (numbers[b.slug].sections ? 1 : 0) - (numbers[a.slug].sections ? 1 : 0));

const body = `${START}
    <p class="sk__count" id="sk-count">${recorded.length} of ${roster.length} Tatari recorded, ${
  recorded.filter((t) => numbers[t.slug].sections).length} with every number.</p>
    <ol class="sk__list" id="sk-list">${recorded.map((t) => card(t, numbers[t.slug])).join('')}
    </ol>
    <section class="panel sk__missing">
      <h2>Not recorded yet <span class="muted" id="sk-missing-n">${missing.length}</span></h2>
      <ul class="sk__names" id="sk-names">${missing.map((t) => `
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
