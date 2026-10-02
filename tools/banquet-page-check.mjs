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
for (const uid of ['20000001', '55555555', '10000001', '10000002']) db.uids.push({ grp: 1, uid, who: 'Yui', source: 'discord' });
// A private list, 3, that Vee is in and Ana is not.
db.uids.push({ grp: 3, uid: '39900001', who: 'maryal', source: 'site' });
for (let i = 0; i < 20; i++) db.uids.push({ grp: 1, uid: String(60000000 + i * 137), who: ['Dee', 'Eli', 'Fay'][i % 3], source: 'discord' });
/* The second server: its own schema, one group. Bea is a member, Vee sees it
   too. Its UIDs share one with the first (55555555), as real servers can. */
const dbB = {
  uids: ['81000001', '81000002', '81000003', '81000004'].map((uid) => ({ uid, who: 'Bea' }))
    .concat([{ uid: '82000001', who: 'Bo' }, { uid: '55555555', who: 'Bo' }]),
  claims: [],
};
function stateB(me) {
  const all = me.all;
  const card = (uid) => {
    const cl = dbB.claims.filter((c) => c.uid === uid);
    return { uid, posted: '2026-09-29T00:00:00.000Z', entered_by: [...new Set(dbB.uids.filter((u) => u.uid === uid).map((u) => u.who))],
      mine_site: false, claims: cl.length, claimed_by: cl.map((c) => c.who), claimed: cl.some((c) => c.who === me.name),
      full: null, not_yet: null, ...(all ? { grp: 1 } : {}) };
  };
  const mine = dbB.uids.filter((u) => u.who === me.name);
  const shared = all || mine.length >= 4;
  const uids = [...new Set(dbB.uids.map((u) => u.uid))];
  return {
    round: '2026-09-24', current: '2026-09-24', rounds: ['2026-09-24'], shared, total: uids.length,
    synced_at: new Date(Date.now() - 30e3).toISOString(),
    mine: mine.map((u) => ({ uid: u.uid, source: 'discord', ...(all ? { grp: 1 } : {}) })),
    banquets: shared ? uids.map(card) : [],
    ...(all ? { groups: [1], names: { 1: 'Group 1' }, private: [] } : {}),
  };
}
const schemas = []; // the schema of every request each person's page made: 'public' or 'tide'

let syncedAgo = 60e3;
let reads = 0;
let sames = 0;
let down = false; // the database unreachable, for the offline check
const NOT_YET_AT = new Date(Date.now() - 5 * 60e3).toISOString();
const sent = [];

// What banquet_state() answers, including that a one-group member's answer has no group in it.
function state(me) {
  reads++;
  const groups = me.all ? [1, 2, 3] : [me.grp];
  const mine = db.uids.filter((u) => u.who === me.name && groups.includes(u.grp));
  const shared = me.all || mine.length >= 4;
  const keys = [...new Map(db.uids.filter((u) => groups.includes(u.grp)).map((u) => [`${u.grp}:${u.uid}`, u])).values()];
  const card = (k) => {
    const cl = db.claims.filter((c) => c.grp === k.grp && c.uid === k.uid);
    const m = db.marks.get(`${k.grp}:${k.uid}`);
    return {
      uid: k.uid,
      posted: new Date(Date.parse('2026-09-29T00:00:00Z') + db.uids.findIndex((u) => u.grp === k.grp && u.uid === k.uid) * 60e3).toISOString(),
      entered_by: [...new Set(db.uids.filter((u) => u.grp === k.grp && u.uid === k.uid).map((u) => u.who))],
      mine_site: false, claims: cl.length, claimed_by: cl.map((c) => c.who), claimed: cl.some((c) => c.who === me.name),
      full: m?.state === 'full' ? m.by : null,
      not_yet: m?.state === 'not-yet' ? { by: m.by, at: m.at ?? NOT_YET_AT } : null,
      open: m?.state === 'open' ? { by: m.by, at: m.at } : null,
      full_at: m?.state === 'full' ? m.at : null,
      ...(me.all ? { grp: k.grp } : {}),
    };
  };
  return {
    round: '2026-09-24', current: '2026-09-24', rounds: ['2026-09-24'], shared, total: keys.length,
    synced_at: new Date(Date.now() - syncedAgo).toISOString(),
    mine: mine.map((u) => ({ uid: u.uid, source: u.source, ...(me.all ? { grp: u.grp } : {}) })),
    banquets: shared ? keys.map(card) : [],
    ...(me.all ? { groups, names: { 1: 'Group 1', 2: 'Group 2', 3: 'Private' }, private: [3] } : {}),
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
    const headers = route.request().headers();
    const schema = headers['content-profile'] ?? headers['accept-profile'] ?? 'public';
    schemas.push({ who: me.name, schema });
    if (schema === 'tide') {
      sent.push({ who: me.name, fn, body, host: 'B' });
      if (fn === 'banquet_check') return json(me.inB ? 'ok' : 'no-role');
      if (fn === 'banquet_state') return json({ ...stateB(me), hash: `b${JSON.stringify(dbB.claims)}` });
      if (fn === 'banquet_claim') {
        dbB.claims = dbB.claims.filter((c) => !(c.uid === String(body.target) && c.who === me.name));
        if (body.claimed) dbB.claims.push({ uid: String(body.target), who: me.name });
        return ok();
      }
      if (fn === 'banquet_copies') return json({ people: [], both_groups: [] });
      if (fn === 'banquet_access_log') {
        return json([{ name: 'Bo', groups: [1], visits: 1, minutes: 2, reads: 8, per_min: 4, copied: 0, claimed: 0,
          shared: 2, past_visits: 0, last: new Date().toISOString(), flags: [], recent: [] }]);
      }
      return ok();
    }
    if (!['banquet_state', 'banquet_check', 'tracker_claim'].includes(fn)) sent.push({ who: me.name, fn, body });
    const g = me.all ? body.g : me.grp; // what banquet_group_for() does
    if (fn === 'banquet_copies') {
      if (!me.all) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"code":"P0001","message":"Not for this account."}' });
      // Earlier in the list is earlier in time.
      const at = (i) => new Date(Date.parse('2026-09-29T00:00:00Z') + i * 60e3).toISOString();
      const rows = db.uids.map((u, i) => ({ ...u, i })).filter((u) => u.grp !== 3); // never the private list
      const firstOther = (u) => rows.find((o) => o.uid === u.uid && o.who !== u.who && o.i < u.i);
      const byWho = Map.groupBy(rows, (u) => `${u.grp}:${u.who}`);
      const people = [...byWho.values()].map((us) => {
        const items = us.map((u) => ({ uid: u.uid, at: at(u.i), source: u.source, first_by: firstOther(u)?.who ?? null,
          first_grp: firstOther(u)?.grp ?? null, first_at: firstOther(u) ? at(firstOther(u).i) : null }));
        const copied = items.filter((x) => x.first_by).length;
        return { name: us[0].who, grp: us[0].grp, uids: us.length, copied, all_copied: copied === us.length, items };
      }).filter((p) => p.copied);
      const both = [...new Set(rows.map((u) => u.uid))].filter((uid) => new Set(rows.filter((u) => u.uid === uid).map((u) => u.grp)).size > 1)
        .map((uid) => ({ uid, groups: Object.fromEntries([1, 2].map((g) => [g, [...new Set(rows.filter((u) => u.uid === uid && u.grp === g).map((u) => u.who))]])) }));
      return json({ people, both_groups: both });
    }
    if (fn === 'banquet_note_copy') return ok();
    if (fn === 'banquet_edit') {
      const row = db.uids.find((u) => u.who === me.name && u.grp === g && u.uid === String(body.target) && u.source === 'site');
      if (!row) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"code":"P0001","message":"Only a UID you added on the site can be edited here."}' });
      row.uid = String(body.replacement);
      return ok();
    }
    if (fn === 'banquet_access_log') {
      if (!me.all) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"code":"P0001","message":"Not for this account."}' });
      const copies = sent.filter((x) => x.fn === 'banquet_note_copy');
      return json([
        { name: 'Grabby', groups: [1, 2], visits: 3, minutes: 40, reads: 160, per_min: 4, copied: 22, claimed: 1, shared: 0, past_visits: 2,
          last: new Date().toISOString(), flags: ['copied-not-claimed', 'took-not-shared'],
          recent: [{ start: new Date().toISOString(), last: new Date().toISOString(), reads: 60, round: '2026-09-24', groups: [1, 2], copied: 12 }] },
        { name: 'Ana', groups: [1], visits: 1, minutes: 5, reads: 20, per_min: 4, copied: copies.filter((x) => x.who === 'Ana').length, claimed: 1,
          shared: 4, past_visits: 0, last: new Date().toISOString(), flags: [], recent: [] },
      ]);
    }
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
      // A claim is a gift seen, as banquet_claim() marks it.
      const m = db.marks.get(`${g}:${body.target}`);
      if (body.claimed && (!m || m.state === 'not-yet')) db.marks.set(`${g}:${body.target}`, { state: 'open', by: me.name, at: new Date().toISOString() });
      return ok();
    }
    if (fn === 'banquet_mark') {
      if (body.state) db.marks.set(`${g}:${body.target}`, { state: body.state, by: me.name, at: new Date().toISOString() });
      else db.marks.delete(`${g}:${body.target}`);
      return ok();
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${PORT}/banquet.html${me.code ? `?s=${me.code}` : ''}`);
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
  assert.equal(await A.locator('[data-show][aria-pressed="true"]').count(), 0, 'all four statuses on arrival');
  assert.equal(lastSent('Ana', 'banquet_add').g, null, 'a group member never sends a group');
  // Edit: only on UIDs added here, one step, Escape backs out.
  await A.locator('#bq-mine-fold').evaluate((d) => { d.open = true; });
  assert.equal(await A.locator('#bq-my [data-edit]').count(), 1, 'Edit only on the one added here, not the posted ones');
  await A.click('#bq-my [data-edit="10000004"]');
  await A.keyboard.press('Escape');
  assert.equal(await A.locator('#bq-my li.is-editing').count(), 0, 'Escape backs out');
  await A.click('#bq-my [data-edit="10000004"]');
  await A.fill('#bq-my li.is-editing input', '1000004');
  await A.click('#bq-my [data-save]');
  assert.equal(await A.locator('#bq-my .tr-form__error').textContent(), 'A UID is 8 digits.');
  await A.fill('#bq-my li.is-editing input', '10000044');
  await A.keyboard.press('Enter');
  await A.waitForSelector('#bq-my [data-edit="10000044"]');
  assert.deepEqual(lastSent('Ana', 'banquet_edit'), { target: 10000004, replacement: 10000044, g: null }, 'one call, old and new');
  await A.click('#bq-my [data-edit="10000044"]');
  await A.fill('#bq-my li.is-editing input', '10000004');
  await A.keyboard.press('Enter');
  await A.waitForSelector('#bq-my [data-edit="10000004"]');

  assert.equal(await A.locator('#bq-cards li[data-key]').count(), 26, 'Group 1 only');
  assert.ok(!/group/i.test(await A.locator('body').innerText()), 'the word "group" appears nowhere');
  assert.ok(!/30000001|\bCy\b/.test(await A.locator('#bq-app').innerText()), 'nothing of Group 2');
  assert.equal(await A.locator('#bq-view').isVisible(), false, 'no View as');
  assert.equal(await A.locator('#bq-shot').isVisible(), false, 'no screenshot mode for a member');
  assert.equal(sent.filter((x) => x.who === 'Ana' && x.fn === 'banquet_copies').length, 0, 'a member never asks for copies');
  assert.ok(await A.locator('#bq-access').isHidden(), 'nor sees the access log');
  assert.ok(await A.locator('#bq-copies').isHidden(), 'nor sees the panel');

  await A.fill('#bq-find', '5555');
  assert.equal(await A.locator('#bq-cards li[data-key]').count(), 1, 'Find narrows to the one');
  await A.fill('#bq-find', 'fay');
  assert.equal(await A.locator('#bq-cards li[data-key]').count(), 6, 'a name finds everything they posted');
  await A.fill('#bq-find', 'ELI');
  assert.ok(await A.locator('#bq-cards li[data-key]', { hasText: '60000137' }).count() === 1, 'any case, and who marked it counts');
  await A.fill('#bq-find', '');
  assert.equal(await A.getByRole('button', { name: 'I claimed 55555555' }).count(), 1, 'buttons say which UID');
  // Copying a UID off a card is reported, with no group from a group member.
  await A.locator('#bq-cards li[data-key=":55555555"] .bq-uid').click();
  await A.waitForTimeout(200);
  assert.deepEqual(lastSent('Ana', 'banquet_note_copy'), { target: 55555555, g: null }, 'a copy is noted');
  // The last one copied: its own colour, and a button back to it from anywhere.
  assert.equal(await A.locator('#bq-cards li.is-last-copied').getAttribute('data-key'), ':55555555', 'the copied card is marked');
  assert.match(await A.locator('#bq-last').textContent(), /Last copied 55555555/);
  await A.click('[data-show="full"]');
  await A.click('#bq-last');
  await A.waitForTimeout(600);
  assert.ok(await A.locator('#bq-cards li.is-last-copied').isVisible(), 'the button finds it even when a filter hid it');
  assert.ok(await A.locator('#bq-cards li.is-last-copied').evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'and brings it on screen');
  await A.reload();
  await A.waitForSelector('#bq-list:not([hidden])');
  assert.equal(await A.locator('#bq-cards li.is-last-copied').count() + await A.locator('#bq-last:not([hidden])').count(), 2, 'kept across a reload');
  // Four statuses: a UID nobody has checked needs a look; Eli's not-yet is not logged in.
  assert.equal(await A.locator('[data-show]').count(), 4, 'Claimable, Needs a look, Not logged in, Full');
  assert.equal(await A.locator('[data-show][aria-pressed="true"]').count(), 0, 'the last-copied button showed all four again');
  assert.equal(await A.locator('[data-n="look"]').textContent(), '25', 'new UIDs need a look');
  assert.equal(await A.locator('[data-n="notin"]').textContent(), '1');
  assert.equal(await A.locator('[data-n="claimable"]').textContent(), '0');
  // I claimed: a gift seen, so the card moves to Claimable; Undo takes the claim back.
  await A.click('[data-claim="55555555"]');
  await A.waitForSelector('#toast.is-shown');
  await A.waitForSelector('li.is-claimable[data-key=":55555555"]');
  assert.match(await A.locator('li[data-key=":55555555"] .bq-tag--ok').textContent(), /Gift seen just now/);
  assert.match(await A.locator('li[data-key=":55555555"] .bq-card__claims summary').textContent(), /at least 1 of 50 gone/);
  assert.equal(await A.locator('[data-n="claimable"]').textContent(), '1', 'and counted');
  await A.click('#toast .toast__act');
  await A.waitForFunction(() => document.querySelector('[data-claim="55555555"]')?.getAttribute('aria-pressed') === 'false');
  assert.equal(db.claims.filter((c) => c.who === 'Ana').length, 0, 'Undo took the claim back');
  // Not logged in, then a gift seen.
  await A.click('[data-mark="not-yet"][data-uid="20000001"]');
  await A.waitForSelector('li.is-notin[data-key=":20000001"]');
  assert.match(await A.locator('li[data-key=":20000001"] .bq-card__checked').textContent(), /Last checked .* just now by Ana/);
  await A.click('li[data-key=":20000001"] [data-mark="open"]');
  await A.waitForSelector('li.is-claimable[data-key=":20000001"]');
  assert.equal(lastSent('Ana', 'banquet_mark').state, 'open', 'Open now marks it open');
  // A tile shows only its own; pressed again, all four.
  await A.click('[data-show="notin"]');
  assert.deepEqual(await A.locator('#bq-cards li[data-key]').evaluateAll((ls) => ls.map((l) => l.dataset.key)), [':60000137'], 'Not logged in is only the not-yet one');
  assert.equal(await A.locator('[data-show="notin"]').getAttribute('aria-pressed'), 'true');
  assert.match(await A.locator('.bq-card__checked').textContent(), /Last checked .* 5 min ago by Eli/, 'with when and by whom');
  await A.click('[data-show="notin"]');
  assert.equal(await A.locator('#bq-cards li[data-key]').count(), 26, 'and back to all');
  assert.deepEqual(await A.locator('#bq-cards .bq-section h2').evaluateAll((hs) => hs.map((h) => h.firstChild.textContent.trim())),
    ['Claimable', 'Needs a look', 'Not logged in yet'], 'one heading per status there is, in order');
  assert.equal(await A.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'the tiles fit a phone');
  await A.setViewportSize({ width: 320, height: 640 });
  assert.ok(await A.locator('[data-show]').evaluateAll((bs) => bs.every((b) => b.scrollWidth <= b.clientWidth + 1)), 'each tile fits a 320px phone');
  assert.equal(await A.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'nothing off the side at 320px');
  await A.setViewportSize(devices['iPhone SE'].viewport);

  await A.mouse.wheel(0, 1400);
  await A.waitForTimeout(300);
  assert.ok(await A.locator('.bq-bar--pinned').evaluate((e) => e.getBoundingClientRect().top <= 1), 'filters pinned while scrolling');
  assert.equal(await A.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'nothing off the side');
  await A.evaluate(() => scrollTo(0, 0));
  assert.deepEqual(await axe(A), [], 'axe, group member, dark');

  // ------------------------------------------------------------------ Vee, both groups
  const vee = await open({ name: 'Vee', all: true, scheme: 'light' }, { viewport: { width: 1280, height: 900 } });
  const V = vee.page;
  assert.equal(await V.locator('#bq-cards li[data-key]').count(), 28, 'both groups');
  assert.equal(await V.locator('#bq-cards li[data-key]', { hasText: '55555555' }).count(), 2, 'one card per group');
  await V.locator('#bq-cards li[data-key="2:55555555"] .bq-uid').click();
  await V.waitForTimeout(200);
  assert.deepEqual(lastSent('Vee', 'banquet_note_copy'), { target: 55555555, g: 2 }, "a viewer's copy says which group");
  await V.click('#bq-access summary');
  await V.waitForSelector('#bq-access-body li');
  assert.match(await V.locator('#bq-access-n').textContent(), /2 people, 1 flagged/);
  assert.match(await V.locator('#bq-access-body li').first().innerText(), /Grabby[\s\S]*copied far more than they claimed[\s\S]*took without sharing[\s\S]*copied 22 · claimed 1 · shared 0/,
    'the flagged one first, with what they took and gave');
  if (process.env.BANQUET_SHOTS) await V.locator('#bq-access').screenshot({ path: `${process.env.BANQUET_SHOTS}/access.png` });
  await V.click('#bq-access summary');
  await V.click('#bq-copies summary');
  assert.match(await V.locator('#bq-copies-body').innerText(), /Yui[\s\S]*all 4 posted earlier by others/, 'the copier is flagged');
  assert.match(await V.locator('#bq-copies-body').innerText(), /In both groups[\s\S]*55555555/, 'and the UID in both groups');
  assert.ok(!/Ana.*posted earlier/.test(await V.locator('#bq-copies-body').innerText()), 'the one who posted first is not');
  if (process.env.BANQUET_SHOTS) await V.locator('#bq-copies').screenshot({ path: `${process.env.BANQUET_SHOTS}/copies.png` });
  assert.equal(await V.locator('#bq-cards .bq-grp').count(), 28, 'every card says its group');

  // The private list: not in Both groups, its own button, and adding there stays there.
  assert.equal(await V.locator('li[data-key="3:39900001"]').count(), 0, 'Both groups leaves the private list out');
  await V.click('[data-group="3"]');
  assert.equal(await V.locator('[data-group="3"]').textContent(), 'Private', 'it has its own button');
  assert.deepEqual(await V.locator('#bq-cards li[data-key]').evaluateAll((ls) => ls.map((l) => l.dataset.key)), ['3:39900001'], 'and only its banquets');
  assert.match(await V.locator('#bq-view-note').textContent(), /only the people added to it/);
  await V.fill('#bq-add-uid', '39900002');
  await V.click('#bq-add');
  await V.waitForTimeout(300);
  assert.equal(lastSent('Vee', 'banquet_add').g, 3, 'adding in Private goes to the private list');
  await V.click('[data-group="0"]');
  assert.equal(await V.locator('li[data-key="3:39900002"]').count(), 0, 'and does not show in Both groups');
  await V.fill('#bq-add-uid', '40000001');
  await V.click('#bq-add');
  assert.equal(await V.locator('#bq-mine-error').textContent(), 'Pick a group.');
  await V.selectOption('#bq-add-grp', '2');
  await V.click('#bq-add');
  await V.waitForTimeout(300);
  assert.equal(lastSent('Vee', 'banquet_add').g, 2);

  await V.locator('#bq-cards li[data-key]', { hasText: 'Group 2' }).filter({ hasText: '55555555' }).locator('[data-mark="full"]').click();
  await V.waitForTimeout(300);
  assert.equal(lastSent('Vee', 'banquet_mark').g, 2, "a mark goes to the card's group");
  assert.deepEqual(await axe(V), [], 'axe, viewer, light, with a full card');

  await V.click('[data-group="1"]');
  // Screenshot mode: the bar goes, stays gone on reload, and the title brings it back.
  await V.click('#bq-shot');
  assert.ok(await V.locator('#bq-view').isHidden(), 'screenshot mode hides View as');
  assert.equal(await V.locator('.bq-grp:visible').count(), 0, 'and As Group 1 then shows nothing of groups');
  await V.reload();
  await V.waitForSelector('#bq-app:not([hidden])');
  assert.ok(await V.locator('#bq-view').isHidden(), 'remembered across a reload');
  assert.equal(await V.locator('.bq-grp:visible').count(), 0, 'still As Group 1 after the reload');
  await V.click('.topbar h1');
  assert.ok(await V.locator('#bq-view').isVisible(), 'tapping the title brings it back');
  await V.click('#bq-shot');
  await V.click('#site-tabs [aria-current="page"]');
  assert.ok(await V.locator('#bq-view').isVisible(), "so does tapping the page's own tab");
  await V.click('[data-group="1"]');
  assert.equal(await V.locator('#bq-cards li[data-key]').count(), 26, 'As Group 1: only Group 1');
  assert.equal(await V.locator('.bq-grp:visible').count(), 0, 'As Group 1: no tags');
  assert.ok(await V.locator('#bq-add-grp').isHidden(), 'As Group 1: no picker');
  assert.equal(await V.locator('[data-n="look"]').textContent(), await V.locator('li.is-look').count().then(String), 'As Group 1: counts as a member would');
  await V.click('[data-claim="20000001"]');
  await V.waitForTimeout(300);
  assert.equal(lastSent('Vee', 'banquet_claim').g, 1);

  // ------------------------------------------------------------------ Ana sees Vee's work, on her own
  await A.locator('#bq-mine-fold').evaluate((d) => { d.open = true; });
  await A.fill('#bq-add-uid', '9999');
  assert.ok(await A.locator('#bq-new').isHidden(), 'a first visit opens with nothing marked new, got ' + (await A.locator('#bq-new-uids').textContent()));
  db.uids.push({ grp: 1, uid: '71234567', who: 'Ben', source: 'discord' });
  const before = reads;
  await A.clock.fastForward(16_000);
  await A.waitForTimeout(400);
  assert.ok(reads > before, 'refreshed within 15 seconds');
  assert.equal(await A.locator('[data-claim="20000001"]').locator('xpath=..').locator('..').locator('summary').textContent(), 'at least 1 of 50 gone',
    "Vee's Group 1 claim shows without a reload");
  assert.equal(await A.locator('li', { hasText: '55555555' }).locator('.bq-tag', { hasText: 'Full' }).count(), 0, "Vee's Group 2 full does not");
  // Ben's new banquet: in the strip, tagged, counted in the tab title, and in the latest line.
  assert.equal(await A.locator('#bq-new-uids [data-new]').allTextContents().then((t) => t.join()), '71234567', 'new to claim');
  assert.match(await A.title(), /^\(1\) /, 'the tab title counts it');
  assert.equal(await A.locator('li[data-key=":71234567"] .bq-tag--new').count(), 1, 'its card says New');
  assert.match(await A.locator('#bq-latest').textContent(), /Latest: (New: 71234567 from Ben|Vee claimed 20000001)/, 'the latest change, in one line');
  if (process.env.BANQUET_SHOTS) { await A.evaluate(() => scrollTo(0, 900)); await A.waitForTimeout(300); await A.screenshot({ path: `${process.env.BANQUET_SHOTS}/news-phone.png` }); }
  await A.click('#bq-new-uids [data-new=":71234567"]');
  assert.ok(await A.locator('#bq-new').isHidden(), 'tapping it clears it');
  assert.ok(!/^\(/.test(await A.title()), 'and the title count');
  assert.equal(await A.locator('li[data-key=":71234567"] .bq-tag--new').count(), 0, 'and the tag');
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
  assert.ok(reads - hidden >= 1 && reads - hidden <= 2, `about once a minute while hidden, not every 15 seconds (got ${reads - hidden})`);

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
  assert.equal(await A.locator('#bq-cards li[data-key]').count() > 0, true, 'and keeps what it had');
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

  // ------------------------------------------------------------------ the second server
  // The first server's link never asks the second's schema, and the reverse.
  assert.ok(schemas.filter((x) => ['Ana', 'Vee', 'Dee'].includes(x.who)).every((x) => x.schema === 'public'),
    'the first link never reaches the second server');
  assert.equal(await A.locator('#site-tabs a[href="banquet.html"]').count(), 1, "the first link's tab is unchanged");

  const bea = await open({ name: 'Bea', code: 'tide', inB: true }, devices['iPhone SE']);
  const B = bea.page;
  assert.deepEqual((await B.locator('#bq-cards li[data-key]').evaluateAll((ls) => ls.map((l) => l.dataset.key))).sort(),
    [':55555555', ':81000001', ':81000002', ':81000003', ':81000004', ':82000001'], 'only the second server');
  assert.ok(!/group|server/i.test(await B.locator('body').innerText()), 'no word of groups or another server');
  assert.ok(schemas.filter((x) => x.who === 'Bea').every((x) => x.schema === 'tide'), 'and only its own schema');
  assert.equal(await B.locator('#site-tabs a[href="banquet.html?s=tide"]').count(), 1, 'its tab keeps its link');
  await B.locator('[data-claim="82000001"]').click();
  await B.waitForTimeout(300);
  assert.deepEqual(sent.filter((x) => x.who === 'Bea' && x.fn === 'banquet_claim').at(-1),
    { who: 'Bea', fn: 'banquet_claim', body: { target: 82000001, claimed: true, g: null }, host: 'B' });

  // Not in the second server: its link shuts, having asked only the second's schema.
  const out = await open({ name: 'Out', code: 'tide', expectGate: true }, devices['iPhone SE']);
  assert.match(await out.page.locator('#bq-gate-head').textContent(), /one Discord server/);
  assert.ok(schemas.filter((x) => x.who === 'Out').every((x) => x.schema === 'tide'), 'and asked nothing of the first');
  const junk = await open({ name: 'Junk', code: 'nope', expectGate: true }, devices['iPhone SE']);
  assert.match(await junk.page.locator('#bq-gate-head').textContent(), /not right/, 'an unknown code opens nothing');

  // ------------------------------------------------------------------ both servers, for Vee
  // Let into one server of two: that one opens, and its cards still go to it.
  const half = await open({ name: 'Ana', grp: 1, code: 'duo' }, { viewport: { width: 1280, height: 900 } });
  assert.ok(await half.page.locator('#bq-cards li[data-key]').evaluateAll((ls) => ls.every((l) => l.dataset.key.startsWith('10:'))),
    'only the first server, numbered as in the view of both');
  await half.page.locator('li[data-key="10:20000001"] [data-claim]').click();
  await half.page.waitForTimeout(300);
  assert.deepEqual(sent.filter((x) => x.who === 'Ana' && x.fn === 'banquet_claim').at(-1),
    { who: 'Ana', fn: 'banquet_claim', body: { target: 20000001, claimed: true, g: null } }, 'and its presses go to the first server');
  const duo = await open({ name: 'Vee', all: true, code: 'duo', inB: true, scheme: 'light' },
    { viewport: { width: 1280, height: 900 } });
  const D = duo.page;
  const keys = await D.locator('#bq-cards li[data-key]').evaluateAll((ls) => ls.map((l) => l.dataset.key));
  assert.ok(keys.includes('11:20000001') && keys.includes('12:30000001') && keys.includes('21:82000001'), `both servers, renumbered: ${keys}`);
  assert.equal(keys.filter((k) => k.endsWith(':55555555')).length, 3, 'the same UID is a separate card per server and group');
  assert.ok(!keys.some((k) => k.startsWith('13:')), 'Both servers leaves the private list out');
  assert.equal(await D.locator('li[data-key="21:82000001"] .bq-grp').textContent(), 'Send UIDs', 'a one-group server is called by its name');
  assert.equal(await D.locator('li[data-key="12:30000001"] .bq-grp').textContent(), 'MVP UIDs · Group 2');
  assert.equal(await D.locator('[data-group="0"]').textContent(), 'Both servers');
  // Every press goes to the card's own server, with the group number that server knows.
  await D.locator('[data-claim="82000001"]').click();
  await D.waitForTimeout(300);
  assert.deepEqual(sent.filter((x) => x.who === 'Vee' && x.fn === 'banquet_claim').at(-1),
    { who: 'Vee', fn: 'banquet_claim', body: { target: 82000001, claimed: true, g: 1 }, host: 'B' });
  await D.locator('li[data-key="12:30000001"] [data-claim]').click();
  await D.waitForTimeout(300);
  assert.deepEqual(sent.filter((x) => x.who === 'Vee' && x.fn === 'banquet_claim').at(-1),
    { who: 'Vee', fn: 'banquet_claim', body: { target: 30000001, claimed: true, g: 2 } }, 'a first-server card goes to the first server');
  await D.locator('#bq-mine-fold').evaluate((d) => { d.open = true; });
  await D.fill('#bq-add-uid', '83000001');
  await D.click('#bq-add');
  assert.equal(await D.locator('#bq-mine-error').textContent(), 'Pick a server.');
  await D.click('#bq-access summary');
  await D.waitForSelector('#bq-access-body li');
  assert.match(await D.locator('#bq-access-body').innerText(), /Grabby[\s\S]*Bo/, "both servers' access logs");
  // The Claimed toast's Undo fails contrast in the light theme on every link; that is its own fix.
  await D.waitForFunction(() => !document.querySelector('#toast.is-shown'), null, { timeout: 15000 });
  await D.waitForTimeout(400);
  assert.deepEqual(await axe(D), [], 'axe, both servers');

  assert.deepEqual([...ana.errors, ...vee.errors, ...bea.errors, ...out.errors, ...junk.errors, ...half.errors, ...duo.errors], [],
    'no script errors');
  console.log('banquet page: ok');
} finally {
  await browser.close();
  server.kill();
}
