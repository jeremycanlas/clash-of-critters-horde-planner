/**
 * Screenshots of the site for the Discord guide (docs/discord-guide.md).
 *
 *   node tools/guide-images.mjs       the two data pictures, first
 *   node tools/guide-shots.mjs 1      writes assets/img/guide/discord/<name>-v1.png
 *
 * The guide's pictures are links to these files on the live site rather than
 * attachments, because Discord lets a message's text be edited but not its
 * pictures. After the site changes: run this again with the next number, push,
 * and swap "-v1" for "-v2" in the posts. A new name, not the same one
 * overwritten, because Discord keeps showing the picture it fetched first.
 *
 * The formation shown is the Community's top build, opened in the drafter as
 * anyone would open it. Phone sized (iPhone 13 at 2x), dark theme.
 * Needs the same Playwright install as tools/screens.mjs -- see its header.
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = process.env.SCREENS_TEST_DIR ?? 'E:/caches/iphone-test';
const OUT = path.join(ROOT, 'assets/img/guide/discord');
const PORT = 8143;
const v = process.argv[2];
if (!/^\d+$/.test(v ?? '')) { console.error('usage: node tools/guide-shots.mjs <version number>'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const { chromium, devices } = await import(new URL('node_modules/playwright/index.mjs', `file:///${HARNESS}/`).href);
const server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const site = `http://127.0.0.1:${PORT}`;
const patch = JSON.parse(readFileSync(path.join(ROOT, 'data/changes.json'), 'utf8')).patch ?? 'unknown';

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' });
// A first visit's own notices (the patch note, the "Share it?" nudge) are not what the guide is showing.
await ctx.addInitScript((p) => {
  localStorage.setItem('coc.patch-seen', p);
  localStorage.setItem('coc.share-nudged', '1');
}, patch);
await ctx.route(/goatcounter/, (r) => r.abort());
const page = await ctx.newPage();
const shot = async (name, target = page) => {
  await page.waitForTimeout(400); // fonts and pictures settle
  await target.screenshot({ path: path.join(OUT, `${name}-v${v}.png`) });
  console.log(`  ${name}-v${v}.png`);
};

// The Community's top build: the gallery, then the build in the drafter.
await page.goto(`${site}/community.html`);
await page.waitForSelector('a[data-open]', { timeout: 30000 });
await shot('community');
const top = await page.locator('a[data-open]').first().getAttribute('href');

await page.goto(`${site}/${top}`);
await page.waitForSelector('#grid .cell, #grid [data-cell]', { timeout: 30000 });
await page.waitForTimeout(800);
await shot('drafter-top');
// The field on its own, as "Just the grid" leaves it for a screenshot; any tap brings the rest back.
await page.locator('.bench__clean[data-clean]').first().click();
await page.waitForTimeout(800);
// The board's own card: the smallest box around the field that also holds its title.
const card = await page.evaluate(() => {
  let e = document.querySelector('#grid');
  while (e.parentElement && !/zobos spawn/i.test(e.textContent)) e = e.parentElement;
  const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
await page.screenshot({ path: path.join(OUT, `drafter-v${v}.png`),
  clip: { x: Math.max(0, card.x - 8), y: Math.max(0, card.y - 8), width: card.width + 16, height: card.height + 16 } });
console.log(`  drafter-v${v}.png`);
await page.evaluate(() => document.body.classList.remove('is-clean'));
await page.waitForTimeout(400);

// Plan and Summary, from the phone's app bar.
for (const sheet of ['priority', 'summary']) {
  await page.click(`.appbar__btn[data-sheet="${sheet}"]`);
  await page.waitForTimeout(600);
  await shot(sheet === 'priority' ? 'plan' : 'summary');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// Share, from the app bar.
await page.click('.appbar__btn[data-action="share"]');
await page.waitForSelector('#share[open]');
await page.waitForTimeout(800);
await shot('share', page.locator('#share'));
await page.click('#share-close');

// Live: the Formation menu, then the dialog it opens.
await page.click('#formation-menu summary');
await page.waitForTimeout(300);
// The button and its first item: the menu runs off the bottom of a phone's header.
const a = await page.locator('#formation-menu summary').boundingBox();
const b = await page.locator('#btn-live').boundingBox();
const x = Math.min(a.x, b.x) - 12;
await page.screenshot({ path: path.join(OUT, `formation-menu-v${v}.png`),
  clip: { x, y: a.y - 12, width: Math.max(a.x + a.width, b.x + b.width) - x + 12, height: b.y + b.height - a.y + 24 } });
console.log(`  formation-menu-v${v}.png`);
await page.click('#btn-live');
await page.waitForSelector('#dlg-live[open]');
await page.locator('#dlg-live h2').first().click(); // not with the name box lit
await shot('live', page.locator('#dlg-live'));
await page.keyboard.press('Escape');

// Skill data: one line open, and a search by animal.
await page.goto(`${site}/skills.html#glowfly`);
await page.waitForSelector('.sk-line.is-on');
await shot('skills');
await page.goto(`${site}/skills.html`);
await page.fill('#sk-find', 'dolphin');
await shot('skills-search');

await browser.close();
server.kill();

// And the two data pictures tools/guide-images.mjs draws (run it first), under the same version.
for (const name of ['arena-factor', 'horde-lv7']) {
  copyFileSync(path.join(ROOT, 'docs/media/guide', `${name}.png`), path.join(OUT, `${name}-v${v}.png`));
  console.log(`  ${name}-v${v}.png`);
}
