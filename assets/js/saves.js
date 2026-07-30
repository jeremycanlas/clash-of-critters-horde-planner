/**
 * Saved formations: snapshots of the whole working state — field, benches,
 * plan, name, co-op lines — kept in this browser and brought back with a click.
 *
 * Deliberately separate from the autosave. The autosave is the working copy and
 * every change overwrites it; a saved formation is a decision, taken when a
 * draft is worth keeping, and nothing overwrites it except saving the same name
 * again. Clear all leaves these alone — coming back to a kept draft after
 * wiping the field is the point of keeping it.
 *
 * Two homes, one element. On a desktop the list is a drawer off the right edge,
 * behind a tab that is always visible without costing the field or the roster
 * any room. On a phone it is a sheet over the field, opened from the app bar
 * exactly like the roster and the plan — shell.js owns that side.
 *
 * Nothing here leaves the browser: the list is localStorage, and the only
 * analytics are the two fixed labels 'save-kept' and 'save-loaded'.
 */

import { state } from './data.js';
import * as store from './store.js';
import { $, esc, artOf, toast } from './ui.js';
import { closeSheet } from './shell.js';
import { track } from './analytics.js';

const KEY = 'coc.saves.v1';

/**
 * Forty is far more drafts than anyone iterates on and small enough that the
 * list stays a list. Refused loudly rather than silently dropping the oldest —
 * these are the user's decisions, not a cache.
 */
const CAP = 40;

/** @typedef {{id: string, name: string, savedAt: number, data: object}} Save */

/** @type {Save[]} newest first */
let saves = read();

/** JSON of each save's data, for the "current" match. Rebuilt with the list. */
const jsonOf = new Map();

const DESKTOP = matchMedia('(min-width: 761px)');

function read() {
  try {
    const held = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!Array.isArray(held?.saves)) return [];
    return held.saves.filter((s) => s && typeof s === 'object'
      && typeof s.id === 'string' && s.data && typeof s.data === 'object');
  } catch { return []; }
}

/** @returns {boolean} false when the browser refused — quota, private mode. */
function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ saves }));
    return true;
  } catch { return false; }
}

const newId = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const hasAnything = (snap) =>
  (snap.bench?.[1]?.length ?? 0) + (snap.bench?.[2]?.length ?? 0) > 0;

/** "30 Jul 14:05" — the fallback name for a draft nobody named. */
function autoName(when) {
  const d = new Date(when);
  const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `Formation ${day} ${time}`;
}

/** Fresh saves say how fresh; older ones just say the day. */
function fmtSavedAt(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------- model

/**
 * Saves the current state. A save whose name matches an existing one replaces
 * it — that is how you iterate on a build — and moves it to the top, because
 * the list is newest-first and it just became the newest.
 */
function saveCurrent() {
  const snap = store.snapshot();
  if (!hasAnything(snap)) { toast('Bring some Tatari first'); return; }

  const now = Date.now();
  const name = snap.name.trim() || autoName(now);
  const at = saves.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());

  if (at === -1 && saves.length >= CAP) {
    toast(`Saved formations are full (${CAP}) — delete a few first`, 'error');
    return;
  }

  const entry = at === -1
    ? { id: newId(), name, savedAt: now, data: snap }
    : { ...saves[at], name, savedAt: now, data: snap };
  if (at !== -1) saves.splice(at, 1);
  saves.unshift(entry);

  if (!write()) {
    saves = read();
    toast('Could not save — browser storage is full or blocked', 'error');
    return;
  }
  toast(at === -1 ? `Saved “${name}”` : `Updated “${name}”`, 'ok');
  track('save-kept');
  renderSaves();
}

/**
 * Loads a save into the working state. Whatever was there is offered back
 * through the toast's Undo — loading is one click, and one click should not
 * be able to silently cost half an hour of drafting.
 */
function loadSave(id) {
  const entry = saves.find((s) => s.id === id);
  if (!entry) return;

  const before = store.snapshot();
  const stash = hasAnything(before) && JSON.stringify(before) !== jsonText(entry)
    ? before : null;

  store.applySnapshot(entry.data);
  $('#formation-name').value = store.formation.name;
  closeSheet();                       // the phone sheet covers the field it just changed

  toast(`Loaded “${entry.name}”`, 'ok', stash && {
    label: 'Undo',
    fn: () => {
      store.applySnapshot(stash);
      $('#formation-name').value = store.formation.name;
      toast('Back to what you had');
    },
  });
  track('save-loaded');
}

/** Deletes a save, with the toast holding it for one Undo. */
function deleteSave(id) {
  const at = saves.findIndex((s) => s.id === id);
  if (at === -1) return;
  const [entry] = saves.splice(at, 1);
  write();
  renderSaves();

  toast(`Deleted “${entry.name}”`, 'info', {
    label: 'Undo',
    fn: () => {
      saves.splice(Math.min(at, saves.length), 0, entry);
      write();
      renderSaves();
    },
  });
}

const jsonText = (entry) => {
  let held = jsonOf.get(entry.id);
  if (!held) { held = JSON.stringify(entry.data); jsonOf.set(entry.id, held); }
  return held;
};

// ---------------------------------------------------------------- render

/**
 * The card's map: every placed Tatari as a thumb-sized sprite on a 6×6 grid.
 * Art reads faster than names — a formation is recognised by its shape and its
 * sprites long before its title. Unknown slugs (custom Tatari from a file that
 * is no longer loaded) draw nothing, the same way the autosave drops them.
 */
function mapHTML(data) {
  const cells = Array.isArray(data.cells) ? data.cells : [];
  const tiles = cells.map((occ, i) => {
    if (!occ?.slug) return '';
    const t = state.bySlug.get(occ.slug);
    if (!t) return '';
    const place = `grid-row:${Math.floor(i / store.COLS) + 1};grid-column:${(i % store.COLS) + 1}`;
    const src = artOf(t);
    return src
      ? `<img style="${place}" src="${esc(src)}" alt="" loading="lazy" decoding="async">`
      : `<span class="save__stub" style="${place}">${esc(t.name[0] ?? '?')}</span>`;
  }).join('');
  return `<span class="save__map" aria-hidden="true">${tiles}</span>`;
}

function cardHTML(entry) {
  const d = entry.data;
  const placed = (Array.isArray(d.cells) ? d.cells : []).filter(Boolean).length;
  const modeLabel = store.MODES[d.mode]?.label ?? 'Solo';
  const steps = Array.isArray(d.plan) ? d.plan.length : 0;
  const bits = [modeLabel, `${placed} placed`];
  if (steps) bits.push(`${steps} step${steps === 1 ? '' : 's'}`);
  bits.push(fmtSavedAt(entry.savedAt));

  return `
    <li class="save" data-id="${esc(entry.id)}">
      <button class="save__main" type="button" data-load="${esc(entry.id)}"
              title="Load this formation">
        ${mapHTML(d)}
        <span class="save__body">
          <span class="save__name">${esc(entry.name)}</span>
          <span class="save__meta"><span class="save__now">On the field</span>${esc(bits.join(' · '))}</span>
        </span>
      </button>
      <button class="save__x" type="button" data-del="${esc(entry.id)}"
              aria-label="Delete ${esc(entry.name)}" title="Delete ${esc(entry.name)}">×</button>
    </li>`;
}

function renderSaves() {
  jsonOf.clear();
  $('#saves-list').innerHTML = saves.map(cardHTML).join('');
  $('#saves-empty').hidden = saves.length > 0;

  const n = saves.length ? String(saves.length) : '';
  $('#saves-count').textContent = n;
  $('#saves-handle-n').textContent = n;
  const barCount = $('#appbar-saves');
  if (barCount) barCount.textContent = n;

  refresh();
}

/**
 * The cheap half of rendering, run on every formation change: which save is
 * exactly what is on the field, and whether there is anything to save at all.
 * The list itself is only rebuilt when the list changes — rebuilding sprites
 * on every keystroke of the name field would flicker for nothing.
 */
function refresh() {
  const now = JSON.stringify(store.snapshot());
  for (const li of $('#saves-list').children) {
    const entry = saves.find((s) => s.id === li.dataset.id);
    li.classList.toggle('is-current', !!entry && jsonText(entry) === now);
  }

  const empty = !store.benchOf(1).length && !store.benchOf(2).length;
  const keep = $('#btn-keep');
  keep.disabled = empty;
  keep.title = empty
    ? 'Nothing to save yet — bring some Tatari first'
    : 'Keep a copy of the field, the benches and the plan in this browser';
}

// ---------------------------------------------------------------- drawer

/** Desktop only. The phone opens this panel as a sheet through shell.js. */
let drawerOpen = false;

/** What had focus before the drawer opened, so closing can give it back. */
let returnTo = null;

function setDrawer(open) {
  if (open === drawerOpen) return;
  drawerOpen = open;
  document.body.classList.toggle('saves-open', open);
  $('#saves-handle').setAttribute('aria-expanded', String(open));

  if (open) {
    returnTo = document.activeElement;
    const panel = $('#sec-saves');
    panel.tabIndex = -1;
    panel.focus({ preventScroll: true });
    return;
  }
  if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  returnTo = null;
}

// ---------------------------------------------------------------- build

export function buildSaves() {
  $('#btn-keep').addEventListener('click', saveCurrent);
  $('#saves-handle').addEventListener('click', () => setDrawer(!drawerOpen));
  $('#saves-close').addEventListener('click', () => setDrawer(false));

  $('#saves-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { deleteSave(del.dataset.del); return; }
    const load = e.target.closest('[data-load]');
    if (load) loadSave(load.dataset.load);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) setDrawer(false);
  });

  // Clicking anywhere that is not the drawer means "back to the field".
  // The toast is exempt: pressing its Undo is acting on the list, not leaving it.
  document.addEventListener('pointerdown', (e) => {
    if (!drawerOpen) return;
    if (e.target.closest('#sec-saves, #saves-handle, #toast')) return;
    setDrawer(false);
  });

  // Below 761px the drawer's tab is gone and the panel answers to the app bar
  // instead; an open drawer left behind would be an invisible focus trap.
  DESKTOP.addEventListener('change', (e) => { if (!e.matches) setDrawer(false); });

  store.subscribe(refresh);
  renderSaves();
}
