/**
 * The range recorder.
 *
 * Attack range is only published as in-game screenshots and support reach is not
 * published at all, so both have to be read off the game by hand. That is why 72
 * of 218 Tatari have an attack range recorded and none have a heal, buff or
 * debuff one. The bottleneck was never the data — people in the community can
 * see these ranges any time they play — it was that contributing meant cloning a
 * repo, running a Python script over a screenshot, and hand-editing JSON.
 *
 * So this is the whole job in one page: pick a Tatari, stand it where the
 * screenshot had it, click what it reached, and take away the entry. It writes
 * nothing and uploads nothing; the output is text you choose to send.
 *
 * Tiles are stored as offsets from the Tatari's own tile, matching
 * data/ranges.json: column positive to the right, row NEGATIVE towards the
 * Zobos. Keeping the offsets rather than the clicked cells means moving the
 * Tatari afterwards carries its pattern along instead of scrambling it.
 */

import { load, state } from './data.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast, copyText } from './ui.js';
import { buildFilters, renderRoster } from './roster.js';
import { buildShell, closeSheet } from './shell.js';
import { rangeStatus } from './range.js';

const REPO = 'jeremycanlas/clash-of-critters-horde-planner';

/**
 * What can be recorded, and where each one belongs.
 *
 * Attack goes to the file the app already reads. The three support ranges have
 * no home yet — nobody has recorded one — so they are pointed at a file of their
 * own rather than smuggled into the attack data under a flag, which would make
 * every existing consumer of ranges.json have to care.
 */
const KINDS = [
  {
    id: 'attack', label: 'Attack', file: 'data/ranges.json',
    note: 'The tiles it can hit. This is what the Ranges overlay in the drafter draws.',
    all: 'Hits the whole field — no tile pattern',
  },
  {
    id: 'heal', label: 'Heal', file: 'data/effect-ranges.json',
    note: 'How far its healing reaches. Nobody has recorded one of these yet — you would be first.',
    all: 'Heals the whole team — no tile pattern',
  },
  {
    id: 'buff', label: 'Buff', file: 'data/effect-ranges.json',
    note: 'How far its buffs reach — ATK Boost, Shield, DMG Reduction and so on.',
    all: 'Buffs the whole team — no tile pattern',
  },
  {
    id: 'debuff', label: 'Debuff', file: 'data/effect-ranges.json',
    note: 'How far its debuffs reach — Slow, Weaken, Bind and so on.',
    all: 'Hits every enemy — no tile pattern',
  },
];

let COLS = 6;
let ROWS = 6;

/**
 * Rows drawn beyond the line, which Tatari reach into but never stand on.
 *
 * Seven because the data already goes that far: the deepest offset on file is
 * row -7, and on a 6x6 alone the furthest anything can reach ahead is 5. Those
 * ranges were simply not expressible here before.
 */
const ENEMY_ROWS = 7;

const picked = {
  slug: null,
  kind: 'attack',
  /**
   * {col, row} the Tatari stands on, or null while it is being placed. Row 0 is
   * the field's contact line and row 5 is nearest your base; rows beyond the
   * line are negative, matching how offsets are stored.
   */
  origin: null,
  /** @type {Set<string>} "dCol,dRow" offsets, so a move keeps the shape. */
  tiles: new Set(),
  /**
   * 'tiles' for a pattern, 'all' for a reach with no shape — a heal that mends
   * the whole team, a debuff that lands on everything. Recording those as a
   * pattern would invent a limit the game does not have, and a reader could not
   * tell the invention from a measurement.
   */
  scope: 'tiles',
};
const key = (dCol, dRow) => `${dCol},${dRow}`;

// ---------------------------------------------------------------- boot

async function main() {
  try {
    await load();
  } catch (err) {
    $('#roster').innerHTML =
      '<p class="hint">Could not load the roster. If you opened this file directly, '
      + 'serve the folder over HTTP instead — browsers block data loading on <code>file://</code>.</p>';
    console.error(err);
    return;
  }

  COLS = state.meta?.hordeGrid?.columns ?? 6;
  ROWS = state.meta?.hordeGrid?.rows ?? 6;
  // Back row, middle column: the deepest a Tatari can stand, which is where a
  // range that reaches a long way forward has room to be drawn.
  picked.origin = { col: Math.floor(COLS / 2), row: ROWS - 1 };

  restoreQueue();
  buildGrid();
  buildKinds();
  // The drafter's roster, whole: its search, filters, cards and detail sheet.
  // Only the meaning of a click changes.
  buildFilters(refreshRoster, { onPick: choose });
  // The drafter's phone shell, unchanged: below 760px the recorder owns the
  // screen and the roster becomes a sheet the app bar opens.
  buildShell();
  wire();
  refreshRoster();
  renderAll();
}

function wire() {
  $('#kinds').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-kind]');
    if (!chip) return;
    if (chip.dataset.kind === picked.kind) return;
    // Each reach is its own edit, so the one in progress is put away rather
    // than carried across — a heal range that is really an attack range is
    // exactly the mistake this avoids.
    saveCurrent();
    if (picked.slug) loadInto(picked.slug, chip.dataset.kind);
    else picked.kind = chip.dataset.kind;
    // Coverage is per reach: switching to Heals should show a roster of red,
    // because none of it is recorded yet.
    refreshRoster();
    renderAll();
  });

  // One listener for both grids: reaching beyond the line is the same gesture
  // as reaching across the field.
  $('.field-frame').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const col = Number(cell.dataset.col), row = Number(cell.dataset.row);
    // Nothing to draw when the reach has no shape.
    if (picked.scope === 'all') return;

    if (picked.origin === null) {
      if (row < 0) {
        toast('Tatari stand on the field, not beyond the line', 'error');
        return;
      }
      picked.origin = { col, row };
      renderAll();
      return;
    }

    const k = key(col - picked.origin.col, row - picked.origin.row);
    if (picked.tiles.has(k)) picked.tiles.delete(k);
    else picked.tiles.add(k);
    saveCurrent();
    refreshRoster();
    renderAll();
  });

  $('#opt-all').addEventListener('change', (e) => {
    picked.scope = e.target.checked ? 'all' : 'tiles';
    saveCurrent();
    refreshRoster();
    renderAll();
  });

  $('#btn-move').addEventListener('click', () => {
    picked.origin = null;
    renderAll();
    toast('Click where it was standing');
  });

  $('#btn-clear').addEventListener('click', () => {
    picked.tiles.clear();
    // The note describes the tiles. Starting the shape over while keeping a
    // prefilled "7 tiles, 3 wide and 3 deep" is how a wrong description gets
    // filed alongside a right range.
    $('#note').value = '';
    saveCurrent();
    refreshRoster();
    renderAll();
  });

  for (const id of ['#from', '#note']) {
    const sync = () => { saveCurrent(); renderQueue(); renderOutput(); };
    $(id).addEventListener('input', sync);
    $(id).addEventListener('change', sync);
  }

  // The queue: clicking an entry returns to it, the × drops it.
  $('#queue').addEventListener('click', (e) => {
    const drop = e.target.closest('[data-drop]');
    if (drop) {
      queue.delete(queueKey(drop.dataset.drop, drop.dataset.kind));
      persistQueue();
      // Dropping the one being edited leaves the grid holding tiles that are no
      // longer queued, so it is cleared to match.
      if (drop.dataset.drop === picked.slug && drop.dataset.kind === picked.kind) {
        picked.tiles.clear();
      }
      refreshRoster();
      renderAll();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (!open) return;
    saveCurrent();
    loadInto(open.dataset.open, open.dataset.kind);
    refreshRoster();
    renderAll();
  });

  $('#btn-queue-clear').addEventListener('click', () => {
    const n = queue.size;
    if (!n) return;
    queue.clear();
    persistQueue();
    picked.tiles.clear();
    refreshRoster();
    renderAll();
    toast(`Queue cleared — ${n} edit${n === 1 ? '' : 's'} dropped`);
  });

  $('#btn-copy').addEventListener('click', async () => {
    toast(await copyText(entryText()) ? 'Entry copied' : 'Could not copy — select it and copy by hand',
      'ok');
  });

  $('#btn-download').addEventListener('click', () => {
    const n = queue.size;
    const name = n === 1
      ? `range-${[...queue.values()][0].kind}-${[...queue.values()][0].slug}.json`
      : `ranges-${n}-entries.json`;
    const blob = new Blob([entryText()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Saved ${name}`, 'ok');
  });
}

// ---------------------------------------------------------------- the queue

/**
 * Everything recorded this session, keyed by Tatari and reach.
 *
 * Reading ranges is slow and repetitive, and doing one at a time meant one
 * issue at a time. An edit joins the queue the moment it has a tile on it and
 * is handed straight back if you return to that Tatari, so leaving one to check
 * another and coming back is not a loss.
 *
 * Keyed by reach as well as slug: a Tatari's attack range and its heal range
 * are two entries in two different files, and one would otherwise silently
 * overwrite the other.
 *
 * @type {Map<string, {slug: string, kind: string, tiles: string[], note: string,
 *   from: string, origin: {col: number, row: number}}>}
 */
const queue = new Map();

const QUEUE_KEY = 'coc.rangequeue.v1';
const queueKey = (slug, kind) => `${kind}\n${slug}`;

/** Writes the edit in progress, or drops it once its last tile is taken off. */
function saveCurrent() {
  if (!picked.slug) return;
  const k = queueKey(picked.slug, picked.kind);

  // A whole-team reach is a complete edit with no tiles at all, so an empty
  // tile set is only empty when a pattern was what was being drawn.
  if (picked.scope !== 'all' && !picked.tiles.size) queue.delete(k);
  else {
    queue.set(k, {
      slug: picked.slug,
      kind: picked.kind,
      scope: picked.scope,
      tiles: [...picked.tiles],
      note: $('#note').value.trim(),
      from: $('#from').value,
      origin: { ...picked.origin },
    });
  }
  persistQueue();
}

/** Picks up a queued edit, or starts one from whatever is already on file. */
function loadInto(slug, kind) {
  picked.slug = slug;
  picked.kind = kind;
  picked.tiles.clear();

  const held = queue.get(queueKey(slug, kind));
  if (held) {
    for (const t of held.tiles) picked.tiles.add(t);
    picked.scope = held.scope ?? 'tiles';
    $('#note').value = held.note;
    $('#from').value = held.from;
    picked.origin = { ...held.origin };
    return;
  }
  picked.scope = 'tiles';
  $('#note').value = '';
  prefillFromData();
}

function persistQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify([...queue.values()])); }
  catch { /* private mode; the queue just will not outlive the tab */ }
}

/**
 * Reading a dozen ranges is an evening's work, and a stray reload should not
 * cost it.
 */
function restoreQueue() {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (!Array.isArray(raw)) return;
    for (const e of raw) {
      if (!e?.slug || !Array.isArray(e.tiles)) continue;
      if (!e.tiles.length && e.scope !== 'all') continue;
      queue.set(queueKey(e.slug, e.kind), {
        slug: e.slug,
        kind: KINDS.some((k) => k.id === e.kind) ? e.kind : 'attack',
        scope: e.scope === 'all' ? 'all' : 'tiles',
        tiles: e.tiles.map(String),
        note: typeof e.note === 'string' ? e.note : '',
        from: typeof e.from === 'string' ? e.from : 'range diagram',
        origin: e.origin ?? { col: Math.floor(COLS / 2), row: ROWS - 1 },
      });
    }
  } catch { /* nothing worth keeping */ }
}

function renderQueue() {
  const all = [...queue.values()];
  $('#queue-count').textContent = all.length
    ? `${all.length} edit${all.length === 1 ? '' : 's'}` : '';
  $('#btn-queue-clear').disabled = !all.length;

  if (!all.length) {
    $('#queue').innerHTML =
      '<p class="hint contrib__aside">Nothing queued. Click a tile and this fills in.</p>';
    return;
  }

  $('#queue').innerHTML = all.map((e) => {
    const t = state.bySlug.get(e.slug);
    const here = e.slug === picked.slug && e.kind === picked.kind;
    return `
      <button class="contrib__qitem" type="button" data-open="${esc(e.slug)}" data-kind="${esc(e.kind)}"
              aria-current="${here}" title="${esc(t?.name ?? e.slug)} — ${e.kind}, ${e.tiles.length} tiles">
        ${t ? artHTML(t, { lazy: false }) : ''}
        <span class="contrib__qname">${esc(t?.name ?? e.slug)}</span>
        <span class="contrib__qkind" data-kind="${esc(e.kind)}">${esc(e.kind)}</span>
        <span class="contrib__qn">${e.scope === 'all' ? 'all' : e.tiles.length}</span>
        <span class="contrib__qx" role="button" tabindex="-1" data-drop="${esc(e.slug)}"
              data-kind="${esc(e.kind)}" aria-label="Take this edit off the queue">&times;</span>
      </button>`;
  }).join('');
}

// ---------------------------------------------------------------- picking

/**
 * The roster, plus a mark on every card saying whether this reach is on file
 * and whether it is waiting in the queue.
 *
 * Painted after roster.js has rendered rather than from inside it: coverage is
 * this page's business, and a drafter picking a team has no use for knowing
 * which ranges happen to be documented.
 */
function refreshRoster() {
  renderRoster();
  for (const card of document.querySelectorAll('#roster .card')) {
    const slug = card.dataset.slug;
    card.dataset.range = rangeStatus(slug, picked.kind);
    card.dataset.queued = String(queue.has(queueKey(slug, picked.kind)));
  }
}

/** What a roster card click means here: record this one. */
function choose(slug) {
  saveCurrent();
  loadInto(slug, picked.kind);
  // On a phone the roster is a sheet over the grid, and the grid is where you
  // are going next. Above 760px this does nothing.
  closeSheet();
  renderAll();

  const held = queue.get(queueKey(slug, picked.kind));
  toast(held
    ? `Back to ${state.bySlug.get(slug)?.name ?? slug} — ${held.tiles.length} tiles kept`
    : `Recording ${state.bySlug.get(slug)?.name ?? slug}`);
}

/**
 * Loads whatever is already on file for this Tatari and reach.
 *
 * Verifying an existing entry is as useful as adding a missing one — several
 * were read off a sibling's diagram and are marked UNVERIFIED — and it is much
 * easier to check a shape than to describe one.
 */
function prefillFromData() {
  if (!picked.slug) return;
  const t = state.bySlug.get(picked.slug);
  if (!t) return;

  const book = picked.kind === 'attack' ? state.ranges : state.effectRanges?.[picked.kind];
  const base = state.all.find((x) => x.familyId === t.familyId && x.tier === 1) ?? t;
  const entry = book?.bySlug?.[picked.slug] ?? book?.byLine?.[base.slug];
  if (!entry?.tiles) return;

  for (const [dCol, dRow] of entry.tiles) picked.tiles.add(key(dCol, dRow));
  if (entry.note) $('#note').value = entry.note;
}

// ---------------------------------------------------------------- rendering

function buildGrid() {
  const cell = (col, row, cls) =>
    `<div class="cell ${cls}" role="gridcell" data-col="${col}" data-row="${row}"></div>`;

  // Beyond the line: rows -7 up to -1, with -1 sitting directly on the line.
  $('#enemy').innerHTML = Array.from({ length: ENEMY_ROWS }, (_, i) =>
    Array.from({ length: COLS }, (_, col) => cell(col, i - ENEMY_ROWS, 'cell--enemy')).join('')).join('');

  $('#grid').innerHTML = Array.from({ length: ROWS }, (_, row) =>
    Array.from({ length: COLS }, (_, col) => cell(col, row, '')).join('')).join('');
}

function buildKinds() {
  $('#kinds').innerHTML = KINDS.map((k) => `
    <button class="chip" type="button" data-kind="${k.id}" aria-pressed="false">${k.label}</button>`)
    .join('');
}

function renderAll() {
  renderChosen();
  renderKinds();
  renderGrid();
  renderQueue();
  renderOutput();
}

function renderChosen() {
  const box = $('#chosen');
  const t = picked.slug ? state.bySlug.get(picked.slug) : null;
  box.classList.toggle('contrib__chosen--empty', !t);
  if (!t) { box.textContent = 'Pick one from the roster.'; return; }

  box.innerHTML = `
    <span class="contrib__art" data-type="${esc(t.type)}">${artHTML(t, { lazy: false })}</span>
    <span class="contrib__who">
      <b>${esc(t.name)}</b>
      <span class="muted">${typeIcon(t.type)} ${esc(t.type)} · ${roleIcon(t.role)} ${esc(t.role)} · T${t.tier}</span>
    </span>`;
}

function renderKinds() {
  const kind = KINDS.find((k) => k.id === picked.kind);
  for (const chip of $('#kinds').children) {
    chip.setAttribute('aria-pressed', String(chip.dataset.kind === picked.kind));
  }
  $('#kind-note').textContent = kind?.note ?? '';
  // Worded per reach: "hits the whole field" and "heals the whole team" are the
  // same shape of claim about very different things.
  $('#opt-all-label').textContent = kind?.all ?? 'Reaches everything — no tile pattern';
  $('#opt-all').checked = picked.scope === 'all';
}

function renderGrid() {
  const everywhere = picked.scope === 'all';
  const placing = !everywhere && picked.origin === null;

  $('.field-frame').classList.toggle('is-everywhere', everywhere);
  $('#grid-hint').textContent = everywhere
    ? 'No tiles to click — this one reaches regardless of where anything is standing.'
    : placing
      ? 'Click the tile on the field it was standing on. Only the 6×6 can be stood on.'
      : 'Click every tile it reached, beyond the line as well. Click one again to take it back off.';

  let shown = 0;
  for (const cell of document.querySelectorAll('.field-frame .cell')) {
    const col = Number(cell.dataset.col), row = Number(cell.dataset.row);
    const isOrigin = !placing && !everywhere && picked.origin
      && col === picked.origin.col && row === picked.origin.row;
    const covered = !placing && !everywhere && picked.origin
      && picked.tiles.has(key(col - picked.origin.col, row - picked.origin.row));
    if (covered) shown++;

    cell.classList.toggle('is-origin', isOrigin);
    cell.classList.toggle('is-covered', covered);
    cell.classList.toggle('is-placing', placing);
    cell.innerHTML = isOrigin && picked.slug
      ? `<span class="contrib__token">${artHTML(state.bySlug.get(picked.slug), { lazy: false })}</span>`
      : '';

    const where = row < 0
      ? `${-row} beyond the line, column ${col + 1}`
      : `Row ${row + 1}, column ${col + 1}`;
    cell.setAttribute('aria-label', `${where}${
      isOrigin ? ', where the Tatari stands' : covered ? ', reached' : ''}`);
  }

  // An offset can still fall outside what is drawn — sideways, or behind the
  // back row. They are kept rather than dropped, but silently keeping them
  // would be its own trap.
  const lost = placing || everywhere ? 0 : picked.tiles.size - shown;
  $('#btn-clear').disabled = picked.tiles.size === 0 || everywhere;
  $('#btn-move').disabled = everywhere;
  if (lost > 0) {
    $('#grid-hint').textContent
      += ` ${lost} recorded tile${lost === 1 ? '' : 's'} sit outside the board from here — move it to see them.`;
  }
}

// ---------------------------------------------------------------- output

/** Sorted so two people recording the same range produce the same text. */
function tileList(tiles) {
  return [...tiles]
    .map((k) => k.split(',').map(Number))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** One tile per line reads as a shape; the default puts every number on its
 *  own line and the pattern disappears. */
const pretty = (obj) => JSON.stringify(obj, null, 2)
  .replace(/\[\n\s+(-?\d+),\n\s+(-?\d+)\n\s+\]/g, '[$1, $2]');

/**
 * The whole queue, grouped by the file each reach belongs in.
 *
 * Grouped rather than listed flat because the two destinations take different
 * shapes — ranges.json is keyed by slug at its top level, effect-ranges.json is
 * keyed by reach first — and a contributor should not have to work that out from
 * a paragraph of instructions.
 */
function entryText() {
  const all = [...queue.values()];
  if (!all.length) return '// Click a tile and the entry appears here.';

  const attack = all.filter((e) => e.kind === 'attack');
  const effects = all.filter((e) => e.kind !== 'attack');
  // "all" carries no tiles at all rather than tiles plus a flag. A reader
  // reaching for .tiles gets nothing and has to notice why, which is safer than
  // handing them a pattern that was never measured.
  const body = (e) => (e.scope === 'all'
    ? { scope: 'all', ...(e.note ? { note: e.note } : {}), from: e.from }
    : { tiles: tileList(e.tiles), ...(e.note ? { note: e.note } : {}), from: e.from });

  const out = [];
  if (attack.length) {
    out.push('// data/ranges.json  →  "bySlug"',
      pretty(Object.fromEntries(attack.map((e) => [e.slug, body(e)]))));
  }
  if (effects.length) {
    const byKind = {};
    for (const e of effects) {
      byKind[e.kind] ??= { bySlug: {} };
      byKind[e.kind].bySlug[e.slug] = body(e);
    }
    if (attack.length) out.push('');
    out.push('// data/effect-ranges.json', pretty(byKind));
  }
  return out.join('\n');
}

function renderOutput() {
  const all = [...queue.values()];
  const text = entryText();
  const nameOf = (slug) => state.bySlug.get(slug)?.name ?? slug;

  $('#out').textContent = text;
  $('#out-target').textContent = all.length
    ? `${all.length} edit${all.length === 1 ? '' : 's'} across ${
      new Set(all.map((e) => KINDS.find((k) => k.id === e.kind).file)).size} file${
      new Set(all.map((e) => e.kind === 'attack')).size > 1 ? 's' : ''}.`
    : 'Pick a Tatari and click its tiles, and the entry appears here.';

  const ready = all.length > 0;
  for (const id of ['#btn-copy', '#btn-download']) $(id).disabled = !ready;
  $('#btn-issue').classList.toggle('is-disabled', !ready);

  const title = all.length === 1
    ? `${KINDS.find((k) => k.id === all[0].kind).label} range: ${nameOf(all[0].slug)}`
    : `Range data: ${all.length} entries`;

  const body = [
    ...all.map((e) => `- **${nameOf(e.slug)}** (\`${e.slug}\`) — ${
      KINDS.find((k) => k.id === e.kind).label}, ${
      e.scope === 'all' ? 'reaches everything' : `${e.tiles.length} tiles`}`),
    '',
    'Recorded with the [range recorder](https://jeremycanlas.github.io/clash-of-critters-horde-planner/contribute.html).',
    '',
    '```json',
    text,
    '```',
  ].join('\n');

  $('#btn-issue').href =
    `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

main();
