/** Boot and wiring. */

import { load, state } from './data.js';
import * as store from './store.js';
import {
  $, $$, glitterOn, toast, downloadJSON, readJSONFile, slugFilename, dragScrollVelocity,
  APP_VERSION,
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
import { buildSaves, savedById } from './saves.js';
import { buildSubmit, openSubmit, resumeSubmit } from './submit.js';
import { isConfigured, readCallback } from './supabase.js';
import { buildAnalytics, track } from './analytics.js';
import { importTatari } from './custom.js';

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
  buildShare();
  buildShell();
  buildSaves({ canPost: isConfigured(), onPost: openSubmit });
  const pending = buildSubmit();
  buildAnalytics();
  buildFilters(() => renderRoster());

  store.subscribe(renderAll);
  countFirstUse();

  // A shared link wins over whatever was on screen last time.
  const hash = store.fromHash();
  if (!hash) store.restore();
  renderAll();

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
  // The name is in the markup so it shows without JS; only the version is
  // filled in, from the one constant that also stamps the share card.
  $('#app-version').textContent = `v${APP_VERSION}`;

  wireToolbar();
  wireDragAutoScroll();
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
      toast(`Zobo ground closed — benched ${unplaced}`, 'info', undoTo(before));
    }
  });

  const sandboxBox = $('#opt-sandbox');
  sandboxBox.addEventListener('change', (e) => {
    const on = e.target.checked;

    if (on) {
      store.setSandbox(true);
      toast('Sandbox on — caps off');
      return;
    }

    const before = store.snapshot();
    const got = store.setSandbox(false);

    /*
     * Said plainly, and undoable, rather than confirmed in advance.
     *
     * A confirm was the first instinct, and Clear all is the argument against
     * it: it destroys strictly more than this does and still just acts, because
     * the toast carries Undo for six seconds and that is a better deal than a
     * modal. Two paths to the same kind of loss should not behave differently,
     * and a native confirm would be the only one in the app besides being a
     * dialog that blocks the page under it.
     *
     * What the toast owes in exchange is precision. "Sandbox off" alone would
     * hide the removal; the counts are separated because they are different
     * events — benched Tatari are still yours, removed ones are not.
     */
    const said = [];
    if (got.unplaced) said.push(`benched ${got.unplaced}`);
    if (got.dropped) said.push(`removed ${got.dropped} that would not fit`);
    toast(said.length ? `Sandbox off — ${said.join(', ')}` : 'Sandbox off — caps are back',
      got.dropped ? 'warn' : 'info', said.length ? undoTo(before) : null);
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
      : `${store.mode().label} — ${store.fieldCap()} on the field per player`);
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
    history.replaceState(null, '', location.pathname + location.search);
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
