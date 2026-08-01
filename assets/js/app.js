/** Boot and wiring. */

import { load, state } from './data.js';
import * as store from './store.js';
import {
  $, $$, glitterOn, toast, downloadJSON, readJSONFile, slugFilename, dragScrollVelocity,
  APP_VERSION,
} from './ui.js';
import {
  buildGrid, renderGrid, renderBench, renderPlayerTabs, renderSummary,
  renderRanges, rangesOn, renderLfSuggestions, bossPullOn,
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

  $('#opt-pull').addEventListener('change', (e) => {
    bossPullOn.value = e.target.checked;
    renderGrid();
  });

  $('#opt-glitter').addEventListener('change', (e) => {
    glitterOn.value = e.target.checked;
    renderAll();
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
