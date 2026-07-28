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

import { load, state, matches } from './data.js';
import { $, artHTML, esc, typeIcon, roleIcon, toast, copyText } from './ui.js';

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

const HITS = 8;

let COLS = 6;
let ROWS = 6;

const picked = {
  slug: null,
  kind: 'attack',
  /** Cell index the Tatari stands on, or null while it is being placed. */
  origin: null,
  /** @type {Set<string>} "col,row" offsets, so a move keeps the shape. */
  tiles: new Set(),
};

const cellOf = (col, row) => row * COLS + col;
const colOf = (cell) => cell % COLS;
const rowOf = (cell) => Math.floor(cell / COLS);
const key = (dCol, dRow) => `${dCol},${dRow}`;

// ---------------------------------------------------------------- boot

async function main() {
  try {
    await load();
  } catch (err) {
    $('#hits').innerHTML =
      '<p class="hint">Could not load the roster. If you opened this file directly, '
      + 'serve the folder over HTTP instead — browsers block data loading on <code>file://</code>.</p>';
    console.error(err);
    return;
  }

  COLS = state.meta?.hordeGrid?.columns ?? 6;
  ROWS = state.meta?.hordeGrid?.rows ?? 6;
  // Back row, middle column: the deepest a Tatari can stand, which is where a
  // range that reaches a long way forward has room to be drawn.
  picked.origin = cellOf(Math.floor(COLS / 2), ROWS - 1);

  buildGrid();
  buildKinds();
  wire();
  renderAll();
}

function wire() {
  $('#pick').addEventListener('input', (e) => renderHits(e.target.value));

  $('#hits').addEventListener('click', (e) => {
    const hit = e.target.closest('[data-slug]');
    if (hit) choose(hit.dataset.slug);
  });

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

  $('#grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const i = Number(cell.dataset.cell);

    if (picked.origin === null) { picked.origin = i; renderAll(); return; }

    const dCol = colOf(i) - colOf(picked.origin);
    const dRow = rowOf(i) - rowOf(picked.origin);
    const k = key(dCol, dRow);
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

function renderHits(query) {
  const q = query.trim();
  const hits = q ? state.all.filter((t) => matches(t, q)).slice(0, HITS) : [];

  $('#hits').innerHTML = hits.map((t) => `
    <button class="contrib__hit" type="button" data-slug="${esc(t.slug)}" data-type="${esc(t.type)}">
      ${artHTML(t, { lazy: false })}
      <span class="contrib__hitname">${esc(t.name)}</span>
      <span class="contrib__hitmeta">${typeIcon(t.type)}${roleIcon(t.role)}T${t.tier}</span>
    </button>`).join('');
}

function choose(slug) {
  picked.slug = slug;
  picked.tiles.clear();
  prefillFromData();
  $('#pick').value = '';
  $('#hits').innerHTML = '';
  renderAll();
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
  const grid = $('#grid');
  grid.innerHTML = '';
  for (let i = 0; i < COLS * ROWS; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.cell = String(i);
    cell.setAttribute('role', 'gridcell');
    grid.append(cell);
  }
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
  box.hidden = !t;
  if (!t) return;

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
    ? 'Click the tile the Tatari was standing on.'
    : 'Click every tile it reached. Click one again to take it back off.';

  const covered = new Set();
  if (!placing) {
    for (const k of picked.tiles) {
      const [dCol, dRow] = k.split(',').map(Number);
      const c = colOf(picked.origin) + dCol;
      const r = rowOf(picked.origin) + dRow;
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      covered.add(cellOf(c, r));
    }
  }

  for (const cell of $('#grid').children) {
    const i = Number(cell.dataset.cell);
    const isOrigin = i === picked.origin;
    cell.classList.toggle('is-origin', isOrigin);
    cell.classList.toggle('is-covered', covered.has(i));
    cell.classList.toggle('is-placing', placing);
    cell.innerHTML = isOrigin && picked.slug
      ? `<span class="contrib__token">${artHTML(state.bySlug.get(picked.slug), { lazy: false })}</span>`
      : '';
    cell.setAttribute('aria-label', `Row ${rowOf(i) + 1}, column ${colOf(i) + 1}${
      isOrigin ? ', where the Tatari stands' : covered.has(i) ? ', reached' : ''}`);
  }

  // Offsets can sit off the field once the Tatari moves forward. They are kept,
  // not dropped — but silently keeping them would be its own trap.
  const lost = picked.tiles.size - covered.size - (placing ? picked.tiles.size : 0);
  $('#btn-clear').disabled = picked.tiles.size === 0;
  if (lost > 0) {
    $('#grid-hint').textContent
      += ` ${lost} recorded tile${lost === 1 ? '' : 's'} fall off the field from here — move it back to see them.`;
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
