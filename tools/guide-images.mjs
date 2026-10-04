/**
 * Draws the guide's pictures for Discord, from the site's own data.
 *
 *   node tools/guide-images.mjs      writes docs/media/guide/*.png
 *
 * A Discord guide is read in the channel, on a phone, without opening a link:
 * a picture that carries the whole point does more there than any page. These
 * are drawn from data/skill-numbers.json and data/horde-numbers.json, so they
 * are redrawn after a patch with one command, like the link cards (tools/og.mjs).
 *
 * 1080 wide, the width Discord shows a phone picture at without scaling it down.
 * Needs the same Playwright install as tools/screens.mjs -- see its header.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = process.env.SCREENS_TEST_DIR ?? 'E:/caches/iphone-test';
const OUT = path.join(ROOT, 'docs/media/guide');
const PORT = 8142;

const read = (f) => JSON.parse(readFileSync(path.join(ROOT, f), 'utf8'));
const tatari = read('data/tatari.json');
const numbers = read('data/skill-numbers.json');
const horde = read('data/horde-numbers.json');
const num = (v) => { const m = /\d+(\.\d+)?/.exec(v ?? ''); return m ? Number(m[0]) : null; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Each line, by its top tier's picture (the one people know) and its first member's name.
const lines = Object.values(Object.groupBy(tatari, (t) => t.family)).map((ts) => {
  ts.sort((a, b) => a.tier - b.tier);
  return { family: ts[0].family, top: ts.at(-1), af: num(ts.map((t) => numbers[t.slug]?.arenaFactor).find(Boolean)) };
}).filter((l) => l.af != null);

const TYPE = { Fire: '#e8453c', Water: '#37a7e6', Grass: '#57c14a', Lightning: '#f2be16', Rock: '#a2762f' };
const shell = (body, extra = '') => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700..800&family=Instrument+Sans:wght@400;500;600;700&display=swap">
<style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1080px; padding: 64px 56px 48px; background: #14161b; color: #e7eaf1; font-family: 'Instrument Sans', system-ui, sans-serif; }
  .kicker { font-size: 22px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; color: #f0ab00; }
  h1 { margin: 14px 0 0; font-family: 'Bricolage Grotesque', system-ui, sans-serif; font-size: 64px; font-weight: 800; line-height: 1.04; letter-spacing: -.02em; }
  .lead { margin: 18px 0 0; font-size: 26px; line-height: 1.4; color: #a3aab9; }
  .lead b { color: #e7eaf1; }
  .foot { display: flex; justify-content: space-between; margin-top: 40px; padding-top: 22px; border-top: 2px solid #2a2f3a; font-size: 20px; color: #8f99aa; }
  .foot b { color: #e7eaf1; }
  img.s { object-fit: contain; display: block; }
  ${extra}
</style></head><body>${body}
<div class="foot"><span>Read off the game · Horde Drafter</span><b>jeremycanlas.github.io/clash-of-critters-horde-planner</b></div>
</body></html>`;

// ------------------------------------------------------------------ Arena Factor, every line

function arena(base) {
  const groups = Object.entries(Object.groupBy(lines, (l) => l.af)).map(([v, ls]) => [Number(v), ls.sort((a, b) => a.family.localeCompare(b.family))])
    .sort((a, b) => b[0] - a[0]);
  const median = [...lines].sort((a, b) => a.af - b.af)[Math.floor(lines.length / 2)].af;
  const colour = (v) => (v > 100 ? '#6fe0a4' : v >= 60 ? '#f0ab00' : v >= 40 ? '#e7a54b' : '#ff8a72');
  return shell(`<div class="kicker">Clash of Critters · Gold Rush & Arena</div>
<h1>Arena Factor, every line</h1>
<p class="lead">When a skill hits <b>another Tatari</b>, its damage is multiplied by this. Most lines keep about <b>${median}%</b>.
Horde is not affected.</p>
<div class="rows">${groups.map(([v, ls]) => `<div class="row"><div class="v" style="color:${colour(v)}">${v}%</div>
<div class="ls">${ls.map((l) => `<div class="l"><img class="s" src="${base}/${esc(l.top.image)}" width="64" height="64" alt="">
<span style="--t:${TYPE[l.top.type] ?? '#888'}">${esc(l.family)}</span></div>`).join('')}</div></div>`).join('')}</div>`,
  `.rows { margin-top: 36px; display: flex; flex-direction: column; gap: 6px; }
   .row { display: grid; grid-template-columns: 128px 1fr; align-items: center; gap: 16px; padding: 10px 0; border-top: 1px solid #232833; }
   .v { font-family: 'Bricolage Grotesque', system-ui, sans-serif; font-size: 44px; font-weight: 800; text-align: right; }
   .ls { display: flex; flex-wrap: wrap; gap: 6px 4px; }
   .l { width: 104px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
   .l span { font-size: 15px; font-weight: 600; color: #c9cfdb; white-space: nowrap; border-bottom: 3px solid var(--t); padding-bottom: 1px; }`);
}

// ------------------------------------------------------------------ Horde Lv 7, the biggest hits

function hordeTop(base) {
  const byFamily = Object.fromEntries(lines.map((l) => [l.family, l]));
  const get = (s, label) => (s?.rows ?? []).find((r) => r[0] === label && r.length < 3)?.[1];
  const hits = Object.entries(horde).map(([fam, lv]) => {
    const s = lv.level7;
    const lo = num(get(s, 'Minimum Cooldown') ?? get(s, 'Min Trigger Interval'));
    const hi = num(get(s, 'Maximum Cooldown') ?? get(s, 'Max Trigger Interval'));
    return { l: byFamily[fam], name: s?.name, df: num(get(s, 'Damage Factor')), count: num(get(s, 'Damage Count')), cd: lo && hi ? `${lo}–${hi}s` : '' };
  }).filter((h) => h.l && h.df).sort((a, b) => b.df - a.df || a.l.family.localeCompare(b.l.family)).slice(0, 10);
  return shell(`<div class="kicker">Clash of Critters · Horde Invasion</div>
<h1>The 10 biggest Lv 7 hits</h1>
<p class="lead">Damage Factor of each line's Lv 7 Horde skill, as the game's panel shows it. The whole line learns it.</p>
<ol class="hits">${hits.map((h, i) => `<li><span class="n">${i + 1}</span><img class="s" src="${base}/${esc(h.l.top.image)}" width="92" height="92" alt="">
<span class="who"><b>${esc(h.l.family)} line</b><span>${esc(h.name)}${h.cd ? ` · every ${h.cd}` : ''}</span></span>
<span class="df">${h.df}%${h.count ? `<small> × ${h.count}</small>` : ''}</span></li>`).join('')}</ol>`,
  `.hits { list-style: none; padding: 0; margin-top: 36px; display: flex; flex-direction: column; gap: 10px; }
   .hits li { display: grid; grid-template-columns: 48px 92px 1fr auto; align-items: center; gap: 18px; padding: 10px 22px 10px 14px; border-radius: 18px; background: #1c1f27; border: 1px solid #2a2f3a; }
   .n { font-family: 'Bricolage Grotesque', system-ui, sans-serif; font-size: 30px; font-weight: 800; color: #8f99aa; text-align: center; }
   .who { display: flex; flex-direction: column; gap: 4px; }
   .who b { font-size: 30px; }
   .who span { font-size: 21px; color: #a3aab9; }
   .df { font-family: 'Bricolage Grotesque', system-ui, sans-serif; font-size: 46px; font-weight: 800; color: #f0ab00; white-space: nowrap; }
   .df small { font-size: 28px; color: #e7eaf1; }`);
}

// ------------------------------------------------------------------ draw

let playwright;
try {
  playwright = await import(new URL('node_modules/playwright/index.mjs', `file:///${HARNESS}/`).href);
} catch (e) {
  console.error(`guide-images: the Playwright install is missing at ${HARNESS}\n${e.message}`);
  process.exit(2);
}
const server = spawn('python', ['tools/serve.py', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) {
  try { await fetch(`${base}/index.html`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
mkdirSync(OUT, { recursive: true });
const browser = await playwright.webkit.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
for (const [name, draw] of [['arena-factor', arena], ['horde-lv7', hordeTop]]) {
  await page.setContent(draw(base), { waitUntil: 'networkidle' });
  await page.waitForTimeout(400); // webfonts, then draw
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`guide-images: ${path.relative(ROOT, file)}`);
}
await browser.close();
server.kill();
