// Checks the MVP banquet page against a stand-in database.  node tools/banquet-page-check.mjs
//
// supabase/banquet_check.sql proves what the database hands each person; this
// proves the page shows it the way it should, which a signed-out screen sweep
// never sees. Two people share one fake database the way members share the
// real one: Ana, in Group 1, and Vee, who sees both groups. Every request the
// page makes to Supabase is answered here, so nothing touches the live data.
//
// Needs the same Playwright harness as tools/screens.mjs (see its header).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = process.env.SCREENS_TEST_DIR ?? process.env.IPHONE_TEST_DIR ?? 'E:/caches/iphone-test';
const PORT = 8145;
let chromium, devices, AXE;
try {
  ({ chromium, devices } = await import(new URL('node_modules/playwright/index.mjs', `file:///${HARNESS}/`).href));
  AXE = readFileSync(path.join(HARNESS, 'node_modules/axe-core/axe.min.js'), 'utf8');
} catch (e) {
  // 2, like tools/screens.mjs: "cannot run here", which the hook waves through.
  console.error(`banquet page: no test harness at ${HARNESS} (see tools/screens.mjs)`);
  process.exit(2);
}

const server = spawn('python', ['tools/serve.py', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

// ------------------------------------------------------------------ the stand-in

const db = {
  uids: [
    { grp: 1, uid: '10000001', who: 'Ana', source: 'discord' }, { grp: 1, uid: '10000002', who: 'Ana', source: 'discord' },
    { grp: 1, uid: '10000003', who: 'Ana', source: 'discord' },
    { grp: 1, uid: '20000001', who: 'Ben', source: 'discord' }, { grp: 1, uid: '55555555', who: 'Ben', source: 'discord' },
    { grp: 2, uid: '30000001', who: 'Cy', source: 'discord' }, { grp: 2, uid: '55555555', who: 'Cy', source: 'discord' },
  ],
  claims: [],
  marks: new Map([['1:60000137', { state: 'not-yet', by: 'Eli' }]]),
};
for (let i = 0; i < 20; i++) db.uids.push({ grp: 1, uid: String(60000000 + i * 137), who: ['Dee', 'Eli', 'Fay'][i % 3], source: 'discord' });
let syncedAgo = 60e3;
let reads = 0;
let sames = 0;
let down = false; // the database unreachable, for the offline check
const NOT_YET_AT = new Date(Date.now() - 5 * 60e3).toISOString();
const sent = [];

// What banquet_state() answers, including that a one-group member's answer has no group in it.
function state(me) {
  reads++;
  const groups = me.all ? [1, 2] : [me.grp];
  const mine = db.uids.filter((u) => u.who === me.name && groups.includes(u.grp));
  const shared = me.all || mine.length >= 4;
  const keys = [...new Map(db.uids.filter((u) => groups.includes(u.grp)).map((u) => [`${u.grp}:${u.uid}`, u])).values()];
  const card = (k) => {
    const cl = db.claims.filter((c) => c.grp === k.grp && c.uid === k.uid);
    const m = db.marks.get(`${k.grp}:${k.uid}`);
    return {
      uid: k.uid,
      entered_by: [...new Set(db.uids.filter((u) => u.grp === k.grp && u.uid === k.uid).map((u) => u.who))],
      mine_site: false, claims: cl.length, claimed_by: cl.map((c) => c.who), claimed: cl.some((c) => c.who === me.name),
      full: m?.state === 'full' ? m.by : null,
      not_yet: m?.state === 'not-yet' ? { by: m.by, at: NOT_YET_AT } : null,
      ...(me.all ? { grp: k.grp } : {}),
    };
  };
  return {
    round: '2026-09-24', current: '2026-09-24', rounds: ['2026-09-24'], shared, total: keys.length,
    synced_at: new Date(Date.now() - syncedAgo).toISOString(),
    mine: mine.map((u) => ({ uid: u.uid, source: u.source, ...(me.all ? { grp: u.grp } : {}) })),
    banquets: shared ? keys.map(card) : [],
    ...(me.all ? { groups } : {}),
  };
}

const browser = await chromium.launch();

async function open(me, opts) {
  const ctx = await browser.newContext({ ...opts, colorScheme: me.scheme ?? 'dark' });
  await ctx.addInitScript(() => localStorage.setItem('coc.community.v1', JSON.stringify({ refresh_token: 'x', uid: 'u', name: 'x' })));
  await ctx.route(/supabase\.co/, async (route) => {
    const u = new URL(route.request().url());
    const body = route.request().postDataJSON?.() ?? {};
    const json = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    const ok = () => route.fulfill({ status: 204 });
    if (u.pathname.endsWith('/auth/v1/token')) return json({ access_token: 't', refresh_token: 'x', expires_in: 3600 });
    const fn = u.pathname.split('/').pop();
    if (!['banquet_state', 'banquet_check', 'tracker_claim'].includes(fn)) sent.push({ who: me.name, fn, body });
    const g = me.all ? body.g : me.grp; // what banquet_group_for() does
    if (fn === 'banquet_check') return json('ok');
    if (fn === 'tracker_claim') return json(false);
    if (down) return route.abort('internetdisconnected');
    if (fn === 'banquet_state') {
      const full = state(me);
      const { synced_at, ...rest } = full;
      const hash = JSON.stringify(rest);
      if (body.known === hash) { sames++; return json({ same: true, hash, synced_at }); }
      return json({ ...full, hash });
    }
    if (fn === 'banquet_add') { db.uids.push({ grp: g, uid: String(body.target), who: me.name, source: 'site' }); return ok(); }
    if (fn === 'banquet_claim') {
      db.claims = db.claims.filter((c) => !(c.grp === g && c.uid === String(body.target) && c.who === me.name));
      if (body.claimed) db.claims.push({ grp: g, uid: String(body.target), who: me.name });
      return ok();
    }
    if (fn === 'banquet_mark') { db.marks.set(`${g}:${body.target}`, { state: body.state, by: me.name }); return ok(); }
    return route.fulfill({ status: 404, body: '{}' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${PORT}/banquet.html`);
  await page.waitForSelector(me.expectGate ? '#bq-gate:not([hidden])' : '#bq-app:not([hidden])');
  return { page, errors };
}

const axe = async (page) => {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] }))
    .violations.map((v) => `${v.id}: ${v.nodes[0].target.join(' ')}`));
};
const lastSent = (who, fn) => sent.filter((x) => x.who === who && x.fn === fn).at(-1)?.body;

try {
  // ------------------------------------------------------------------ Ana, Group 1, on a phone
  const ana = await open({ name: 'Ana', grp: 1 }, devices['iPhone SE']);
  const A = ana.page;
  assert.equal(await A.locator('#bq-my li').count(), 3, 'her three posts fill in by themselves');
  assert.match(await A.locator('#bq-locked').textContent(), /Add 1 more UID/, 'three is not enough');
  assert.ok(await A.locator('#bq-list').isHidden(), 'the list stays shut');

  await A.fill('#bq-add-uid', '10000004');
  await A.click('#bq-add');
  await A.waitForSelector('#bq-list:not([hidden])');
  assert.equal(lastSent('Ana', 'banquet_add').g, null, 'a group member never sends a group');

  await A.click('[data-show="all"]');
  assert.equal(await A.locator('#bq-cards li').count(), 26, 'Group 1 only');
  assert.ok(!/group/i.test(await A.locator('body').innerText()), 'the word "group" appears nowhere');
  assert.ok(!/30000001|\bCy\b/.test(await A.locator('#bq-app').innerText()), 'nothing of Group 2');
  assert.equal(await A.locator('#bq-view').isVisible(), false, 'no View as');

  await A.fill('#bq-find', '5555');
  assert.equal(await A.locator('#bq-cards li').count(), 1, 'Find narrows to the one');
  await A.fill('#bq-find', '');
  assert.equal(await A.getByRole('button', { name: 'I claimed 55555555' }).count(), 1, 'buttons say which UID');
  // A claim takes the card out of To claim; Undo brings it back.
  await A.click('[data-show="open"]');
  await A.click('[data-claim="55555555"]');
  await A.waitForSelector('#toast.is-shown');
  assert.equal(await A.locator('[data-claim="55555555"]').count(), 0, 'claimed, gone from To claim');
  await A.click('#toast .toast__act');
  await A.waitForSelector('[data-claim="55555555"]');
  assert.equal(db.claims.filter((c) => c.who === 'Ana').length, 0, 'Undo took the claim back');
  await A.click('[data-show="all"]');
  assert.equal(await A.locator('.bq-card.is-waiting').count(), 1, 'a not-yet banquet stays listed');
  assert.match(await A.locator('.bq-card__checked').textContent(), /Last checked .* 5 min ago by Eli/);

  await A.mouse.wheel(0, 1400);
  await A.waitForTimeout(300);
  assert.ok(await A.locator('.bq-list > .bq-bar').evaluate((e) => e.getBoundingClientRect().top <= 1), 'filters pinned while scrolling');
  assert.equal(await A.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'nothing off the side');
  await A.evaluate(() => scrollTo(0, 0));
  assert.deepEqual(await axe(A), [], 'axe, group member, dark');

  // ------------------------------------------------------------------ Vee, both groups
  const vee = await open({ name: 'Vee', all: true, scheme: 'light' }, { viewport: { width: 1280, height: 900 } });
  const V = vee.page;
  await V.click('[data-show="all"]');
  assert.equal(await V.locator('#bq-cards li').count(), 28, 'both groups');
  assert.equal(await V.locator('#bq-cards li', { hasText: '55555555' }).count(), 2, 'one card per group');
  assert.equal(await V.locator('#bq-cards .bq-grp').count(), 28, 'every card says its group');

  await V.fill('#bq-add-uid', '40000001');
  await V.click('#bq-add');
  assert.equal(await V.locator('#bq-mine-error').textContent(), 'Pick a group.');
  await V.selectOption('#bq-add-grp', '2');
  await V.click('#bq-add');
  await V.waitForTimeout(300);
  assert.equal(lastSent('Vee', 'banquet_add').g, 2);

  await V.locator('#bq-cards li', { hasText: 'Group 2' }).filter({ hasText: '55555555' }).locator('[data-mark="full"]').click();
  await V.waitForTimeout(300);
  assert.equal(lastSent('Vee', 'banquet_mark').g, 2, "a mark goes to the card's group");
  assert.deepEqual(await axe(V), [], 'axe, viewer, light, with a full card');

  await V.click('[data-group="1"]');
  assert.equal(await V.locator('#bq-cards li').count(), 26, 'As Group 1: only Group 1');
  assert.equal(await V.locator('.bq-grp').count(), 0, 'As Group 1: no tags');
  assert.ok(await V.locator('#bq-add-grp').isHidden(), 'As Group 1: no picker');
  assert.equal(await V.locator('#bq-count').textContent(), '26 of 26', 'As Group 1: counts as a member would');
  await V.click('[data-claim="20000001"]');
  await V.waitForTimeout(300);
  assert.equal(lastSent('Vee', 'banquet_claim').g, 1);

  // ------------------------------------------------------------------ Ana sees Vee's work, on her own
  await A.click('[data-show="all"]');
  await A.locator('#bq-mine-fold').evaluate((d) => { d.open = true; });
  await A.fill('#bq-add-uid', '9999');
  const before = reads;
  await A.clock.fastForward(31_000);
  await A.waitForTimeout(400);
  assert.ok(reads > before, 'refreshed after 30 seconds');
  assert.equal(await A.locator('[data-claim="20000001"]').locator('xpath=..').locator('..').locator('summary').textContent(), '1 claimed',
    "Vee's Group 1 claim shows without a reload");
  assert.equal(await A.locator('li', { hasText: '55555555' }).locator('.bq-tag').count(), 0, "Vee's Group 2 full does not");
  assert.equal(await A.inputValue('#bq-add-uid'), '9999', 'a refresh never wipes typing');
  const quiet = sames;
  await A.clock.fastForward(31_000);
  await A.waitForTimeout(400);
  assert.ok(sames > quiet, 'nothing new: the refresh gets the short answer');
  assert.equal(await A.locator('[data-claim="20000001"]').count(), 1, 'and the list stays as it was');

  await A.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = reads;
  await A.clock.fastForward(95_000);
  await A.waitForTimeout(300);
  assert.equal(reads, hidden, 'nothing while the tab is hidden');

  // ------------------------------------------------------------------ the page lost its connection
  await A.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await A.waitForTimeout(300);
  down = true;
  await A.clock.fastForward(155_000);
  await A.waitForTimeout(500);
  assert.match(await A.locator('#bq-stale:not([hidden])').textContent(), /not reached the list for \d+ minutes.*connection/,
    'a page that cannot reach the list says so');
  assert.equal(await A.locator('#bq-cards li').count() > 0, true, 'and keeps what it had');
  down = false;
  await A.clock.fastForward(31_000);
  await A.waitForTimeout(500);
  assert.ok(!/connection/.test(await A.locator('#bq-stale').textContent()), 'back online, the connection warning goes');

  // ------------------------------------------------------------------ the sync stopped
  syncedAgo = 12 * 60e3;
  await A.reload();
  await A.waitForSelector('#bq-app:not([hidden])');
  assert.match(await A.locator('#bq-stale:not([hidden])').textContent(), /not been read for \d+ minutes/);

  // ------------------------------------------------------------------ a first load that fails
  down = true;
  const dee = await open({ name: 'Dee', grp: 1, expectGate: true }, devices['iPhone SE']);
  assert.match(await dee.page.locator('#bq-gate-head').textContent(), /Could not load/);
  await dee.page.clock.fastForward(65_000);
  await dee.page.waitForTimeout(300);
  assert.deepEqual(dee.errors, [], 'the refresh timer stays quiet with no list');
  down = false;

  assert.deepEqual([...ana.errors, ...vee.errors], [], 'no script errors');
  console.log('banquet page: ok');
} finally {
  await browser.close();
  server.kill();
}
