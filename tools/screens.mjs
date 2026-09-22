/**
 * The site on the three screens people actually hold, in the engine Safari runs.
 *
 *   node tools/screens.mjs                every screen, every page, local server
 *   node tools/screens.mjs phone          only that screen (phone, tablet, desktop)
 *   node tools/screens.mjs farm chips     only pages whose name matches
 *   node tools/screens.mjs --live         the published site instead
 *   node tools/screens.mjs --shots        also save a screenshot of each
 *   node tools/screens.mjs --quick        one size per screen, for the hook
 *
 * Why this is separate from tools/check.sh: that runs the suites in headless
 * Chrome, which is the right tool for logic and for most layout, and the wrong
 * one for "does it work on a phone". Chrome's phone mode only resizes Chrome.
 * The bugs that actually reach an iPhone come from WebKit: a text box zooming in
 * on focus, a sticky header that will not stick, 100vh under the address bar.
 * So this drives real WebKit, at real sizes, with touch where there is touch.
 *
 * It needs Playwright and axe-core, which deliberately do NOT live in this
 * repo (no node_modules here, by design). One-time setup, anywhere off C::
 *
 *   mkdir E:/caches/iphone-test && cd E:/caches/iphone-test
 *   npm init -y && npm i playwright axe-core
 *   PLAYWRIGHT_BROWSERS_PATH=E:/caches/ms-playwright npx playwright install webkit
 *
 * Point SCREENS_TEST_DIR somewhere else if you put it elsewhere.
 *
 * What it checks, per page and per screen:
 *
 *   - the page loads without a script error, and without a failed request
 *   - it is usable quickly: first paint, the moment the page is readable, and
 *     the weight it had to fetch to get there, each against a budget
 *   - nothing makes the page scroll sideways (the single worst phone bug)
 *   - every text box is at least 16px, or iOS zooms the whole page on focus
 *   - tap targets are big enough: 24px is the WCAG 2.2 AA floor, 44px is
 *     Apple's own guideline, so under 24 fails and under 44 is a warning
 *   - axe-core against WCAG 2.1 A and AA: serious and critical only, because
 *     this is a gate, not a lecture
 *   - the viewport meta says width=device-width and viewport-fit=cover
 *
 * And the gestures each screen is actually used with: dragging a Tatari from
 * the roster onto the field with a mouse, the same drag with a finger, the
 * three-tap path a phone uses instead, and dragging a placed Tatari to another
 * square. A touch drag is dispatched as pointer events rather than driven by
 * the trackpad, because that is the only way to say "this pointer is a finger"
 * — it exercises the app's own gesture code, which is where the bugs are.
 */

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = process.env.SCREENS_TEST_DIR ?? process.env.IPHONE_TEST_DIR ?? 'E:/caches/iphone-test';
const SHOT_DIR = process.env.SCREENS_SHOT_DIR ?? 'E:/caches/screen-shots';
const LIVE = 'https://jeremycanlas.github.io/clash-of-critters-horde-planner';
const PORT = 8139;

const args = process.argv.slice(2);
const live = args.includes('--live');
const shots = args.includes('--shots');
/* One size per screen. The second size catches where a layout gives, which is
   worth a minute before a release and not worth it before every commit. */
const quick = args.includes('--quick');
const only = args.filter((a) => !a.startsWith('--'));

/*
 * Three screens, two sizes each: the small one is where the layout gives, the
 * large one is what most people hold. Touch where there is touch — which
 * decides both the 16px rule (only a touch keyboard zooms) and which gesture
 * gets tested.
 */
const SCREENS = {
  phone: [
    { name: 'iPhone SE', device: 'iPhone SE' },
    { name: 'iPhone 14', device: 'iPhone 14' },
  ],
  tablet: [
    { name: 'iPad mini', device: 'iPad Mini' },
    { name: 'iPad Pro 11', device: 'iPad Pro 11' },
  ],
  desktop: [
    { name: 'laptop 1280', viewport: { width: 1280, height: 800 } },
    { name: 'desktop 1680', viewport: { width: 1680, height: 950 } },
  ],
};

/*
 * Budgets, not measurements: each is roughly a third above what the pages do
 * today, so ordinary variation passes and a real regression does not. They are
 * deliberately in what a person experiences — when the page paints, when it is
 * readable, and the weight it took — rather than a score out of a hundred.
 */
const BUDGET = {
  paint: 1800,      // ms to first contentful paint
  ready: 3000,      // ms to the page's own "there is something to read here"
  code: 1600,       // KB of markup, CSS, script and data: the critical path
  scripts: 700,     // KB of that which is JavaScript
  art: 12000,       // KB of images: 242 Tatari is a lot of sprites, but not endless
};

/* `ready` is that page's own sign that it has something to read: the roster
   drawn, the list in, the prizes worked out. A paint with nothing on it is not
   a page that is ready, and every one of these pages draws itself in script. */
const PAGES = [
  { name: 'drafter', url: 'index.html', ready: '.card' },
  { name: 'community', url: 'community.html', ready: '#list li, #list .skeleton' },
  { name: 'changes', url: 'changes.html', ready: '#changes-body *' },
  { name: 'chips', url: 'chips.html', ready: '.chipcard, .chipspage__none' },
  { name: 'farm', url: 'farm.html', ready: '#farm-all li' },
  { name: 'contribute', url: 'contribute.html', ready: '.cell' },
  { name: 'tracker', url: 'tracker.html', ready: '#tr-gate:not([hidden]), #tr-app:not([hidden])' },
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

/**
 * How long until this page is worth looking at, and what it cost to get there.
 *
 * Three numbers, because they fail for different reasons and are fixed in
 * different places: the first paint says whether the CSS and the HTML arrive
 * quickly; "ready" says whether the script that draws the page is doing too
 * much before it draws; the weight says what the network had to carry.
 */
async function checkSpeed(page, where, readySelector, readyMs) {
  const m = await page.evaluate(() => {
    const paint = performance.getEntriesByType('paint')
      .find((e) => e.name === 'first-contentful-paint')?.startTime ?? null;
    let code = 0, scripts = 0, art = 0;
    for (const r of performance.getEntriesByType('resource')) {
      const kb = (r.encodedBodySize || r.transferSize || 0) / 1024;
      const isArt = r.initiatorType === 'img' || /\.(png|jpe?g|webp|gif|svg)(\?|$)/.test(r.name);
      if (isArt) { art += kb; continue; }
      code += kb;
      if (r.initiatorType === 'script' || /\.m?js(\?|$)/.test(r.name)) scripts += kb;
    }
    const doc = performance.getEntriesByType('navigation')[0];
    code += (doc?.encodedBodySize ?? 0) / 1024;
    return { paint, code: Math.round(code), scripts: Math.round(scripts), art: Math.round(art) };
  });

  /*
   * Against the published site the clock is measuring GitHub's CDN and this
   * connection as much as the page: the same load has come back at 577ms and at
   * 3890ms minutes apart. So the time budgets are the local ones, which measure
   * the code, stretched for the network. The weight budgets are unstretched --
   * bytes are bytes wherever they are served from.
   */
  const slack = live ? 2.5 : 1;
  if (m.paint != null && m.paint > BUDGET.paint * slack) fail(where, `slow to paint: ${Math.round(m.paint)}ms, budget ${BUDGET.paint * slack}ms`);
  if (readyMs > BUDGET.ready * slack) fail(where, `slow to be readable (${readySelector.split(',')[0]}): ${readyMs}ms, budget ${BUDGET.ready * slack}ms`);
  if (m.code > BUDGET.code) fail(where, `heavy page: ${m.code}KB of markup, style, script and data, budget ${BUDGET.code}KB`);
  if (m.scripts > BUDGET.scripts) fail(where, `heavy scripts: ${m.scripts}KB, budget ${BUDGET.scripts}KB`);
  if (m.art > BUDGET.art) warn(where, `${m.art}KB of sprites fetched, over the ${BUDGET.art}KB mark`);
  return { ...m, ready: readyMs };
}

async function checkPage(page, where, touch) {
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
  // Only a touch keyboard zooms the page in; on a desktop 13px is a choice.
  if (touch && small.length) fail(where, `text boxes under 16px, so iOS zooms in on tap: ${small.join(', ')}`);

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
      // Half a pixel of slack: a 24px target measures 23.98 often enough.
      if (r.width < 23.5 || r.height < 23.5) tiny.push(`${name} ${size}`);
      else if (r.width < 43.5 || r.height < 43.5) small.push(`${name} ${size}`);
    }
    return { tiny: [...new Set(tiny)], small: [...new Set(small)] };
  }, TAPPABLE);
  const list = (xs) => `${xs.slice(0, 6).join(', ')}${xs.length > 6 ? ` +${xs.length - 6} more` : ''}`;
  // A mouse can hit a 17px target; a finger cannot, so the floor is a failure
  // on touch and a note on a desktop.
  if (taps.tiny.length) (touch ? fail : warn)(where, `targets under 24px: ${list(taps.tiny)}`);
  if (touch && taps.small.length) warn(where, `under Apple's 44px: ${list(taps.small)}`);

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

/*
 * A finger drag, dispatched as pointer events.
 *
 * Playwright can tap with a real touch point but cannot drag with one, and a
 * trackpad drag arrives as pointerType "mouse", which takes the other branch of
 * dnd.js entirely -- no hold, no slop, a different code path from the one every
 * phone and tablet user is on. So the events are dispatched: pointerdown on the
 * card, a hold long enough to pass TOUCH_HOLD_MS, then moves on window (where
 * the controller listens) and an up over the target.
 */
async function touchDrag(page, fromSel, toSel, { hold = 320, steps = 14 } = {}) {
  return page.evaluate(async ({ fromSel, toSel, hold, steps }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const from = document.querySelector(fromSel);
    const to = document.querySelector(toSel);
    if (!from || !to) return `missing ${from ? toSel : fromSel}`;
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const a = box(from), b = box(to);
    const ev = (type, x, y, target) => target.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));

    ev('pointerdown', a.x, a.y, from);
    await wait(hold);                               // a press, not a flick
    for (let i = 1; i <= steps; i++) {
      ev('pointermove', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, window);
      await wait(16);
    }
    ev('pointerup', b.x, b.y, window);
    await wait(150);
    return '';
  }, { fromSel, toSel, hold, steps });
}

/** The same drag with a real mouse, which is what a desktop actually sends. */
async function mouseDrag(page, fromSel, toSel) {
  const from = await page.locator(fromSel).first().boundingBox();
  const to = await page.locator(toSel).first().boundingBox();
  if (!from || !to) return `nothing to drag from ${fromSel}`;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      from.x + from.width / 2 + (to.x + to.width / 2 - from.x - from.width / 2) * i / 12,
      from.y + from.height / 2 + (to.y + to.height / 2 - from.y - from.height / 2) * i / 12,
    );
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
  return '';
}

const placedCount = (page) => page.locator('#grid .token').count();

/*
 * The gestures each screen is used with. The drafter is the only page with a
 * gesture worth the name, and it has two: the drag, which is how a mouse and a
 * tablet do it, and card-chip-square, which is what a phone does instead
 * because the roster and the field are never on screen together.
 */
async function checkGestures(page, name, where, screen) {
  if (name === 'farm') {
    await page.locator('#farm-score').fill('317k');
    await page.waitForTimeout(200);
    if (!/pinball/i.test(await page.locator('body').innerText())) fail(where, 'a score of 317k showed no prizes');
    return;
  }
  if (name === 'tracker') {
    if (live) {
      const gate = await page.locator('#tr-gate').isVisible();
      const app = await page.locator('#tr-app').isVisible();
      if (!gate || app) fail(where, 'the private page showed something to a signed-out visitor');
    }
    return;
  }
  if (name !== 'drafter') return;

  if (screen === 'phone') {
    /* Card, bench chip, square: three taps on three screens, and the path most
       of this app's traffic is on. */
    const sheet = page.locator('.appbar__btn[data-sheet="roster"]');
    if (await sheet.isVisible().catch(() => false)) await sheet.tap();
    const card = page.locator('.panel--roster .card').first();
    await card.tap();
    if (!/[1-9]/.test(await page.locator('#appbar-bench').textContent() ?? '')) {
      fail(where, 'tapping a roster card did not bench it');
      return;
    }
    if (await sheet.isVisible().catch(() => false)) await sheet.tap();
    const chip = page.locator('.benchchip').first();
    if (!(await chip.isVisible().catch(() => false))) { fail(where, 'the benched Tatari has no chip under the field'); return; }
    await chip.tap();
    await page.locator('.cell:not(.cell--enemy)').filter({ hasNot: page.locator('.token') }).first().tap();
    if (await placedCount(page) === 0) fail(where, 'tapping a square did not place it');

    const share = page.locator('.appbar__btn[data-action="share"], #btn-share').filter({ visible: true }).first();
    await share.tap();
    if (!(await page.locator('dialog[open], .modal.is-open').first().isVisible().catch(() => false))) {
      fail(where, 'Share did not open');
    }
    return;
  }

  // Tablet and desktop: the roster sits beside the field, so it is a drag.
  const empty = '#grid .cell:not(.cell--enemy):not(:has(.token))';
  const drag = screen === 'tablet' ? touchDrag : mouseDrag;
  const why = await drag(page, '#sec-roster .card', empty);
  if (why) { fail(where, `could not start the drag: ${why}`); return; }
  if (await placedCount(page) === 0) {
    fail(where, screen === 'tablet'
      ? 'dragging a Tatari from the roster with a finger placed nothing'
      : 'dragging a Tatari from the roster with the mouse placed nothing');
    return;
  }

  // And moving one that is already down, which is the other half of the gesture.
  const square = () => page.evaluate(() => [...document.querySelectorAll('#grid .cell')].findIndex((c) => c.querySelector('.token')));
  const wasAt = await square();
  await drag(page, '#grid .cell:has(.token)', empty);
  if (await placedCount(page) === 0) { fail(where, 'moving a placed Tatari lost it off the board'); return; }
  if (await square() === wasAt) fail(where, 'a placed Tatari would not move to another square');
}

// ------------------------------------------------------------------ run

const browser = await webkit.launch();
const started = Date.now();
const timings = [];
const asked = Object.keys(SCREENS).filter((k) => only.includes(k));
const screens = asked.length ? asked : Object.keys(SCREENS);
const pageNames = only.filter((o) => !Object.keys(SCREENS).includes(o));

for (const screen of screens) {
  for (const size of (quick ? SCREENS[screen].slice(0, 1) : SCREENS[screen])) {
    for (const p of PAGES) {
      if (pageNames.length && !pageNames.some((o) => p.name.includes(o))) continue;
      const where = `${p.name} on ${size.name}`;
      const profile = size.device ? { ...devices[size.device] } : { viewport: size.viewport };
      const context = await browser.newContext(profile);
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
        const t0 = Date.now();
        await page.goto(`${base}/${p.url}`, { waitUntil: 'commit', timeout: 20000 });
        await page.locator(p.ready).first().waitFor({ state: 'attached', timeout: 15000 });
        const readyMs = Date.now() - t0;
        await page.waitForLoadState('load').catch(() => {});
        await page.waitForTimeout(400);
        timings.push({ where, ...(await checkSpeed(page, where, p.ready, readyMs)) });
        await checkPage(page, where, !!profile.hasTouch);
        await checkGestures(page, p.name, where, screen);
      } catch (e) {
        fail(where, `did not get through: ${e.message.split('\n')[0]}`);
      }
      for (const n of noise) fail(where, n);
      await context.close();
      process.stdout.write('.');
    }
  }
}

await browser.close();
stop();

// ------------------------------------------------------------------ report

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n\nScreens: ${live ? LIVE : 'local'}, WebKit, ${screens.join(' / ')}, ${secs}s`);

if (timings.length) {
  const worst = [...timings].sort((a, b) => b.ready - a.ready).slice(0, 5);
  console.log('\n  slowest to be readable');
  for (const t of worst) {
    console.log(`   ${String(t.ready).padStart(5)}ms  paint ${String(Math.round(t.paint ?? 0)).padStart(4)}ms  `
      + `${String(t.code).padStart(4)}KB code + ${String(t.art).padStart(5)}KB art  ${t.where}`);
  }
}
if (warns.length) {
  console.log(`\n  ${warns.length} warning${warns.length === 1 ? '' : 's'}`);
  for (const w of warns) console.log(`   ~ ${w}`);
}
if (fails.length) {
  console.log(`\n  ${fails.length} failure${fails.length === 1 ? '' : 's'}`);
  for (const f of fails) console.log(`   x ${f}`);
  console.log('\nscreens: FAILED');
  process.exit(1);
}
console.log(shots ? `\nscreens: ok (screenshots in ${SHOT_DIR})` : '\nscreens: ok');
