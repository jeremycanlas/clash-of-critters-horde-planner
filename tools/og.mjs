/**
 * Draws the picture Discord shows when somebody pastes a link to this site.
 *
 *   node tools/og.mjs            redraw every page's card into assets/img/og
 *   node tools/og.mjs farm       just one
 *
 * Why it exists: every link to this tool is pasted into a Discord channel, and
 * a link with no card is a grey line of text among cards. The card is the first
 * thing anybody sees of the site, and it was missing entirely.
 *
 * The cards are generated rather than hand-made so they stay true: each one is
 * built from the site's own tokens and its own sprites, at the 1200x630 every
 * scraper crops to, and redrawing them after a redesign is one command.
 *
 * Needs the same Playwright install as tools/screens.mjs -- see its header.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = process.env.SCREENS_TEST_DIR ?? 'E:/caches/iphone-test';
const OUT = path.join(ROOT, 'assets/img/og');
const PORT = 8141;
const only = process.argv.slice(2);

/*
 * What each page promises, in the words somebody scrolling a Discord channel
 * would use. The sprites are picked to say what the page is about without
 * anybody reading the line: the drafter gets a spread, chips gets the chip
 * carriers, the farm gets the fruit Tatari.
 */
const CARDS = [
  {
    name: 'index',
    title: 'Horde Drafter',
    line: 'Plan a Clash of Critters Horde Formation: 242 Tatari, both benches, the level-up order, and a picture to paste in chat.',
    sprites: ['frugantuan', 'pandagrand', 'hypnostrix', 'dagondeep', 'haplysia'],
  },
  {
    name: 'community',
    title: 'Community formations',
    line: 'Builds posted by other players for Clash of Critters Horde.',
    sprites: ['chronerva', 'armorjaw', 'serrabloom', 'voltmare', 'solaflora'],
  },
  {
    name: 'changes',
    title: 'What changed',
    line: 'Every buff and nerf in Clash of Critters Horde for every patch.',
    sprites: ['pyrodaemon', 'frostluna', 'cheerspring', 'sonarbat', 'zenscarab'],
  },
  {
    name: 'chips',
    title: 'Chips',
    line: 'List of chips in Clash of Critters Horde.',
    sprites: ['tikowl', 'bubbit', 'ospisces', 'frugatoad', 'pandaroot'],
  },
  {
    name: 'farm',
    title: 'Cozy Farm rewards',
    line: 'Type your score: every prize you have earned, what the next tier pays, and the glitter fruit past 1.45M.',
    sprites: ['frugagon', 'pandarrior', 'tideon', 'chronerva', 'maskfry'],
  },
  {
    name: 'contribute',
    title: 'Record a range',
    line: 'Contribute to the database of Tatari base skills and horde skills.',
    sprites: ['rockzilla', 'meteorax', 'hellhound', 'boltskipper', 'wobbler'],
  },
];

/** The card, in the site's own type and colours, as a page WebKit can shoot. */
const html = (card, sprites) => `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700..800&family=Instrument+Sans:wght@400;500;600&display=swap">
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; overflow: hidden;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 72px 76px 0;
    background: #14161b;
    color: #e7eaf1;
    font-family: 'Instrument Sans', system-ui, sans-serif;
  }
  .kicker { font-size: 24px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; color: #f0ab00; }
  h1 { margin: 22px 0 0; font-family: 'Bricolage Grotesque', system-ui, sans-serif; font-size: 82px; font-weight: 800; line-height: 1.02; letter-spacing: -.02em; }
  p { margin: 26px 0 0; max-width: 940px; font-size: 30px; line-height: 1.4; color: #a3aab9; }
  .sprites { display: flex; align-items: flex-end; gap: 10px; margin-left: -8px; }
  /* Five of these plus the address is the full 1200 once the padding is taken
     out; any larger and the address is clipped off the right edge. */
  .sprites img { width: 146px; height: 146px; object-fit: contain; }
  .foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding-bottom: 40px; }
  .url { font-size: 22px; font-weight: 600; color: #8f99aa; padding-bottom: 30px; white-space: nowrap; }
</style></head>
<body>
  <div>
    <div class="kicker">Clash of Critters</div>
    <h1>${card.title}</h1>
    <p>${card.line}</p>
  </div>
  <div class="foot">
    <div class="sprites">${sprites.map((src) => `<img src="${src}" alt="">`).join('')}</div>
    <div class="url">jeremycanlas.github.io</div>
  </div>
</body></html>`;

// ------------------------------------------------------------------ draw

let playwright;
try {
  playwright = await import(new URL('node_modules/playwright/index.mjs', `file:///${HARNESS}/`).href);
} catch (e) {
  console.error(`og: the Playwright install is missing at ${HARNESS}\n${e.message}`);
  process.exit(2);
}

const server = spawn('python', ['tools/serve.py', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) {
  try { await fetch(`${base}/index.html`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

mkdirSync(OUT, { recursive: true });
const browser = await playwright.webkit.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

for (const card of CARDS) {
  if (only.length && !only.some((o) => card.name.includes(o))) continue;
  const sprites = card.sprites.map((slug) => `${base}/data/images/tatari/${slug}.png`);
  await page.setContent(html(card, sprites), { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);                    // webfonts, then draw
  const file = path.join(OUT, `${card.name}.png`);
  await page.screenshot({ path: file });
  console.log(`og: ${path.relative(ROOT, file)}`);
}

await browser.close();
server.kill();
