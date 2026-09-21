/**
 * The site on an iPhone, checked by the engine Safari actually uses.
 *
 *   node tools/iphone.mjs                 every page, both phones, local server
 *   node tools/iphone.mjs farm chips      only pages whose name matches
 *   node tools/iphone.mjs --live          the published site instead
 *   node tools/iphone.mjs --shots         also save a screenshot per page
 *
 * Why this is separate from tools/check.sh: that runs the suites in headless
 * Chrome, which is the right tool for logic and for most layout, and the wrong
 * one for "does it work on an iPhone". Chrome's phone mode only resizes Chrome.
 * The bugs that actually reach an iPhone come from WebKit: a text box zooming in
 * on focus, a sticky header that will not stick, 100vh under the address bar,
 * clipboard refusals. So this drives real WebKit at real iPhone sizes.
 *
 * It needs Playwright and axe-core, which deliberately do NOT live in this
 * repo (no node_modules here, by design). One-time setup, anywhere off C::
 *
 *   mkdir E:/caches/iphone-test && cd E:/caches/iphone-test
 *   npm init -y && npm i playwright axe-core
 *   PLAYWRIGHT_BROWSERS_PATH=E:/caches/ms-playwright npx playwright install webkit
 *
 * Point IPHONE_TEST_DIR somewhere else if you put it elsewhere.
 *
 * What it checks, per page and per phone:
 *
 *   - the page loads without a script error, and without a failed request
 *   - nothing makes the page scroll sideways (the single worst phone bug)
 *   - every text box is at least 16px, or iOS zooms the whole page on focus
 *   - tap targets are big enough: 24px is the WCAG 2.2 AA floor, 44px is
 *     Apple's own guideline, so under 24 fails and under 44 is a warning
 *   - axe-core against WCAG 2.1 A and AA: serious and critical only, because
 *     this is a gate, not a lecture
 *   - the viewport meta says width=device-width and viewport-fit=cover
 *
 * Then a few flows that only mean anything with a finger: picking a Tatari,
 * placing it, opening Share, and typing a score into the farm calculator.
 */

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = process.env.IPHONE_TEST_DIR ?? 'E:/caches/iphone-test';
const SHOT_DIR = process.env.IPHONE_SHOT_DIR ?? 'E:/caches/iphone-shots';
const LIVE = 'https://jeremycanlas.github.io/clash-of-critters-horde-planner';
const PORT = 8139;

const args = process.argv.slice(2);
const live = args.includes('--live');
const shots = args.includes('--shots');
const only = args.filter((a) => !a.startsWith('--'));

/* Both ends of the range people actually hold: the smallest iPhone still on
   iOS 18, and a current one. A layout that survives 375px survives the rest. */
const PHONES = ['iPhone SE', 'iPhone 14'];

const PAGES = [
  { name: 'drafter', url: 'index.html' },
  { name: 'community', url: 'community.html' },
  { name: 'changes', url: 'changes.html' },
  { name: 'chips', url: 'chips.html' },
  { name: 'farm', url: 'farm.html' },
  { name: 'contribute', url: 'contribute.html' },
  { name: 'tracker', url: 'tracker.html' },
];

// ------------------------------------------------------------------ harness

let playwright;
let axeSource;
try {
  playwright = await import(new URL('node_modules/playwright/index.mjs', `file:///${HARNESS}/`).href);
  axeSource = readFileSync(path.join(HARNESS, 'node_modules/axe-core/axe.min.js'), 'utf8');
} catch (e) {
  console.error(`iphone: the test harness is missing at ${HARNESS}\n${e.message}\n`
    + 'See the setup lines at the top of this file.');
  process.exit(2);
}
const { webkit, devices } = playwright;

const fails = [];
const warns = [];
const fail = (where, text) => { fails.push(`${where}: ${text}`); };
const warn = (where, text) => { warns.push(`${where}: ${text}`); };

// ------------------------------------------------------------------ server

/* The same static server the suites use. Skipped for --live. */
let server = null;
const base = live ? LIVE : `http://127.0.0.1:${PORT}`;
if (!live) {
  server = spawn('python', ['tools/serve.py', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/index.html`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}
const stop = () => server?.kill();

// ------------------------------------------------------------------ checks

/** Everything a finger can hit, and how big it is. */
const TAPPABLE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])';

async function checkPage(page, where) {
  // Sideways scroll. One pixel of slack: sub-pixel widths round up.
  const scroll = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    widest: (() => {
      let worst = null, w = 0;
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w) { w = r.right; worst = el; }
      }
      return worst ? `${worst.tagName.toLowerCase()}.${worst.className.toString().split(' ')[0]} reaches ${Math.round(w)}px` : '';
    })(),
  }));
  if (scroll.doc > scroll.win + 1) fail(where, `scrolls sideways: ${scroll.doc}px of content in ${scroll.win}px — ${scroll.widest}`);

  // A text box under 16px makes iOS zoom the page in when it is tapped, and
  // nothing zooms back out. Selects and date inputs do it too.
  const small = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'range' || el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;             // the sliver behind a styled label
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.opacity === '0' || style.clipPath !== 'none') continue;
      const size = parseFloat(style.fontSize);
      if (size < 15.95) out.push(`${el.id || el.name || el.type} at ${size}px`);
    }
    return out;
  });
  if (small.length) fail(where, `text boxes under 16px, so iOS zooms in on tap: ${small.join(', ')}`);

  // Tap targets.
  const taps = await page.evaluate((sel) => {
    /* A checkbox or a file input is usually a sliver behind a label people
       press instead, and WCAG 2.5.8 exempts a link sitting in a sentence,
       because shrinking it would mean re-writing the sentence. */
    const hitBox = (el) => {
      const own = el.getBoundingClientRect();
      const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (!label) return own;
      const r = label.getBoundingClientRect();
      return r.width * r.height > own.width * own.height ? r : own;
    };
    const inRunningText = (el) => {
      if (!el.matches('a, summary')) return false;
      const p = el.parentElement;
      if (!p) return false;
      if (getComputedStyle(el).display !== 'inline') return false;
      return p.textContent.trim().length > el.textContent.trim().length + 3;
    };
    const tiny = [], small = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = hitBox(el);
      if (!r.width || !r.height) continue;                   // hidden or collapsed
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.opacity === '0') continue;
      if (inRunningText(el)) continue;
      const name = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${el.className.toString().split(' ')[0] || ''}`
        + (el.textContent?.trim() ? ` "${el.textContent.trim().slice(0, 18)}"` : '');
      const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (r.width < 24 || r.height < 24) tiny.push(`${name} ${size}`);
      else if (r.width < 44 || r.height < 44) small.push(`${name} ${size}`);
    }
    return { tiny: [...new Set(tiny)], small: [...new Set(small)] };
  }, TAPPABLE);
  if (taps.tiny.length) fail(where, `tap targets under 24px: ${taps.tiny.slice(0, 6).join(', ')}${taps.tiny.length > 6 ? ` +${taps.tiny.length - 6} more` : ''}`);
  if (taps.small.length) warn(where, `under Apple's 44px: ${taps.small.slice(0, 6).join(', ')}${taps.small.length > 6 ? ` +${taps.small.length - 6} more` : ''}`);

  // The viewport meta. Without viewport-fit=cover the page stops at the notch.
  const meta = await page.getAttribute('meta[name="viewport"]', 'content');
  if (!meta?.includes('width=device-width')) fail(where, 'viewport meta is missing width=device-width');
  if (!meta?.includes('viewport-fit=cover')) warn(where, 'viewport meta has no viewport-fit=cover');

  // axe-core. Serious and critical only: those are the ones that stop somebody.
  await page.addScriptTag({ content: axeSource });
  const axe = await page.evaluate(async () => {
    const res = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'],
    });
    return res.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => {
        const why = (v.nodes[0].any?.[0]?.message ?? v.help).replace(/\s+/g, ' ');
        return `${v.id} (${v.nodes.length}) — ${v.nodes[0].target.join(' ')} — ${why}`;
      });
  });
  for (const v of axe) fail(where, `accessibility: ${v}`);

  if (shots) {
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `${where.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: false });
  }
}

/* The parts a finger has to get through, not just look at. */
async function checkFlows(page, name, where) {
  if (name === 'drafter') {
    /* The path most of the traffic takes, and the one a mouse never tests:
       card, bench chip, square. Three taps, each on a different screen. */
    const sheet = page.locator('.appbar__btn[data-sheet="roster"]');
    if (await sheet.isVisible().catch(() => false)) await sheet.tap();
    const card = page.locator('.panel--roster .card').first();
    await card.tap();
    if (!/[1-9]/.test(await page.locator('#appbar-bench').textContent() ?? '')) {
      fail(where, 'tapping a roster card did not bench it');
      return;
    }
    if (await sheet.isVisible().catch(() => false)) await sheet.tap();   // back to the field

    const chip = page.locator('.benchchip').first();
    if (!(await chip.isVisible().catch(() => false))) { fail(where, 'the benched Tatari has no chip under the field'); return; }
    await chip.tap();
    const cell = page.locator('.cell:not(.cell--enemy)').filter({ hasNot: page.locator('.token') }).first();
    await cell.tap();
    if (!/[1-9]/.test(await page.locator('#appbar-field').textContent() ?? '')) fail(where, 'tapping a square did not place it');

    // Share lives on the app bar down here, not in the header.
    const share = page.locator('.appbar__btn[data-action="share"], #btn-share').filter({ visible: true }).first();
    await share.tap();
    const open = await page.locator('dialog[open], .modal.is-open, #share:visible').first().isVisible().catch(() => false);
    if (!open) fail(where, 'Share did not open');
  }
  if (name === 'farm') {
    await page.locator('#farm-score').fill('317k');
    await page.waitForTimeout(150);
    const text = await page.locator('body').innerText();
    if (!/pinball/i.test(text)) fail(where, 'a score of 317k showed no prizes');
  }
  if (name === 'tracker') {
    // Live, this page must show nothing to a stranger. Locally it is test mode.
    if (live) {
      const gate = await page.locator('#tr-gate').isVisible();
      const app = await page.locator('#tr-app').isVisible();
      if (!gate || app) fail(where, 'the private page showed something to a signed-out visitor');
    }
  }
}

// ------------------------------------------------------------------ run

const browser = await webkit.launch();
const started = Date.now();

for (const phone of PHONES) {
  for (const p of PAGES) {
    if (only.length && !only.some((o) => p.name.includes(o))) continue;
    const where = `${p.name} on ${phone}`;
    const context = await browser.newContext({ ...devices[phone] });
    const page = await context.newPage();
    const noise = [];
    page.on('pageerror', (e) => noise.push(`script error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') noise.push(`console: ${m.text().slice(0, 160)}`); });
    page.on('requestfailed', (r) => {
      // A blocked counter or an absent local-only data file is not this site's bug.
      if (/goatcounter|zgo\.at|tracker\.local\.json/.test(r.url())) return;
      noise.push(`request failed: ${r.url().replace(base, '')}`);
    });

    try {
      await page.goto(`${base}/${p.url}`, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(700);           // let the app draw itself
      await checkPage(page, where);
      await checkFlows(page, p.name, where);
    } catch (e) {
      fail(where, `did not get through: ${e.message.split('\n')[0]}`);
    }
    for (const n of noise) fail(where, n);
    await context.close();
    process.stdout.write('.');
  }
}

await browser.close();
stop();

// ------------------------------------------------------------------ report

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n\niPhone sweep: ${live ? LIVE : 'local'}, WebKit, ${PHONES.join(' and ')}, ${secs}s`);
if (warns.length) {
  console.log(`\n  ${warns.length} warning${warns.length === 1 ? '' : 's'}`);
  for (const w of warns) console.log(`   ~ ${w}`);
}
if (fails.length) {
  console.log(`\n  ${fails.length} failure${fails.length === 1 ? '' : 's'}`);
  for (const f of fails) console.log(`   x ${f}`);
  console.log('\niphone: FAILED');
  process.exit(1);
}
console.log(shots ? `\niphone: ok (screenshots in ${SHOT_DIR})` : '\niphone: ok');
