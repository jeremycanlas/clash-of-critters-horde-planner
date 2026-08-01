/**
 * The range recorder.
 *
 * Attack range is only published as in-game screenshots and support reach is not
 * published at all, so both have to be read off the game by hand. That is why 72
 * of 218 Tatari have an attack range recorded and none have a heal, buff or
 * debuff one. The bottleneck was never the data, since people in the community can
 * see these ranges any time they play. It was that contributing meant cloning a
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
import { bringsEffect } from './effects.js';
import { buildShell, closeSheet } from './shell.js';
import { rangeStatus } from './range.js';
import { parseContribution } from './range-import.js';
import { loadIssues, issueFor } from './issues.js';

const REPO = 'jeremycanlas/clash-of-critters-horde-planner';

/**
 * What can be recorded, and where each one belongs.
 *
 * Attack goes to the file the app already reads. The three support ranges have
 * no home yet (nobody has recorded one), so they are pointed at a file of their
 * own rather than smuggled into the attack data under a flag, which would make
 * every existing consumer of ranges.json have to care.
 */
const KINDS = [
  {
    id: 'attack', label: 'Attack', file: 'data/ranges.json',
    note: 'The tiles it can hit. This is what the Ranges overlay in the drafter draws.',
    all: 'Hits the whole field, no tile pattern',
  },
  {
    id: 'heal', label: 'Heal', file: 'data/effect-ranges.json',
    note: 'How far its healing reaches. Nobody has recorded one of these yet. You would be first.',
    all: 'Heals the whole team, no tile pattern',
  },
  {
    id: 'buff', label: 'Buff', file: 'data/effect-ranges.json',
    note: 'How far its buffs reach: ATK Boost, Shield, DMG Reduction and so on.',
    all: 'Buffs the whole team, no tile pattern',
  },
  {
    id: 'debuff', label: 'Debuff', file: 'data/effect-ranges.json',
    note: 'How far its debuffs reach: Slow, Weaken, Bind and so on.',
    all: 'Hits every enemy, no tile pattern',
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
  /**
   * True when this edit came in from an issue rather than from clicking. A
   * review is a different job from a recording: what matters is not the shape
   * but how it differs from what is on file, so the grid says so.
   */
  imported: false,
  /**
   * Whether a person changed this, as opposed to it being handed to them.
   *
   * Picking a Tatari loads whatever is already on file onto the grid, so having
   * tiles is no evidence that anybody recorded anything — and the queue used to
   * take that as evidence. Looking at two Tatari queued both of them, verbatim
   * from the data file, and the roster marked them as your work. Worse than the
   * stray colour: "Copy the entry" would hand back the project's own data as a
   * fresh contribution.
   *
   * So the queue asks for a gesture, not a tile count. Clicking the board,
   * toggling the whole-team scope, clearing, or typing a note or a source all
   * count; arriving on a Tatari does not.
   */
  touched: false,
  /**
   * Whether the note in the box was written by the file rather than by a person.
   *
   * The prefill brings the recorded note along with the recorded tiles, and the
   * notes describe the shape — "straight up its own lane, 6 tiles". Change the
   * shape and that sentence is no longer true of it, so an entry claiming five
   * tiles would ship a note insisting on six. Incomplete beats wrong: the borrowed
   * note goes as soon as the shape it describes does.
   */
  noteOnLoan: false,
};
const key = (dCol, dRow) => `${dCol},${dRow}`;

// ---------------------------------------------------------------- boot

async function main() {
  try {
    await load();
  } catch (err) {
    $('#roster').innerHTML =
      '<p class="hint">Could not load the roster. If you opened this file directly, '
      + 'serve the folder over HTTP instead. Browsers block data loading on <code>file://</code>.</p>';
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
  // Not awaited: the page is usable the moment the roster is drawn, and what is
  // already in flight is a hint rather than something to hold it up for. It
  // repaints when the answer arrives, or never, if GitHub is busy.
  findOpenIssues();
}

/**
 * Marks the Tatari somebody has already sent in.
 *
 * The gap this closes is a contributor spending twenty minutes reading a range
 * that has been sitting in an open issue for a week. Nothing here is required
 * for the page to work, so a failure is said once, quietly, and dropped.
 */
async function findOpenIssues() {
  const byName = new Map(state.all.map((t) => [t.name.toLowerCase(), t.slug]));
  const say = $('#issues-say');

  const res = await loadIssues(REPO, (name) => byName.get(name.trim().toLowerCase()) ?? null);

  if (!res.ok) {
    say.textContent = res.why;
    say.hidden = false;
    return;
  }
  if (!res.count) {
    say.hidden = true;
    return;
  }

  say.textContent = `${res.count} reach${res.count === 1 ? ' has' : 'es have'
  } an open issue already — those cards carry the issue number, and recording one again would duplicate somebody's work.`;
  say.hidden = false;
  refreshRoster();
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
    picked.touched = true;
    releaseNote();
    saveCurrent();
    refreshRoster();
    renderAll();
  });

  $('#opt-all').addEventListener('change', (e) => {
    picked.scope = e.target.checked ? 'all' : 'tiles';
    picked.touched = true;
    releaseNote();
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
    picked.noteOnLoan = false;
    picked.touched = true;
    saveCurrent();
    refreshRoster();
    renderAll();
  });

  for (const id of ['#from', '#note']) {
    // Only a person can fire these (the prefill assigns .value directly, which
    // raises no event), so reaching either one is a change worth keeping.
    const sync = () => {
      picked.touched = true;
      // Typed in, so it is theirs now and no longer on loan from the file.
      picked.noteOnLoan = false;
      saveCurrent(); renderQueue(); renderOutput();
    };
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
      // longer queued, so it is cleared to match — and cleared back to untouched,
      // or the next repaint would put the dropped edit straight back.
      if (drop.dataset.drop === picked.slug && drop.dataset.kind === picked.kind) {
        picked.tiles.clear();
        picked.touched = false;
        picked.imported = false;
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
    showBoard();
  });

  $('#btn-queue-clear').addEventListener('click', () => {
    const n = queue.size;
    if (!n) return;
    queue.clear();
    persistQueue();
    picked.tiles.clear();
    picked.touched = false;
    picked.imported = false;
    refreshRoster();
    renderAll();
    toast(`Queue cleared — ${n} edit${n === 1 ? '' : 's'} dropped`);
  });

  wireImport();

  $('#btn-copy').addEventListener('click', async () => {
    toast(await copyText(entryText()) ? 'Entry copied' : 'Could not copy. Select it and copy by hand',
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

// ---------------------------------------------------------------- import

/**
 * Taking an entry back in.
 *
 * The issue button sends a reading out; this is how one comes back. A range
 * arriving as coordinates in an issue has to be checked before it is merged, and
 * checking it as text means reading twenty pairs of numbers against a file of
 * seven hundred more. Put back on the grid beside what is already on file, the
 * same question answers itself at a glance.
 */
function wireImport() {
  const dialog = $('#import');

  $('#btn-import').addEventListener('click', () => {
    $('#import-say').hidden = true;
    dialog.showModal();
    $('#import-text').focus();
  });

  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dialog) dialog.close();
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      $('#import-text').value = await file.text();
      $('#import-text').focus();
    } catch { report([`Could not read ${file.name}.`], 'error'); }
  });

  $('#import-go').addEventListener('click', () => takeIn($('#import-text').value, dialog));
}

function report(lines, kind) {
  const say = $('#import-say');
  say.dataset.kind = kind;
  say.hidden = false;
  say.innerHTML = lines.map((l) => `<span>${esc(l)}</span>`).join('');
}

/**
 * Queues everything readable in `text`, and says what it refused.
 *
 * Refusals are shown rather than counted: an entry left out of a review is one
 * nobody looks at again, and "3 of 4 imported" does not tell you which one went
 * missing or why.
 */
function takeIn(text, dialog) {
  // Whatever is on the grid is written first, or importing the same Tatari
  // would drop the edit in progress on the floor.
  saveCurrent();

  const { entries, problems } = parseContribution(text);
  const kept = [];

  for (const e of entries) {
    if (!KINDS.some((k) => k.id === e.kind)) {
      problems.push(`${e.slug}: "${e.kind}" is not a reach this records.`);
      continue;
    }
    if (!state.bySlug.has(e.slug)) {
      problems.push(`${e.slug} (${e.kind}) is not a Tatari in the roster, so there is nothing to draw it on.`);
      continue;
    }
    // Silently overwriting somebody's own reading with an imported one is the
    // only way this page can lose work, so it is never done quietly.
    const held = queue.get(queueKey(e.slug, e.kind));
    if (held && !held.imported) {
      problems.push(`${state.bySlug.get(e.slug)?.name ?? e.slug} (${e.kind}): the edit you had queued for this was replaced by the imported one.`);
    }

    queue.set(queueKey(e.slug, e.kind), {
      slug: e.slug,
      kind: e.kind,
      scope: e.scope,
      tiles: [...e.tiles],
      note: e.note,
      from: e.from,
      // The contributor's own origin is not in the file (only offsets are), so
      // one is chosen that shows as much of both readings as the board can hold.
      origin: bestOrigin([...e.tiles, ...(onFileTiles(e.slug, e.kind)?.tiles ?? [])]),
      imported: true,
    });
    kept.push(e);
  }

  if (!kept.length) {
    report(problems.length ? problems : ['Nothing in that was a range entry.'], 'error');
    return;
  }

  persistQueue();
  loadInto(kept[0].slug, kept[0].kind);
  refreshRoster();
  renderAll();
  showBoard();

  const summary = `${kept.length} entr${kept.length === 1 ? 'y' : 'ies'} imported — ${
    kept.map((e) => `${state.bySlug.get(e.slug)?.name ?? e.slug} (${e.kind})`).join(', ')}.`;

  if (problems.length) {
    report([summary, ...problems], 'warn');
  } else {
    dialog.close();
  }
  toast(kept.length === 1
    ? `Imported ${state.bySlug.get(kept[0].slug)?.name ?? kept[0].slug} — ${kept[0].kind}`
    : `Imported ${kept.length} entries`, 'ok');
}

/**
 * Where to stand a Tatari so that the most of a recorded shape is on the board.
 *
 * An entry from an issue carries offsets and no origin: the origin was the
 * contributor's screenshot and it is not in the file. Standing it in the back
 * row by default hides anything reaching behind it, and a tile that cannot be
 * seen cannot be checked — which is the whole point of importing it.
 */
function bestOrigin(keys) {
  const offsets = [...new Set(keys)].map((k) => k.split(',').map(Number));
  const home = { col: Math.floor(COLS / 2), row: ROWS - 1 };
  if (!offsets.length) return home;

  let best = home;
  let bestScore = -1;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      let seen = 0;
      for (const [dCol, dRow] of offsets) {
        const c = col + dCol, r = row + dRow;
        if (c >= 0 && c < COLS && r >= -ENEMY_ROWS && r < ROWS) seen++;
      }
      // Ties go to the tile nearest where a Tatari would otherwise stand, so the
      // same shape lands in the same place every time rather than wherever the
      // scan happened to start.
      const score = seen * 100 - (Math.abs(col - home.col) + Math.abs(row - home.row));
      if (score > bestScore) { bestScore = score; best = { col, row }; }
    }
  }
  return best;
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
  // Nothing was changed, so there is nothing of anybody's to keep. Prefilled
  // tiles are the project's own data on loan to look at, not a contribution.
  if (!picked.touched) return;
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
      imported: picked.imported,
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
    picked.imported = held.imported === true;
    // Already somebody's work, either clicked here or read in from an issue,
    // so it stays in the queue whatever happens next, note included.
    picked.touched = true;
    picked.noteOnLoan = false;
    $('#note').value = held.note;
    $('#from').value = held.from;
    picked.origin = { ...held.origin };
    return;
  }
  picked.scope = 'tiles';
  picked.imported = false;
  // Whatever the prefill puts on the board is on loan from the data file.
  picked.touched = false;
  picked.noteOnLoan = false;
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
        imported: e.imported === true,
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
    // Imported entries carry what they would change, so the queue is a list of
    // reviews to work through rather than a list of names.
    const d = e.imported ? diffOf(e.slug, e.kind, new Set(e.tiles)) : null;
    const moved = [
      d?.added.length ? `<b>+${d.added.length}</b>` : '',
      d?.removed.length ? `&minus;${d.removed.length}` : '',
    ].filter(Boolean);
    const delta = d?.was && moved.length ? `<span class="contrib__qdelta">${moved.join(' ')}</span>` : '';
    return `
      <button class="contrib__qitem" type="button" data-open="${esc(e.slug)}" data-kind="${esc(e.kind)}"
              data-imported="${e.imported === true}"
              aria-current="${here}" title="${esc(t?.name ?? e.slug)} — ${e.kind}, ${e.tiles.length} tiles${
                d?.was ? `, ${d.added.length} added and ${d.removed.length} dropped against the file` : ''}">
        ${t ? artHTML(t, { lazy: false }) : ''}
        <span class="contrib__qname">${esc(t?.name ?? e.slug)}</span>
        <span class="contrib__qkind" data-kind="${esc(e.kind)}">${esc(e.kind)}</span>
        ${e.imported ? '<span class="contrib__qtag">imported</span>' : ''}
        ${delta}
        <span class="contrib__qn">${e.scope === 'all' ? 'all' : e.tiles.length}</span>
        <span class="contrib__qx" role="button" tabindex="-1" data-drop="${esc(e.slug)}"
              data-kind="${esc(e.kind)}" aria-label="Take this edit off the queue">&times;</span>
      </button>`;
  }).join('');
}

// ---------------------------------------------------------------- picking

/**
 * The roster, plus what is known and what is in flight for every card.
 *
 * Painted after roster.js has rendered rather than from inside it: coverage is
 * this page's business, and a drafter picking a team has no use for knowing
 * which ranges happen to be documented.
 *
 * Two facts, two channels, and that is the whole of the redesign. They used to
 * share one — the card's border colour carried five values in a precedence
 * order, so a card outlined for its open issue could not also say whether
 * anything was on file, and the coverage it displaced went into a `title`
 * attribute. Three quarters of this audience is on a phone and has no way to
 * read a `title` at all, which made the losing fact simply invisible to them.
 *
 * So: the strip along the bottom carries what is on file, one segment per reach
 * this Tatari can even have, and the border and badge carry what is in flight.
 * Neither hides the other, and switching reach chips no longer changes what the
 * strip says — all four are on every card at once.
 */
function refreshRoster() {
  renderRoster();
  for (const card of document.querySelectorAll('#roster .card')) {
    const t = state.bySlug.get(card.dataset.slug);
    if (t) markCard(card, t);
  }
}

/**
 * Which reaches this Tatari can have at all.
 *
 * Everything attacks. A heal reach, though, is only a fact about a Tatari that
 * heals — showing an empty heal slot on one that has never healed anything would
 * report missing data about something that cannot exist, and 218 cards each
 * claiming three absences is how a coverage display comes to mean nothing.
 */
function reachesOf(t) {
  return KINDS.filter((k) => k.id === 'attack' || bringsEffect(t, k.id));
}

/** What is on file, what is in flight, drawn onto one card. */
function markCard(card, t) {
  const slug = t.slug;
  const mine = queue.has(queueKey(slug, picked.kind));
  const open = issueFor(slug, picked.kind);

  // The border, for scanning 218 cards: one hue, two weights. Violet has no twin
  // among the five elemental type colours, which is exactly why the old scheme's
  // red, yellow, green and blue could not be used — every one of them is also a
  // type tint sitting behind the sprite, and three of them are also an effect
  // badge in the corner. Bright is your own work, dim is somebody else's.
  card.dataset.flight = mine ? 'mine' : open ? 'theirs' : '';
  // Kept for the queue's own bookkeeping and for anything reading the DOM.
  card.dataset.queued = String(mine);
  if (open) card.dataset.issue = String(open.number);

  const reaches = reachesOf(t);
  card.append(reachStrip(slug, reaches));
  if (open) card.querySelector('.card__art')?.append(issueBadge(open));

  // The card's own title names the Tatari, its type and role, and renderRoster()
  // has just written it — so this is appended, not assigned. It is the long form
  // of the strip for anyone on a pointer, and the only place the issue's subject
  // line fits.
  const said = reaches.map((k) => `${k.label}: ${COVERAGE_SAYS[rangeStatus(slug, k.id)]}`);
  card.title = `${card.title}\n\n${said.join('\n')}${
    open ? `\n\n#${open.number} is already open for its ${picked.kind} reach: ${open.title}` : ''}${
    mine ? `\n\nIts ${picked.kind} reach is waiting in your queue.` : ''}`;
}

/**
 * One segment per reach, filled by how well known that reach is.
 *
 * Coverage is a sequence (nothing, then written down, then checked), so it is
 * drawn as one: three steps of brightness on the same neutral, which is the
 * channel a card has left. Every hue on this card is already spoken for twice
 * over, and encoding an ordinal three-step as three unrelated colours asked
 * people to memorise an order that the colours themselves never implied.
 */
function reachStrip(slug, reaches) {
  const strip = document.createElement('span');
  strip.className = 'card__reach';
  strip.setAttribute('aria-hidden', 'true');

  for (const k of reaches) {
    const pip = document.createElement('span');
    pip.className = 'card__pip';
    pip.dataset.cov = rangeStatus(slug, k.id);
    pip.dataset.reach = k.id;
    // Which segment the reach chips are currently pointed at, so the border and
    // the badge are anchored to a specific one rather than to the card at large.
    if (k.id === picked.kind) pip.dataset.sel = 'true';
    if (queue.has(queueKey(slug, k.id))) pip.dataset.flight = 'mine';
    else if (issueFor(slug, k.id)) pip.dataset.flight = 'theirs';
    strip.append(pip);
  }
  return strip;
}

/**
 * An open issue, as its number.
 *
 * A colour can say "somebody got here first" but it cannot say who or where, and
 * on a phone the tooltip that used to carry that is unreachable. The number is
 * the issue's actual name, it is legible at 8px, and it collides with nothing.
 */
function issueBadge(open) {
  const badge = document.createElement('span');
  badge.className = 'card__flight';
  badge.textContent = `#${open.number}`;
  return badge;
}

/** Coverage, in the words the tooltip and the legend both use. */
const COVERAGE_SAYS = {
  none: 'nothing recorded',
  recorded: 'on file, unchecked',
  verified: 'on file and checked by hand',
};

/** What a roster card click means here: record this one. */
function choose(slug) {
  saveCurrent();
  loadInto(slug, picked.kind);
  // On a phone the roster is a sheet over the grid, and the grid is where you
  // are going next. Above 760px this does nothing.
  closeSheet();
  // The queue may have gained or lost an entry on the way in, and a roster
  // whose marks lag one interaction behind the queue is where the wandering
  // purple came from: a card would change colour on some later, unrelated click.
  refreshRoster();
  renderAll();
  showBoard();

  const held = queue.get(queueKey(slug, picked.kind));
  toast(held
    ? `Back to ${state.bySlug.get(slug)?.name ?? slug}, ${held.tiles.length} tiles kept`
    : `Recording ${state.bySlug.get(slug)?.name ?? slug}`);
}

/**
 * Brings the tile the Tatari is standing on into view.
 *
 * The frame is thirteen rows tall and the Tatari stands in the back row of it,
 * so on arrival the interesting part is the better part of a screen below the
 * fold — under the lede, the pick, the four reach chips and their note. Picking
 * a Tatari looked like it had done nothing at all: the board lit up correctly,
 * off screen, while the output block underneath filled in. Which is to say the
 * page answered a question nobody could see it answering.
 */
function showBoard() {
  const origin = document.querySelector('.field-frame .cell.is-origin')
    ?? document.querySelector('.field-frame');
  if (!origin) return;

  // Called after renderAll() has already mutated the DOM, and reading a rect
  // flushes pending layout — so this measures the page as it now is, including the
  // height the pick just added above the board. No frame to wait for.
  const box = origin.getBoundingClientRect();
  // Only when it is actually out of the way. Scrolling a board somebody is
  // already looking at moves the thing under their cursor for no reason.
  if (box.top < 0 || box.bottom > window.innerHeight) {
    // Instant, and scrollIntoView is not asked to do it: `behavior: "smooth"` is
    // a no-op wherever the browser has smooth scrolling turned off: not slower,
    // not instant, nothing at all. And a jump that sometimes fails to happen is
    // worse than one that always does. The pulse is what makes it legible.
    const mid = box.top + box.height / 2 - window.innerHeight / 2;
    window.scrollTo({ top: Math.max(0, window.scrollY + mid) });
  }
  pulseOrigin();
}

/**
 * Says where the Tatari is standing, once, by flashing its tile.
 *
 * Picking one moves the page several hundred pixels and lights up a shape, and
 * nothing connected the click to either — which is why picking a Tatari read as
 * having done nothing. The pulse is the only thing here that answers "what just
 * happened", so it lands on the tile everything else is measured from.
 */
function pulseOrigin() {
  const cell = document.querySelector('.field-frame .cell.is-origin');
  if (!cell) return;
  cell.classList.remove('is-arriving');
  // Reading offsetWidth restarts the animation; without it, picking a second
  // Tatari whose origin is the same tile replays nothing at all.
  void cell.offsetWidth;
  cell.classList.add('is-arriving');
}

/**
 * Loads whatever is already on file for this Tatari and reach.
 *
 * Verifying an existing entry is as useful as adding a missing one. Several
 * were read off a sibling's diagram and are marked UNVERIFIED, and it is much
 * easier to check a shape than to describe one.
 */
function prefillFromData() {
  if (!picked.slug) return;
  const entry = onFile(picked.slug, picked.kind);
  if (!entry?.tiles) return;

  for (const [dCol, dRow] of entry.tiles) picked.tiles.add(key(dCol, dRow));
  if (entry.note) {
    $('#note').value = entry.note;
    picked.noteOnLoan = true;
  }
}

/**
 * Lets go of a borrowed note, once the shape it described has changed.
 *
 * Called from the gestures that change the shape rather than from saveCurrent(),
 * because the box has to visibly empty at the moment the contributor invalidates
 * it — a note silently dropped on save is one they still believe they sent.
 */
function releaseNote() {
  if (!picked.noteOnLoan) return;
  picked.noteOnLoan = false;
  $('#note').value = '';
}

/**
 * What the data files already say about this Tatari and reach.
 *
 * Ranges are keyed by evolution line with a per-slug override, so a tier 3 with
 * nothing of its own inherits its line's entry — the same lookup range.js does
 * for the drafter.
 */
function onFile(slug, kind) {
  const t = state.bySlug.get(slug);
  if (!t) return null;
  const book = kind === 'attack' ? state.ranges : state.effectRanges?.[kind];
  const base = state.all.find((x) => x.familyId === t.familyId && x.tier === 1) ?? t;
  return book?.bySlug?.[slug] ?? book?.byLine?.[base.slug] ?? null;
}

/** The same, as offset keys, or null when nothing is on file. */
function onFileTiles(slug, kind) {
  const entry = onFile(slug, kind);
  if (!entry) return null;
  const tiles = (entry.tiles ?? []).map(([dCol, dRow]) => key(dCol, dRow));
  return { scope: entry.scope === 'all' && !tiles.length ? 'all' : 'tiles', tiles };
}

/**
 * The entry on the grid against the one on file, tile by tile.
 *
 * Only for imported entries. While you are recording your own reading, the
 * tiles you have clicked are the answer and colouring some of them differently
 * would be the page arguing with you; while you are reviewing somebody else's,
 * the difference is the only thing you are there to look at.
 *
 * @returns {{was: ?{scope: string, tiles: string[]}, base: Set<string>,
 *   added: string[], removed: string[], kept: string[]}|null}
 */
function diffOf(slug, kind, tiles) {
  const was = onFileTiles(slug, kind);
  const base = new Set(was?.tiles ?? []);
  return {
    was,
    base,
    added: [...tiles].filter((k) => !base.has(k)),
    removed: [...base].filter((k) => !tiles.has(k)),
    kept: [...tiles].filter((k) => base.has(k)),
  };
}

/** The diff for whatever is on the grid, or null when this is not a review. */
function currentDiff() {
  if (!picked.imported || !picked.slug) return null;
  return diffOf(picked.slug, picked.kind, picked.tiles);
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
  const review = currentDiff();
  renderChosen();
  renderKinds();
  renderGrid(review);
  renderDiff(review);
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
  $('#opt-all-label').textContent = kind?.all ?? 'Reaches everything, no tile pattern';
  $('#opt-all').checked = picked.scope === 'all';
}

function renderGrid(review) {
  const everywhere = picked.scope === 'all';
  const placing = !everywhere && picked.origin === null;
  // Nothing on file is nothing to differ from, so the tiles stay the plain
  // yellow of a recording rather than every one of them reading as new.
  const cmp = review?.was ? review : null;

  $('.field-frame').classList.toggle('is-everywhere', everywhere);
  $('#grid-hint').textContent = everywhere
    ? 'No tiles to click. This one reaches regardless of where anything is standing.'
    : placing
      ? 'Click the tile on the field it was standing on. Only the 6×6 can be stood on.'
      : 'Click every tile it reached, beyond the line as well. Click one again to take it back off.';

  let shown = 0;
  for (const cell of document.querySelectorAll('.field-frame .cell')) {
    const col = Number(cell.dataset.col), row = Number(cell.dataset.row);
    const isOrigin = !placing && !everywhere && picked.origin
      && col === picked.origin.col && row === picked.origin.row;
    const live = !placing && !everywhere && !!picked.origin;
    const offset = live ? key(col - picked.origin.col, row - picked.origin.row) : null;
    const covered = live && picked.tiles.has(offset);
    const added = covered && !!cmp && !cmp.base.has(offset);
    // The one tile drawn that the entry does not claim: it is on file and this
    // entry takes it away, which is exactly the thing worth seeing.
    const dropped = live && !covered && !!cmp && cmp.base.has(offset);
    if (covered) shown++;

    cell.classList.toggle('is-origin', isOrigin);
    cell.classList.toggle('is-covered', covered && !added);
    cell.classList.toggle('is-added', added);
    cell.classList.toggle('is-removed', dropped);
    cell.classList.toggle('is-placing', placing);
    cell.innerHTML = isOrigin && picked.slug
      ? `<span class="contrib__token">${artHTML(state.bySlug.get(picked.slug), { lazy: false })}</span>`
      : '';

    const where = row < 0
      ? `${-row} beyond the line, column ${col + 1}`
      : `Row ${row + 1}, column ${col + 1}`;
    const says = isOrigin ? ', where the Tatari stands'
      : added ? ', reached and added by this entry'
        : dropped ? ', on file and dropped by this entry'
          : covered ? ', reached' : '';
    cell.setAttribute('aria-label', `${where}${says}`);
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

/** "3 tiles", "1 tile" — a count that reads as English. */
const count = (n, one = 'tile') => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * What an imported entry changes, in a sentence.
 *
 * The colours say which tiles; this says how many, and covers the two cases
 * colour cannot — an entry claiming a whole-field reach, and one that turns out
 * to match the file exactly. "No change" is a useful answer to a review and an
 * unlit grid does not give it.
 */
function renderDiff(review) {
  const box = $('#diff');
  box.hidden = !review;
  if (!review) return;

  const name = state.bySlug.get(picked.slug)?.name ?? picked.slug;
  // Nothing to compare against, so the three colours would be a legend for two
  // states that cannot occur.
  $('#diff-legend').hidden = !review.was;
  $('#diff-say').textContent = `Imported entry for ${name}: ${diffSay(review)}`;
}

function diffSay(d) {
  const kind = KINDS.find((k) => k.id === picked.kind)?.label.toLowerCase() ?? picked.kind;
  if (!d.was) return `nothing is on file for its ${kind} reach, so all of this is new.`;

  if (picked.scope === 'all') {
    return d.was.scope === 'all'
      ? 'the file already says it reaches everything. No change.'
      : `it says it reaches everything, where the file draws ${count(d.base.size)}.`;
  }
  if (d.was.scope === 'all') {
    return `it draws ${count(picked.tiles.size)}, where the file says it reaches everything.`;
  }
  if (!d.added.length && !d.removed.length) {
    return `identical to what is on file, all ${count(d.kept.length)}.`;
  }
  return `${count(d.added.length)} added, ${d.removed.length} dropped, ${d.kept.length} unchanged.`;
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
 * shapes (ranges.json is keyed by slug at its top level, effect-ranges.json is
 * keyed by reach first), and a contributor should not have to work that out from
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
