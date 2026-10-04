/**
 * Writes the guide's two data sections from the site's own data.
 *
 *   node tools/guide-page.mjs           rewrite guide.html between its markers
 *   node tools/guide-page.mjs --check   exit 1 if guide.html is out of date
 *
 * The guide says things like "half of all lines keep 50% or less in Arena".
 * Typed by hand, a sentence like that is wrong after the next patch and nobody
 * notices; worked out here from data/skill-numbers.json and
 * data/horde-numbers.json, it is redone with the Skill data page (run this
 * after tools/skills-page.mjs) and --check keeps the two in step.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PAGE = 'guide.html';
const tatari = JSON.parse(readFileSync('data/tatari.json', 'utf8'));
const numbers = JSON.parse(readFileSync('data/skill-numbers.json', 'utf8'));
const horde = JSON.parse(readFileSync('data/horde-numbers.json', 'utf8'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const m = /\d+(\.\d+)?/.exec(v ?? ''); return m ? Number(m[0]) : null; };
const icon = (name) => `<img class="gd-badge" src="data/images/icons/${name.toLowerCase()}.png" alt="${esc(name)}" title="${esc(name)}" width="16" height="16">`;

/* An evolution line: its members lowest tier first, the Arena Factor its skill
   carries (the same on every tier), and the top tier's picture, which is the
   one people recognise. Linked by its first member, as the Skill data list is. */
const lines = Object.values(Object.groupBy(tatari, (t) => t.family)).map((ts) => {
  ts.sort((a, b) => a.tier - b.tier);
  const top = ts.at(-1);
  const af = ts.map((t) => numbers[t.slug]?.arenaFactor).find(Boolean);
  return { family: ts[0].family, first: ts[0], top, af: num(af), afText: af, members: ts };
}).filter((l) => l.af != null);

const tile = (l, value, sub = '') => `<li><a class="gd-tile" href="skills.html#${esc(l.first.slug)}">
<img class="gd-tile__art" src="${esc(l.top.image)}" alt="" width="44" height="44" loading="lazy" decoding="async">
<span class="gd-tile__text"><span class="gd-tile__name">${esc(l.family)}${l.members.length > 1 ? ' line' : ''}</span>
<span class="gd-tile__sub">${icon(l.top.type)}${icon(l.top.role)}${esc(sub || l.top.role)}</span></span>
<span class="gd-tile__val">${esc(value)}</span></a></li>`;

// ------------------------------------------------------------------ Arena Factor

function arena() {
  const sorted = [...lines].sort((a, b) => b.af - a.af || a.family.localeCompare(b.family));
  const values = sorted.map((l) => l.af);
  const median = values[Math.floor(values.length / 2)];
  const atOrBelowHalf = values.filter((v) => v <= 50).length;
  const above100 = sorted.filter((l) => l.af > 100);
  const counts = Object.entries(Object.groupBy(sorted, (l) => l.af)).map(([v, ls]) => [Number(v), ls.length]).sort((a, b) => a[0] - b[0]);
  const most = Math.max(...counts.map(([, n]) => n));
  const byRole = Object.entries(Object.groupBy(sorted, (l) => l.top.role))
    .map(([role, ls]) => [role, Math.round(ls.reduce((s, l) => s + l.af, 0) / ls.length), ls.length])
    .sort((a, b) => b[1] - a[1]);
  const low = byRole.at(-1);
  const high = byRole[0];
  return `<p class="gd-facts"><b>${lines.length} lines</b>, read off the game. The middle one keeps <b>${median}%</b> of its skill damage against
another Tatari. ${atOrBelowHalf} of ${lines.length} keep half or less; ${above100.length === 1 ? `only the ${esc(above100[0].family)} line hits <em>harder</em>` : `${above100.length} lines hit <em>harder</em>`}
(${esc(above100.map((l) => l.afText).join(', '))}).</p>
<figure class="gd-chart">
<figcaption>How many lines keep each Arena Factor</figcaption>
<ul class="gd-bars">${counts.map(([v, n]) => `<li style="--n:${n}; --of:${most}"${v > 100 ? ' class="is-up"' : v <= 30 ? ' class="is-low"' : ''}>
<span class="gd-bars__v">${v}%</span><span class="gd-bars__bar"><span></span></span><span class="gd-bars__n">${n}<span class="sr-only"> line${n === 1 ? '' : 's'}</span></span></li>`).join('')}</ul>
</figure>
<div class="gd-two">
<section><h3>Keep the most</h3><ol class="gd-tiles">${sorted.slice(0, 6).map((l) => tile(l, l.afText)).join('')}</ol></section>
<section><h3>Keep the least</h3><ol class="gd-tiles">${sorted.slice(-6).reverse().map((l) => tile(l, l.afText)).join('')}</ol></section>
</div>
<p class="gd-facts">By role, <b>${esc(low[0])}</b> lines keep the least on average (<b>${low[1]}%</b>, ${low[2]} lines) and
<b>${esc(high[0])}</b> lines the most (<b>${high[1]}%</b>, ${high[2]} lines). A ${esc(low[0])} that tops a Horde board can
fall flat in Arena; check its factor before you bring it.</p>`;
}

// ------------------------------------------------------------------ Horde Invasion

function hordeTop() {
  const byFamily = Object.fromEntries(lines.map((l) => [l.family, l]));
  const rows = (s) => s?.rows ?? [];
  const get = (s, label) => rows(s).find((r) => r[0] === label && r.length < 3)?.[1];
  const hits = Object.entries(horde).map(([fam, lv]) => {
    const s = lv.level7;
    const df = num(get(s, 'Damage Factor'));
    const count = num(get(s, 'Damage Count'));
    const cdMin = get(s, 'Minimum Cooldown') ?? get(s, 'Min Trigger Interval');
    const cdMax = get(s, 'Maximum Cooldown') ?? get(s, 'Max Trigger Interval');
    return { l: byFamily[fam], name: s?.name, df, count, cd: cdMin && cdMax ? `${num(cdMin)}–${num(cdMax)}s` : null };
  }).filter((h) => h.l && h.df).sort((a, b) => b.df - a.df || a.l.family.localeCompare(b.l.family));
  const learned = Object.keys(horde).length;
  return `<p class="gd-facts">Every line learns three Horde Invasion skills, at Lv 3, 5 and 7. All ${learned} lines are on Skill data
with their numbers. The biggest single hits at Lv 7, by Damage Factor:</p>
<ol class="gd-tiles gd-tiles--wide">${hits.slice(0, 8).map((h) => tile(h.l, `${h.df}%${h.count ? ` × ${h.count}` : ''}`,
    `${h.name}${h.cd ? ` · every ${h.cd}` : ''}`)).join('')}</ol>
<p class="gd-note">Damage Factor as the game's panel writes it, per hit; "× 7" is seven hits. A slow, huge hit and a fast
small one can come out even, so the cooldown is there to compare.</p>`;
}

// ------------------------------------------------------------------ write

const blocks = { arena: arena(), horde: hordeTop() };
const page = readFileSync(PAGE, 'utf8');
let next = page;
for (const [name, html] of Object.entries(blocks)) {
  const start = `<!-- guide:${name}:start -->`;
  const end = `<!-- guide:${name}:end -->`;
  const i = next.indexOf(start);
  const j = next.indexOf(end);
  if (i < 0 || j < i) throw new Error(`${PAGE}: no ${start} … ${end}`);
  next = `${next.slice(0, i + start.length)}\n${html}\n${next.slice(j)}`;
}
if (process.argv.includes('--check')) {
  if (next !== page) { console.error(`${PAGE} is out of date: run node tools/guide-page.mjs`); process.exit(1); }
  console.log(`${PAGE}: up to date`);
} else {
  writeFileSync(PAGE, next);
  console.log(`${PAGE}: ${lines.length} lines, ${Object.keys(horde).length} with Horde numbers`);
}
