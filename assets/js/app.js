/** Boot and wiring. */

import { load, state } from './data.js';
import * as store from './store.js';
import {
  $, $$, esc, glitterOn, toast, downloadJSON, readJSONFile, slugFilename, dragScrollVelocity,
  dismissOnBackdrop, APP_VERSION,
} from './ui.js';
import {
  buildGrid, renderGrid, renderBench, renderPlayerTabs, renderSummary,
  renderRanges, rangesOn, renderLfSuggestions, bossPullOn, secondPullOn, refreshPull,
} from './grid.js';
import { buildFilters, renderRoster } from './roster.js';
import { buildPriority, renderPriority } from './priority.js';
import { buildShare, openShare } from './share.js';
import { warmSprites } from './card.js';
import { buildShell, renderShell } from './shell.js';
import { loadChips } from './chips.js';
import { buildSaves, savedById, keepQuietly } from './saves.js';
import { buildSubmit, openSubmit, resumeSubmit } from './submit.js';
import { buildSession } from './session.js';
import { roomInHash } from './hash.js';
import { isConfigured, readCallback } from './supabase.js';
import { buildAnalytics, track } from './analytics.js';
import { importTatari } from './custom.js';
import * as prefs from './prefs.js';

/*
 * Before anything renders, and before the data load that main() waits on: these
 * decide what colour the page is, and a page that starts in one theme and
 * arrives in another is worse than one that takes a moment to appear.
 */
prefs.applyPrefs();

function renderAll() {
  // Before the roster asks for its 218 thumbnails, so the dozen sprites the
  // share card needs are at the front of the queue rather than the back.
  warmSprites();
  renderPlayerTabs();
  renderGrid();
  renderBench();
  renderPriority();
  renderRoster();
  renderSummary();
  renderShell();

  for (const btn of $$('#mode-switch .segmented__btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === store.formation.mode));
  }
  document.body.dataset.mode = store.formation.mode;
  document.body.dataset.activePlayer = String(store.formation.activePlayer);

  /*
   * The Sandbox box follows the formation rather than only driving it, and this
   * is the one place that has to be true: the flag arrives from a share link, a
   * restored autosave, an Undo and a live peer as well as from the checkbox, and
   * in every one of those cases nobody clicked it. Syncing here rather than in
   * each of those handlers means a path added later cannot forget to.
   */
  const sandbox = $('#opt-sandbox');
  if (sandbox) sandbox.checked = store.isSandbox();
  document.body.dataset.sandbox = String(store.isSandbox());
  const zobo = $('#opt-zobo');
  if (zobo) zobo.checked = store.isZoboGround();
  document.body.dataset.zobo = String(store.isZoboGround());
}

async function main() {
  try {
    await load();
  } catch (err) {
    $('#roster').innerHTML =
      '<p class="hint">Could not load <code>data/tatari.json</code>. ' +
      'If you opened this file directly, serve the folder over HTTP instead ' +
      '(<code>npx serve</code>). Browsers block <code>fetch</code> on <code>file://</code>.</p>';
    console.error(err);
    return;
  }

  /*
   * Before anything reads location.hash. Coming back from Discord the fragment
   * holds a session rather than a formation, and store.fromHash() must never
   * see it — nor should it be left in the address bar, where it looks like a
   * share link to anyone who copies what is there.
   */
  const returned = readCallback();

  buildGrid();
  buildPriority();
  buildShare({ canPost: isConfigured(), onPost: postCurrent });
  buildShell();
  buildSaves({ canPost: isConfigured(), onPost: openSubmit });
  buildHelp();
  const pending = buildSubmit();
  buildAnalytics();
  buildFilters(() => renderRoster());

  /*
   * Chips arrive late and redraw once, rather than holding up the board.
   *
   * The Chips tab needs data/chips.json, which is another round trip, and the
   * field is what somebody opened this for. So the roster renders without it
   * and this redraws when the file lands; every later render has it already.
   */
  loadChips().then(() => renderRoster());

  store.subscribe(renderAll);
  countFirstUse();

  // A shared link wins over whatever was on screen last time.
  const hash = store.fromHash();
  if (!hash) store.restore();
  renderAll();

  /*
   * After the formation, not with the other builders, and the one place in this
   * function where that order matters. A live link carries both halves — the
   * formation it started from and the room it is happening in — and joining
   * publishes whatever is on the field as the state to reconcile against. Wiring
   * this up top would offer an empty board to the room a beat before the link's
   * own formation had loaded into it.
   */
  buildSession();

  // Signed in mid-post: pick the dialog back up where it was left, rather than
  // dropping somebody back on the page with nothing to show they succeeded.
  if (returned === 'signed-in' && pending) {
    const save = savedById(pending.id);
    if (save) resumeSubmit(save, pending);
  } else if (returned === 'failed') {
    toast('Discord sign-in did not complete', 'error');
  }

  if (hash?.unknown.length) {
    toast(`Skipped ${hash.unknown.length} unknown Tatari from that link`, 'error');
  }

  $('#formation-name').value = store.formation.name;
  $('#foot-meta').textContent =
    `${state.meta.counts.tatari} Tatari · ${state.meta.counts.families} evolution lines · wiki data ${state.meta.scrapedAt}`;

  /*
   * How much range data there is, counted rather than written down.
   *
   * The markup used to say "only 72 of the 218 Tatari", which was true when
   * somebody typed it and had quietly become wrong by the time the roster hit
   * 230 -- a number in a tooltip is a promise to come back and edit it, and
   * nobody ever does. The recorded count moves every time someone contributes a
   * range, so it was never going to hold still.
   */
  const recorded = Object.keys(state.ranges?.bySlug ?? {}).length;
  const ranges = $('#opt-ranges')?.closest('label');
  if (ranges && recorded) {
    ranges.title = ranges.title.replace(
      'The range data is still being filled in,',
      `Only ${recorded} of the ${state.all.length} Tatari have a recorded range so far,`);
  }
  // The name is in the markup so it shows without JS; only the version is
  // filled in, from the one constant that also stamps the share card.
  $('#app-version').textContent = `v${APP_VERSION}`;

  showPatchNote();
  wireToolbar();
  wireDragAutoScroll();
}


/**
 * The one line telling somebody an update landed.
 *
 * Dismissal is keyed on the patch itself, not on a boolean. Storing "seen" would
 * mean the next update arrives silently for everybody who ever closed this one,
 * which is the failure mode of every notice bar that has ever annoyed anybody:
 * it either nags forever or it goes quiet forever. Keyed on the label, closing
 * it settles this update and the next one is news again.
 *
 * The whole element stays out of the page when there is nothing to report, so a
 * copy of this tool that does not track updates never grows a bar it cannot fill.
 *
 * "Touched", not "adjusted", however naturally that word comes. Adjusted is one
 * of the three directions this app marks, and on the update page it means one
 * evolution line and four Tatari. A bar reading "adjusted 135" three lines above
 * a heading reading "Adjusted, 4 Tatari" would be the tool contradicting itself
 * in the same viewport. Not "changed" either, which is the honest word but puts
 * it twice in one sentence next to "See what changed" -- and that half is the
 * page's own name, so it is the half that stays.
 */
function showPatchNote() {
  const note = $('#patch-note');
  if (!note || !state.changes.size) return;

  const patch = state.patch?.patch ?? 'unknown';
  let seen = null;
  try { seen = localStorage.getItem('coc.patch-seen'); } catch { /* private mode */ }
  if (seen === patch) return;

  note.hidden = false;
  note.innerHTML = `
    <span class="patchnote__body">
      The <b>${esc(state.patch?.label ?? 'latest')}</b> update touched
      ${state.changes.size} of the ${state.all.length} Tatari. See what changed
    </span>
    <button class="patchnote__x" type="button" aria-label="Hide this until the next update">&times;</button>`;

  note.addEventListener('click', (e) => {
    if (!e.target.closest('.patchnote__x')) return;
    // Not a link click: dismissing is the other thing this row does.
    e.preventDefault();
    note.hidden = true;
    try { localStorage.setItem('coc.patch-seen', patch); } catch { /* private mode */ }
  });
}

/**
 * Posting straight from the Share sheet.
 *
 * A post is made from a saved formation — that is what lets a sign-in halfway
 * through find its way back to the right one — and somebody who pressed Post
 * did not press Save. So this takes the step they skipped instead of refusing
 * them for not knowing it existed, and the Share sheet says it will.
 *
 * A refusal (nothing on the field, storage full) has already been said by
 * keepQuietly, so there is nothing to add here.
 */
function postCurrent() {
  const save = keepQuietly();
  if (save) openSubmit(save);
}

/** The "how does this work" dialog, which is only ever opened by hand. */
function buildHelp() {
  const dlg = $('#dlg-help');
  if (!dlg) return;
  $('#btn-help').addEventListener('click', () => {
    dlg.showModal();
    track('help-opened');
  });
  dismissOnBackdrop(dlg);
}

/**
 * Counts once per visit, the first time there is anything on the field —
 * whether that is a Tatari placed now or a formation restored from last time.
 * Page views alone cannot tell someone who used the tool from someone who
 * looked at it and left.
 */
function countFirstUse() {
  if (store.allPlaced().length) { track('used'); return; }
  const stop = store.subscribe(() => {
    if (!store.allPlaced().length) return;
    track('used');
    stop();
  });
}

/**
 * The way back from anything destructive.
 *
 * A snapshot is the whole working state, so restoring one is exact - there is
 * no partial undo to get subtly wrong. Returns the {label, fn} shape toast()
 * takes, which also buys the longer timeout: six seconds to notice, rather
 * than the two and a half a plain message gets.
 */
const undoTo = (before) => ({
  label: 'Undo',
  fn: () => {
    store.applySnapshot(before);
    $('#formation-name').value = store.formation.name;
    toast('Put back');
  },
});

/** Guards the toolbar actions that have nothing to work with yet. */
function nothingBrought(message) {
  if (store.benchOf(1).length || store.benchOf(2).length) return false;
  toast(message);
  return true;
}

/**
 * The LF picker: the roster's search, drawn with sprites, driven by both a
 * pointer and a keyboard. `highlight` is an index into the visible list, or -1
 * for "nothing chosen yet", which is what typing resets it to.
 */
function wireLfSearch() {
  const input = $('#lf-pick');
  const list = $('#lf-suggest');
  let highlight = -1;
  let count = 0;

  const paint = () => {
    [...list.children].forEach((li, i) => {
      const on = i === highlight;
      li.setAttribute('aria-selected', String(on));
      li.classList.toggle('is-on', on);
    });
    input.setAttribute('aria-activedescendant', highlight >= 0 ? `lf-opt-${highlight}` : '');
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    highlight = -1;
    count = 0;
  };

  const take = (i) => {
    const li = list.children[i];
    if (!li) return;
    const result = store.toggleWant(li.dataset.slug);
    if (!result.ok) toast(result.reason, 'error');
    input.value = '';
    close();
  };

  input.addEventListener('input', () => {
    count = renderLfSuggestions(input.value);
    highlight = -1;
    paint();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (!count) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      highlight = e.key === 'ArrowDown'
        ? (highlight + 1) % count
        : (highlight - 1 + count) % count;
      paint();
    } else if (e.key === 'Enter') {
      // With nothing highlighted, Enter takes the top match — the usual
      // shortcut when you have typed enough to know what you meant.
      e.preventDefault();
      take(highlight === -1 ? 0 : highlight);
    }
  });

  // mousedown, not click: blur would otherwise close the list first and the
  // click would land on nothing.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    take([...list.children].indexOf(li));
  });

  input.addEventListener('blur', () => setTimeout(close, 120));
}

function wireToolbar() {
  $('#formation-name').addEventListener('input', (e) => store.setName(e.target.value));

  $('#lf').addEventListener('input', (e) => store.setLF(e.target.value));

  $('#lf-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-side]');
    if (btn) store.setLfMode(btn.dataset.side);
  });

  $('#lf-wants').addEventListener('click', (e) => {
    const drop = e.target.closest('[data-drop-want]');
    if (drop) store.toggleWant(drop.dataset.dropWant);
  });

  wireLfSearch();

  $('#opt-ranges').addEventListener('change', (e) => {
    rangesOn.value = e.target.checked;
    renderRanges();
  });

  /*
   * Both pull toggles take the snapshot again; nothing else does. That is the
   * whole of "the pull holds still": the rule runs on the board as it is at the
   * moment you flip a switch, and every edit after that is yours to make without
   * the boss changing its mind about who it grabbed.
   */
  $('#opt-pull').addEventListener('change', (e) => {
    bossPullOn.value = e.target.checked;
    refreshPull();
    renderGrid();
  });

  $('#opt-pull-2').addEventListener('change', (e) => {
    secondPullOn.value = e.target.checked;
    refreshPull();
    renderGrid();
  });

  /*
   * The two reader-level settings. prefs.js owns what they mean and where they
   * are kept; this only has to keep the controls showing the truth.
   *
   * Both are already applied by now — applyPrefs() runs before the first paint
   * of anything — so these handlers are about the controls catching up with the
   * stored state, not about setting it.
   */
  const contrastBox = $('#opt-contrast');
  contrastBox.checked = prefs.contrast();
  contrastBox.addEventListener('change', (e) => {
    prefs.setContrast(e.target.checked);
    // The palette is CSS and repaints itself; the drawn card is a canvas and
    // does not, so anything holding one has to be told.
    renderGrid();
  });

  const themeSwitch = $('#theme-switch');
  const renderTheme = () => {
    for (const btn of themeSwitch.children) {
      btn.setAttribute('aria-pressed', String(btn.dataset.themeChoice === prefs.theme()));
    }
  };
  themeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    prefs.setTheme(btn.dataset.themeChoice);
    renderTheme();
  });
  renderTheme();

  /*
   * Glitter has two switches: the one in the field toolbar and the one in the
   * roster, which is the only reachable copy on a phone. Whichever moves, the
   * other follows — a checkbox showing the opposite of what the art is doing is
   * worse than not offering the second one at all.
   */
  const glitterBoxes = $$('#opt-glitter, #opt-glitter-roster');
  for (const box of glitterBoxes) {
    box.addEventListener('change', (e) => {
      glitterOn.value = e.target.checked;
      for (const other of glitterBoxes) other.checked = e.target.checked;
      renderAll();
    });
  }

  /*
   * Sandbox, and the one interaction in this file that asks before it acts.
   *
   * Turning it on is free: the caps lift, 42 more cells become reachable, and
   * nothing already placed moves. Turning it off is the direction that can lose
   * work, and unlike every other trim here the amount is unbounded — a 30-strong
   * bench loses half of itself, and no toast is adequate warning for that after
   * the fact.
   *
   * So the toast has to say what happened rather than that something did, and
   * carry the way back. Only `dropped` is a real loss — Tatari that come off the
   * board are still on their bench.
   */
  /*
   * The Zobo ground, which needs none of Sandbox's ceremony. Closing it unplaces
   * whatever was standing out there and keeps every one of them — anything on the
   * board is on its owner's bench already — so there is nothing to warn about and
   * nothing to undo beyond putting them back where you had them.
   */
  $('#opt-zobo').addEventListener('change', (e) => {
    const before = store.snapshot();
    const { unplaced } = store.setZoboGround(e.target.checked);
    /*
     * Silent unless something actually moved.
     *
     * The checkbox shows its own state and the seven rows appear or vanish under
     * it, so a toast saying what you just watched happen is noise on a control
     * people flick back and forth. The one case still worth a word is closing it
     * with Tatari standing out there: their positions are gone, and the toast is
     * the only place Undo can live.
     */
    if (unplaced) {
      toast(`Zobo ground closed, benched ${unplaced}`, 'info', undoTo(before));
    }
  });

  const sandboxBox = $('#opt-sandbox');
  sandboxBox.addEventListener('change', (e) => {
    const on = e.target.checked;

    if (on) {
      store.setSandbox(true);
      return;
    }

    const before = store.snapshot();
    const got = store.setSandbox(false);

    /*
     * Silent unless something actually went.
     *
     * Turning Sandbox on says nothing at all: the checkbox shows its own state
     * and the bench count beside the field switches from a limit to a plain
     * number, so a toast narrating it is noise on a switch people flip back and
     * forth while trying things out.
     *
     * Turning it off is different only when it costs something. The counts are
     * kept separate because they are separate events — benched Tatari are still
     * yours, removed ones are not — and the toast is the only place Undo can
     * live, which is the real reason it survives at all. Nothing lost, nothing
     * said.
     */
    const said = [];
    if (got.unplaced) said.push(`benched ${got.unplaced}`);
    if (got.dropped) said.push(`removed ${got.dropped} that would not fit`);
    if (!said.length) return;

    toast(`Sandbox off: ${said.join(', ')}`,
      got.dropped ? 'warn' : 'info', undoTo(before));
  });

  $('#mode-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented__btn');
    if (!btn) return;
    const { trimmed, discarded } = store.setMode(btn.dataset.mode);
    const notes = [];
    if (discarded) notes.push(`dropped P2's ${discarded} Tatari`);
    if (trimmed) notes.push(`benched ${trimmed} over the new field cap`);
    toast(notes.length
      ? `${store.mode().label}: ${notes.join(', ')}`
      : `${store.mode().label}: ${store.fieldCap()} on the field per player`);
  });

  /*
   * Both Clears are undoable now, and both say what they actually take.
   *
   * "Field cleared - benches kept" was true and misleading at once: it named
   * what survived and stayed quiet about the level-up plan, which does not and
   * cannot (see store.clearField). A player who had ordered fifteen level-ups
   * lost them to a button that mentioned benches.
   *
   * The snapshot is taken before the change and handed to the toast, which is
   * the same shape saves.js already uses for loading over unsaved work.
   */
  $('#btn-clear-field').addEventListener('click', () => {
    if (!store.allPlaced().length) return;
    const before = store.snapshot();
    const steps = store.formation.plan.length;
    store.clearField();
    toast(steps
      ? `Field cleared - benches kept, ${steps} level-up step${steps === 1 ? '' : 's'} gone`
      : 'Field cleared - benches kept', 'info', undoTo(before));
  });

  // In co-op each player has their own plan and their own tab, so this clears
  // the one on screen rather than both at once.
  $('#btn-clear-plan').addEventListener('click', () => {
    const player = store.isCoop() ? store.formation.activePlayer : null;
    const n = player === null ? store.formation.plan.length : store.planFor(player).length;
    if (!n) return;
    store.clearPlan(player);
    toast(player === null
      ? 'Level-up steps cleared'
      : `P${player}'s level-up steps cleared`);
  });

  $('#btn-clear').addEventListener('click', () => {
    const anything = store.allPlaced().length || store.benchOf(1).length || store.benchOf(2).length;
    if (!anything) return;
    const before = store.snapshot();
    store.clearAll();
    // The formation leaves the address bar; the room does not. Clearing the
    // field is an edit everyone in a session should see, not a way to walk out
    // of it — and dropping the room here would leave the tab still connected
    // with a link that no longer says so.
    const room = roomInHash(location.hash);
    history.replaceState(null, '', location.pathname + location.search + (room ? `#live=${room}` : ''));
    toast('Cleared the field, both benches and the plan', 'info', undoTo(before));
  });

  $('#btn-share').addEventListener('click', async () => {
    if (nothingBrought('Bring some Tatari first')) return;
    await openShare();
  });

  $('#btn-save').addEventListener('click', () => {
    if (nothingBrought('Nothing to export yet')) return;
    downloadJSON(slugFilename(store.formation.name, 'horde-formation'), store.toJSON());
    // The label moved from Save to Export when the in-browser Saved list took
    // the word; the analytics label stays, so the funnel counts stay comparable.
    toast('Exported as a .json file', 'ok');
    track('formation-saved');
  });

  $('#import-file').addEventListener('change', async (e) => {
    const input = e.target;
    try {
      loadFormation(await readJSONFile(input));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      input.value = '';        // so re-picking the same file fires change again
    }
  });

  wireFileDrop();

  window.addEventListener('hashchange', () => {
    if (store.fromHash()) renderAll();
  });
}

function loadFormation(data) {
  // A formation may carry its own custom Tatari; register them first so the
  // placements that reference them resolve.
  const addedCustom = importTatari(data);

  const result = store.fromJSON(data);
  if (!result.ok) { toast(result.reason, 'error'); return; }

  $('#formation-name').value = store.formation.name;
  renderAll();

  const bits = [`Loaded ${store.allPlaced().length} on the field`];
  if (addedCustom) bits.push(`${addedCustom} custom`);
  if (result.unknown.length) bits.push(`${result.unknown.length} unrecognised`);
  toast(bits.join(' · '), result.unknown.length ? 'error' : 'ok');
}

/**
 * Dropping a .json straight onto the page, which sidesteps the OS file picker
 * entirely - useful when the shell dialog is slow or misbehaving.
 */
function wireFileDrop() {
  const hint = $('#drop-hint');
  let depth = 0;

  const carriesFile = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!carriesFile(e)) return;
    e.preventDefault();
    depth++;
    hint.hidden = false;
  });

  window.addEventListener('dragover', (e) => {
    if (carriesFile(e)) e.preventDefault();      // required or the drop never fires
  });

  window.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; hint.hidden = true; }
  });

  window.addEventListener('drop', async (e) => {
    if (!carriesFile(e)) return;
    e.preventDefault();
    depth = 0;
    hint.hidden = true;

    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      toast(`${file.name} is not a .json file`, 'error');
      return;
    }
    try {
      loadFormation(JSON.parse(await file.text()));
    } catch {
      toast(`${file.name} is not valid JSON`, 'error');
    }
  });
}

/**
 * The roster and the field can be far apart - stacked vertically on a phone -
 * so a drag that starts in one needs the page to follow. Without this, dragging
 * from the roster to the field is impossible whenever the grid is off screen,
 * which reads as the feature not working at all.
 */
function wireDragAutoScroll() {
  let velocity = 0;
  let frame = null;

  const step = () => {
    if (!velocity) { frame = null; return; }
    scrollBy(0, velocity);
    frame = requestAnimationFrame(step);
  };

  window.addEventListener('pointermove', (e) => {
    if (!document.body.classList.contains('is-dragging-active')) {
      velocity = 0;
      return;
    }
    velocity = dragScrollVelocity(e.clientY, innerHeight);
    if (velocity && !frame) frame = requestAnimationFrame(step);
  }, { passive: true });

  const stop = () => { velocity = 0; };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

main();
