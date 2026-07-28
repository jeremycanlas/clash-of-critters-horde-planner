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
  },
  {
    id: 'heal', label: 'Heal', file: 'data/effect-ranges.json',
    note: 'How far its healing reaches. Nobody has recorded one of these yet — you would be first.',
  },
  {
    id: 'buff', label: 'Buff', file: 'data/effect-ranges.json',
    note: 'How far its buffs reach — ATK Boost, Shield, DMG Reduction and so on.',
  },
  {
    id: 'debuff', label: 'Debuff', file: 'data/effect-ranges.json',
    note: 'How far its debuffs reach — Slow, Weaken, Bind and so on.',
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

  buildGrid();
  buildKinds();
  // The drafter's roster, whole: its search, filters, cards and detail sheet.
  // Only the meaning of a click changes.
  buildFilters(renderRoster, { onPick: choose });
  // The drafter's phone shell, unchanged: below 760px the recorder owns the
  // screen and the roster becomes a sheet the app bar opens.
  buildShell();
  wire();
  renderRoster();
  renderAll();
}

function wire() {
  $('#kinds').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-kind]');
    if (!chip) return;
    picked.kind = chip.dataset.kind;
    // Each reach is its own recording, and carrying tiles across from the last
    // one is a good way to file a heal range that is really an attack range.
    picked.tiles.clear();
    prefillFromData();
    renderAll();
  });

  // One listener for both grids: reaching beyond the line is the same gesture
  // as reaching across the field.
  $('.field-frame').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const col = Number(cell.dataset.col), row = Number(cell.dataset.row);

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
    renderAll();
  });

  $('#btn-move').addEventListener('click', () => {
    picked.origin = null;
    renderAll();
    toast('Click where it was standing');
  });

  $('#btn-clear').addEventListener('click', () => {
    picked.tiles.clear();
    renderAll();
  });

  for (const id of ['#from', '#note']) {
    $(id).addEventListener('input', renderOutput);
    $(id).addEventListener('change', renderOutput);
  }

  $('#btn-copy').addEventListener('click', async () => {
    toast(await copyText(entryText()) ? 'Entry copied' : 'Could not copy — select it and copy by hand',
      'ok');
  });

  $('#btn-download').addEventListener('click', () => {
    const name = `${picked.kind}-range-${picked.slug ?? 'tatari'}.json`;
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

// ---------------------------------------------------------------- picking

/** What a roster card click means here: record this one. */
function choose(slug) {
  picked.slug = slug;
  picked.tiles.clear();
  $('#note').value = '';
  prefillFromData();
  // On a phone the roster is a sheet over the grid, and the grid is where you
  // are going next. Above 760px this does nothing.
  closeSheet();
  renderAll();
  toast(`Recording ${state.bySlug.get(slug)?.name ?? slug}`);
}

/**
 * Loads whatever is already on file for this Tatari and reach.
 *
 * Verifying an existing entry is as useful as adding a missing one — several
 * were read off a sibling's diagram and are marked UNVERIFIED — and it is much
 * easier to check a shape than to describe one.
 */
function prefillFromData() {
  if (picked.kind !== 'attack' || !picked.slug) return;
  const t = state.bySlug.get(picked.slug);
  if (!t) return;

  const base = state.all.find((x) => x.familyId === t.familyId && x.tier === 1) ?? t;
  const entry = state.ranges?.bySlug?.[picked.slug] ?? state.ranges?.byLine?.[base.slug];
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
  for (const chip of $('#kinds').children) {
    chip.setAttribute('aria-pressed', String(chip.dataset.kind === picked.kind));
  }
  $('#kind-note').textContent = KINDS.find((k) => k.id === picked.kind)?.note ?? '';
}

function renderGrid() {
  const placing = picked.origin === null;
  $('#grid-hint').textContent = placing
    ? 'Click the tile on the field it was standing on. Only the 6×6 can be stood on.'
    : 'Click every tile it reached, beyond the line as well. Click one again to take it back off.';

  let shown = 0;
  for (const cell of document.querySelectorAll('.field-frame .cell')) {
    const col = Number(cell.dataset.col), row = Number(cell.dataset.row);
    const isOrigin = !placing && col === picked.origin.col && row === picked.origin.row;
    const covered = !placing
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
  const lost = placing ? 0 : picked.tiles.size - shown;
  $('#btn-clear').disabled = picked.tiles.size === 0;
  if (lost > 0) {
    $('#grid-hint').textContent
      += ` ${lost} recorded tile${lost === 1 ? '' : 's'} sit outside the board from here — move it to see them.`;
  }
}

// ---------------------------------------------------------------- output

/** Sorted so two people recording the same range produce the same text. */
function tileList() {
  return [...picked.tiles]
    .map((k) => k.split(',').map(Number))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function entry() {
  const note = $('#note').value.trim();
  const from = $('#from').value;
  return {
    tiles: tileList(),
    ...(note ? { note } : {}),
    from,
  };
}

function entryText() {
  if (!picked.slug) return '// Pick a Tatari first.';
  const body = JSON.stringify({ [picked.slug]: entry() }, null, 2)
    // One tile per line reads as a shape; the default breaks every number onto
    // its own line and the pattern disappears.
    .replace(/\[\n\s+(-?\d+),\n\s+(-?\d+)\n\s+\]/g, '[$1, $2]');
  return body;
}

function renderOutput() {
  const kind = KINDS.find((k) => k.id === picked.kind);
  const n = picked.tiles.size;

  $('#out').textContent = entryText();
  $('#out-target').textContent = picked.slug
    ? `${n} tile${n === 1 ? '' : 's'}. This belongs in ${kind.file}, under "bySlug".`
    : 'Pick a Tatari and click its tiles, and the entry appears here.';

  for (const id of ['#btn-copy', '#btn-download']) $(id).disabled = !picked.slug || !n;

  const title = picked.slug
    ? `${kind.label} range: ${state.bySlug.get(picked.slug)?.name ?? picked.slug}`
    : 'Range data';
  const body = [
    `**Tatari:** ${state.bySlug.get(picked.slug)?.name ?? '?'} (\`${picked.slug ?? '?'}\`)`,
    `**Reach:** ${kind.label}`,
    `**File:** \`${kind.file}\` under \`bySlug\``,
    '',
    'Recorded with the [range recorder](https://jeremycanlas.github.io/clash-of-critters-horde-planner/contribute.html).',
    '',
    '```json',
    entryText(),
    '```',
  ].join('\n');

  $('#btn-issue').href =
    `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  $('#btn-issue').classList.toggle('is-disabled', !picked.slug || !n);
}

main();
