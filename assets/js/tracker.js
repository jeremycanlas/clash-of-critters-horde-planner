/**
 * The private player tracker: Support % per fruit for players looked up by hand.
 *
 * Every row comes from public.tracker_players, which the database only hands to
 * the Discord accounts on public.tracker_members (supabase/migrations/010). This
 * page holds no data of its own; signed out, or signed in as somebody else, it
 * gets nothing back and says so.
 */

import { rest, signIn, signOut, signedIn, readCallback, isConfigured } from './supabase.js';
import { applyPrefs } from './prefs.js';
import { showPrivateTab } from './site-nav.js';
import { $, esc, copyText } from './ui.js';
import { FRUITS, totals, filterRows, sortRows, topFor } from './tracker-filter.js';

applyPrefs();

/* Lets site-nav.js ask the database on other pages whether to show the Players
   tab. Never a key: the database decides what anybody can read. */
const MEMBER_FLAG = 'coc.tracker.member';
const setMember = (on) => {
  try { if (on) localStorage.setItem(MEMBER_FLAG, '1'); else localStorage.removeItem(MEMBER_FLAG); } catch { /* private mode */ }
};

const FILTER_KEY = 'coc.tracker.filters.v1';
const loadFilters = () => {
  try { return JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null'); } catch { return null; }
};
const saveFilters = () => {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(view)); } catch { /* fine without */ }
};

const blank = () => ({ q: '', progress: 'all', staleDays: 30, ranges: {}, sort: 'total', dir: 'desc', mode: 'table' });
const view = { ...blank(), ...(loadFilters() ?? {}) };

let rows = [];

/*
 * Test mode, on the owner's own machine only.
 *
 * Served from localhost or the home network with data/tracker.local.json present
 * (gitignored, never deployed), the page skips sign-in and the database
 * entirely: rows come from that file and edits are kept in this browser. The
 * live site never has the file, so there it is always the signed-in path.
 */
const ON_OWN_MACHINE = /^(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)$/.test(location.hostname);
const LOCAL_ROWS = 'coc.tracker.local.rows.v1';
let testMode = false;
const keepLocal = () => {
  try { localStorage.setItem(LOCAL_ROWS, JSON.stringify(rows)); } catch { /* this session only, then */ }
};

const status = (text) => { $('#tr-status').textContent = text; $('#tr-status').hidden = !text; };
const icon = (f, size = 22) => (f.tatari
  ? `<img src="data/images/tatari/${f.tatari}.png" alt="" width="${size}" height="${size}">`
  : '<span class="tr-berry" aria-hidden="true">●</span>');
const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/* A soft green by value up to 199, so a column scans without reading every
   number; 200 and up turns gold, the players worth asking for support. */
const TOP = 200;
const heat = (v) => (v == null ? '' : v >= TOP ? ' data-top'
  : ` style="--heat:${Math.max(0, Math.min(1, (v - 50) / (TOP - 50))).toFixed(2)}"`);

// ------------------------------------------------------------------ gate

async function start() {
  if (ON_OWN_MACHINE) {
    const file = await fetch('data/tracker.local.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (Array.isArray(file)) {
      testMode = true;
      let kept = null;
      try { kept = JSON.parse(localStorage.getItem(LOCAL_ROWS) ?? 'null'); } catch { /* start from the file */ }
      // The file can be updated too (numbers recorded straight into it), so per
      // player the newer of the two wins rather than the browser's copy wholesale.
      const t = (r) => (r?.updated_at ? Date.parse(r.updated_at) : 0);
      const mine = new Map((Array.isArray(kept) ? kept : []).map((r) => [r.uid, r]));
      rows = file.map((r) => (t(mine.get(r.uid)) > t(r) ? mine.get(r.uid) : r));
      for (const r of mine.values()) if (!file.some((f) => f.uid === r.uid)) rows.push(r);
      $('#tr-test').hidden = false;
      showPrivateTab();
      return show();
    }
  }

  const back = readCallback();
  if (!isConfigured()) return gate('Not connected', 'This copy of the site has no database.', false);
  if (!signedIn()) return gate('This page is private', back === 'failed'
    ? 'Discord did not sign you in. Try again.'
    : 'Sign in with Discord to see it. Only accounts on the list can open it.', true);

  $('#tr-signout').hidden = false;
  status('Checking your access…');
  const claim = await rest('/rpc/tracker_claim', { method: 'POST', body: {}, auth: true });
  if (!claim.ok) return gate('Could not check your access', claim.why, true);
  if (claim.data !== true) {
    setMember(false);
    return gate('This page is private', 'Your Discord account is not on the list. Ask the owner to add you.', false);
  }
  setMember(true);
  showPrivateTab();
  await load();
}

function gate(head, text, canSignIn) {
  status('');
  $('#tr-gate').hidden = false;
  $('#tr-app').hidden = true;
  $('#tr-gate-head').textContent = head;
  $('#tr-gate-text').textContent = text;
  $('#tr-signin').hidden = !canSignIn;
}

async function load() {
  status('Loading players…');
  const got = await rest('/tracker_players?select=*&order=uid', { auth: true });
  if (!got.ok) return gate('Could not load the players', got.why, true);
  rows = got.data ?? [];
  show();
  loadDeleted();
}

function show() {
  status('');
  $('#tr-gate').hidden = true;
  $('#tr-app').hidden = false;
  buildControls();
  render();
}

// ------------------------------------------------------------------ controls

function buildControls() {
  // Open on a wide screen, and on a phone whenever a range is already set.
  $('#tr-filters').open = matchMedia('(min-width: 761px)').matches
    || Object.values(view.ranges).some((r) => r && (r.min != null || r.max != null));
  $('#tr-q').value = view.q;
  $('#tr-progress').value = view.progress;
  $('#tr-stale').value = view.staleDays;
  $('#tr-stale-wrap').hidden = view.progress !== 'stale';
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view.mode));

  $('#tr-filters-icons').innerHTML = FRUITS.map((f) => icon(f, 18)).join('');
  $('#tr-ranges').innerHTML = FRUITS.map((f) => {
    const r = view.ranges[f.key] ?? {};
    return `<fieldset class="tr-range">
      <legend>${icon(f, 18)}${esc(f.name)}</legend>
      <input class="field" type="number" inputmode="numeric" min="0" max="999" data-range="${f.key}" data-end="min"
        value="${r.min ?? ''}" placeholder="min" aria-label="${esc(f.name)} at least">
      <span aria-hidden="true">–</span>
      <input class="field" type="number" inputmode="numeric" min="0" max="999" data-range="${f.key}" data-end="max"
        value="${r.max ?? ''}" placeholder="max" aria-label="${esc(f.name)} at most">
    </fieldset>`;
  }).join('');
}

function headHTML() {
  const col = (key, label, cls = '') => {
    const on = view.sort === key;
    const sort = on ? (view.dir === 'desc' ? 'descending' : 'ascending') : 'none';
    return `<th class="${cls}" aria-sort="${sort}"><button type="button" data-sort="${key}">${label}${on ? `<span aria-hidden="true">${view.dir === 'desc' ? ' ▼' : ' ▲'}</span>` : ''}</button></th>`;
  };
  return `<tr>
    ${col('uid', 'UID', 'tr-c-uid')}
    ${col('name', 'Name', 'tr-c-name')}
    ${FRUITS.map((f) => col(f.key, `${icon(f)}<span class="tr-fruitname">${esc(f.name)}</span>`, 'tr-c-num')).join('')}
    ${col('total', 'Total', 'tr-c-num')}
    ${col('checked_at', 'Checked', 'tr-c-date')}
    <th class="tr-c-by">Updated by</th>
  </tr>`;
}

function rowHTML(r) {
  const { total, filled } = totals(r);
  return `<tr data-uid="${r.uid}" tabindex="0">
    <td class="tr-c-uid"><button type="button" class="tr-copy" data-copy="${r.uid}" title="Copy UID">${r.uid}</button></td>
    <td class="tr-c-name"><b>${esc(r.name || '—')}</b>${r.aliases ? `<small>${esc(r.aliases)}</small>` : ''}<button type="button" class="tr-copy tr-copy--inname" data-copy="${r.uid}" title="Copy UID">${r.uid}</button></td>
    ${FRUITS.map((f) => `<td class="tr-c-num tr-heat"${heat(r[f.key])}>${r[f.key] ?? '<span class="tr-empty">·</span>'}</td>`).join('')}
    <td class="tr-c-num tr-total">${filled ? total : ''}<small>${filled}/6</small></td>
    <td class="tr-c-date">${when(r.checked_at)}</td>
    <td class="tr-c-by">${esc(r.updated_by ?? '')}</td>
  </tr>`;
}

function render() {
  const shown = sortRows(filterRows(rows, view), view.sort, view.dir);
  $('#tr-count').textContent = `${shown.length} of ${rows.length}`;
  const on = Object.values(view.ranges).filter((r) => r && (r.min != null || r.max != null)).length;
  $('#tr-filters-on').textContent = on ? `${on} on` : '';
  const table = view.mode === 'table';
  $('#tr-table-wrap').hidden = !table;
  $('#tr-top').hidden = table;

  if (table) {
    $('#tr-head').innerHTML = headHTML();
    $('#tr-body').innerHTML = shown.length
      ? shown.map(rowHTML).join('')
      : `<tr><td colspan="${FRUITS.length + 5}" class="tr-none">No players match these filters.</td></tr>`;
  } else {
    // The same filters apply, so "top Clock among the ones not checked this month" works.
    $('#tr-top').innerHTML = FRUITS.map((f) => {
      const best = topFor(shown, f.key, 20);
      return `<section class="panel tr-board">
        <h3>${icon(f, 26)}${esc(f.name)}${f.who ? ` <span class="muted">${esc(f.who)}</span>` : ''}</h3>
        <ol>${best.map((r) => `<li data-uid="${r.uid}"><span>${esc(r.name || String(r.uid))}</span><button type="button" class="tr-copy tr-copy--small" data-copy="${r.uid}" title="Copy UID">${r.uid}</button><b${r[f.key] >= TOP ? ' data-top' : ''}>${r[f.key]}</b></li>`).join('')
          || '<li class="muted">Nobody recorded yet.</li>'}</ol>
      </section>`;
    }).join('');
  }
  saveFilters();
}

// ------------------------------------------------------------------ edit

function openEdit(uid) {
  const r = uid == null ? null : rows.find((x) => x.uid === uid);
  $('#tr-edit-head').textContent = r ? (r.name || `UID ${r.uid}`) : 'Add a player';
  $('#tr-f-uid').value = r?.uid ?? '';
  $('#tr-f-uid').readOnly = !!r;
  $('#tr-f-name').value = r?.name ?? '';
  $('#tr-f-aliases').value = r?.aliases ?? '';
  $('#tr-f-fruits').innerHTML = FRUITS.map((f) => `<label>${icon(f)}<span>${esc(f.name)}${f.who ? `<small>${esc(f.who)}</small>` : ''}</span>
      <input class="field" type="number" inputmode="numeric" min="0" max="999" data-fruit="${f.key}" value="${r?.[f.key] ?? ''}"></label>`).join('');
  $('#tr-f-checked').value = r?.checked_at ? r.checked_at.slice(0, 10) : '';
  $('#tr-f-meta').textContent = r?.updated_by ? `Last updated by ${r.updated_by}, ${when(r.updated_at)}.` : '';
  $('#tr-f-delete').hidden = !r;
  $('#tr-f-delete').textContent = 'Delete player';
  $('#tr-f-error').hidden = true;
  $('#tr-edit').dataset.uid = r ? String(r.uid) : '';
  $('#tr-f-history').hidden = !r || testMode;
  $('#tr-f-history').open = false;
  $('#tr-f-hist-list').innerHTML = '';
  if (r && !testMode) loadHistory(r.uid);
  $('#tr-edit').showModal();
  // Straight to the numbers when re-checking someone; to the UID when adding.
  (r ? document.querySelector('[data-fruit]') : $('#tr-f-uid')).focus();
}

// ------------------------------------------------------------------ history

const FIELDS = [['name', 'Name'], ['aliases', 'Aliases'], ...FRUITS.map((f) => [f.key, f.name])];
let history = [];

/* What one change did, as "Clock 126 → 149". */
function diff(h) {
  if (h.action === 'insert') return 'Added';
  if (h.action === 'delete') return 'Deleted';
  const parts = FIELDS.filter(([k]) => (h.before?.[k] ?? null) !== (h.after?.[k] ?? null))
    .map(([k, label]) => `${label} ${h.before?.[k] ?? '–'} → ${h.after?.[k] ?? '–'}`);
  return parts.join(', ') || 'Checked date only';
}

async function loadHistory(uid) {
  const got = await rest(`/tracker_history?uid=eq.${uid}&order=changed_at.desc&limit=50`, { auth: true });
  if (Number($('#tr-edit').dataset.uid) !== uid) return; // dialog moved on
  history = got.ok ? got.data ?? [] : [];
  $('#tr-f-history').querySelector('summary').textContent = `Change history (${history.length})`;
  $('#tr-f-hist-list').innerHTML = history.length
    ? history.map((h, i) => `<li>
        <span class="tr-history__when">${when(h.changed_at)} · ${esc(h.changed_by)}</span>
        <span>${esc(diff(h))}</span>
        ${h.before ? `<button type="button" class="btn btn--quiet tr-history__use" data-hist="${i}">Use the numbers from before this</button>` : ''}
      </li>`).join('')
    : `<li class="muted">${got.ok ? 'No changes since it was loaded.' : esc(got.why)}</li>`;
}

// Fills the form only. Nothing changes until Save, and that save is recorded too.
$('#tr-f-hist-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hist]');
  if (!b) return;
  const was = history[Number(b.dataset.hist)].before;
  $('#tr-f-name').value = was.name ?? '';
  $('#tr-f-aliases').value = was.aliases ?? '';
  for (const input of document.querySelectorAll('[data-fruit]')) input.value = was[input.dataset.fruit] ?? '';
  $('#tr-f-checked').value = was.checked_at ? was.checked_at.slice(0, 10) : '';
  $('#tr-f-meta').textContent = 'Older numbers filled in. Press Save to put them back.';
  $('#tr-f-save').focus();
});

async function loadDeleted() {
  const got = await rest('/tracker_history?action=eq.delete&order=changed_at.desc&limit=100', { auth: true });
  if (!got.ok) return;
  const seen = new Set(rows.map((r) => r.uid));
  const gone = (got.data ?? []).filter((h) => !seen.has(h.uid) && !seen.has(-h.uid) && seen.add(-h.uid));
  $('#tr-deleted').hidden = !gone.length;
  $('#tr-deleted').querySelector('summary').textContent = `Deleted players (${gone.length})`;
  $('#tr-deleted-list').innerHTML = gone.map((h) => `<li>
      <span><b>${esc(h.before.name || String(h.uid))}</b> <span class="muted">${h.uid}</span></span>
      <span class="tr-history__when">Deleted ${when(h.changed_at)} · ${esc(h.changed_by)}</span>
      <button type="button" class="btn btn--quiet" data-restore="${h.id}">Restore</button>
    </li>`).join('');
  $('#tr-deleted-list').onclick = async (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    const h = gone.find((x) => String(x.id) === b.dataset.restore);
    const { updated_at, updated_by, ...row } = h.before;
    b.disabled = true;
    const put = await rest('/tracker_players', { method: 'POST', body: row, auth: true, headers: { prefer: 'return=representation' } });
    if (!put.ok) { b.disabled = false; b.textContent = put.why; return; }
    rows = [...rows, put.data[0]];
    render();
    loadDeleted();
  };
}

// Typing a number means you just read it off the game: date it today.
$('#tr-f-fruits').addEventListener('input', () => {
  $('#tr-f-checked').value = new Date().toISOString().slice(0, 10);
});

async function save() {
  const existing = $('#tr-edit').dataset.uid;
  const uid = Number($('#tr-f-uid').value);
  if (!Number.isInteger(uid) || uid <= 0) return fail('The UID has to be a whole number.');
  if (!existing && rows.some((r) => r.uid === uid)) return fail('That UID is already in the list.');

  const body = { name: $('#tr-f-name').value.trim(), aliases: $('#tr-f-aliases').value.trim() || null };
  for (const input of document.querySelectorAll('[data-fruit]')) {
    const v = input.value.trim();
    if (v !== '' && !(Number(v) >= 0 && Number(v) <= 999)) return fail('Each % has to be between 0 and 999.');
    body[input.dataset.fruit] = v === '' ? null : Math.round(Number(v));
  }
  const d = $('#tr-f-checked').value;
  body.checked_at = d ? new Date(`${d}T12:00:00`).toISOString() : null;

  if (testMode) {
    const saved = { ...(rows.find((r) => r.uid === uid) ?? { uid }), ...body, updated_by: 'You (test mode)', updated_at: new Date().toISOString() };
    rows = existing ? rows.map((r) => (r.uid === uid ? saved : r)) : [...rows, saved];
    keepLocal();
    $('#tr-edit').close();
    return render();
  }

  $('#tr-f-save').disabled = true;
  const got = existing
    ? await rest(`/tracker_players?uid=eq.${uid}`, { method: 'PATCH', body, auth: true, headers: { prefer: 'return=representation' } })
    : await rest('/tracker_players', { method: 'POST', body: { uid, ...body }, auth: true, headers: { prefer: 'return=representation' } });
  $('#tr-f-save').disabled = false;
  if (!got.ok) return fail(got.why);
  const saved = got.data?.[0];
  if (!saved) return fail('The database did not accept that. Your access may have changed; reload the page.');
  rows = existing ? rows.map((r) => (r.uid === uid ? saved : r)) : [...rows, saved];
  $('#tr-edit').close();
  render();
}

function fail(text) {
  $('#tr-f-error').textContent = text;
  $('#tr-f-error').hidden = false;
}

// Two presses, no browser dialog: the first arms it, the second deletes.
$('#tr-f-delete').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.textContent !== 'Press again to delete') { btn.textContent = 'Press again to delete'; return; }
  const uid = Number($('#tr-edit').dataset.uid);
  if (!testMode) {
    const got = await rest(`/tracker_players?uid=eq.${uid}`, { method: 'DELETE', auth: true });
    if (!got.ok) return fail(got.why);
  }
  rows = rows.filter((r) => r.uid !== uid);
  if (testMode) keepLocal(); else loadDeleted();
  $('#tr-edit').close();
  render();
});

$('#tr-form').addEventListener('submit', (e) => {
  if (e.submitter?.value === 'save') { e.preventDefault(); save(); }
});

// ------------------------------------------------------------------ wiring

$('#tr-signin').addEventListener('click', () => signIn());
$('#tr-signout').addEventListener('click', () => { signOut(); setMember(false); location.reload(); });

$('#tr-q').addEventListener('input', (e) => { view.q = e.target.value; render(); });
$('#tr-progress').addEventListener('change', (e) => {
  view.progress = e.target.value;
  $('#tr-stale-wrap').hidden = view.progress !== 'stale';
  render();
});
$('#tr-stale').addEventListener('input', (e) => { view.staleDays = Math.max(1, Number(e.target.value) || 30); render(); });
$('#tr-ranges').addEventListener('input', (e) => {
  const { range, end } = e.target.dataset;
  if (!range) return;
  const v = e.target.value.trim();
  view.ranges[range] = { ...(view.ranges[range] ?? {}), [end]: v === '' ? null : Number(v) };
  render();
});
$('#tr-clear').addEventListener('click', () => {
  Object.assign(view, { ...blank(), sort: view.sort, dir: view.dir, mode: view.mode });
  buildControls();
  render();
});
for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => {
    view.mode = b.dataset.view;
    for (const x of document.querySelectorAll('[data-view]')) x.setAttribute('aria-pressed', String(x === b));
    render();
  });
}
$('#tr-head').addEventListener('click', (e) => {
  const key = e.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  // A new column starts at its best end: highest numbers, A to Z names.
  view.dir = view.sort === key ? (view.dir === 'desc' ? 'asc' : 'desc') : (key === 'name' || key === 'uid' ? 'asc' : 'desc');
  view.sort = key;
  render();
});
/* Click a UID: it goes to the clipboard for pasting into the game's search,
   and the row does not open. Before the row handlers, which it stops. */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.tr-copy');
  if (!btn) return;
  e.stopPropagation();
  const ok = await copyText(btn.dataset.copy);
  btn.classList.add(ok ? 'is-copied' : 'is-failed');
  btn.dataset.label = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { btn.classList.remove('is-copied', 'is-failed'); delete btn.dataset.label; }, 1200);
}, true);

$('#tr-body').addEventListener('click', (e) => {
  const uid = e.target.closest('tr[data-uid]')?.dataset.uid;
  if (uid) openEdit(Number(uid));
});
$('#tr-body').addEventListener('keydown', (e) => {
  const uid = e.target.closest('tr[data-uid]')?.dataset.uid;
  if (uid && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEdit(Number(uid)); }
});
$('#tr-top').addEventListener('click', (e) => {
  const uid = e.target.closest('li[data-uid]')?.dataset.uid;
  if (uid) openEdit(Number(uid));
});
$('#tr-add').addEventListener('click', () => openEdit(null));
$('#tr-test-reset').addEventListener('click', async () => {
  try { localStorage.removeItem(LOCAL_ROWS); } catch { /* nothing kept */ }
  location.reload();
});

start();
