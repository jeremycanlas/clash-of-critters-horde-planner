/** Boot and wiring. */

import { load, state } from './data.js';
import * as store from './store.js';
import {
  $, $$, glitterOn, toast, downloadJSON, readJSONFile, slugFilename, dragScrollVelocity,
} from './ui.js';
import { buildGrid, renderGrid, renderBench, renderPlayerTabs, renderSummary } from './grid.js';
import { buildFilters, renderRoster } from './roster.js';
import { buildPriority, renderPriority } from './priority.js';
import { buildShare, openShare } from './share.js';
import { importTatari } from './custom.js';

function renderAll() {
  renderPlayerTabs();
  renderGrid();
  renderBench();
  renderPriority();
  renderRoster();
  renderSummary();

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
      '(<code>npx serve</code>) — browsers block <code>fetch</code> on <code>file://</code>.</p>';
    console.error(err);
    return;
  }

  buildGrid();
  buildPriority();
  buildShare();
  buildFilters(() => renderRoster());

  store.subscribe(renderAll);

  // A shared link wins over whatever was on screen last time.
  const hash = store.fromHash();
  if (!hash) store.restore();
  renderAll();

  if (hash?.unknown.length) {
    toast(`Skipped ${hash.unknown.length} unknown Tatari from that link`, 'error');
  }

  $('#formation-name').value = store.formation.name;
  $('#foot-meta').textContent =
    `${state.meta.counts.tatari} Tatari · ${state.meta.counts.families} evolution lines · wiki data ${state.meta.scrapedAt}`;

  wireToolbar();
  wireDragAutoScroll();
}

/** Guards the toolbar actions that have nothing to work with yet. */
function nothingBrought(message) {
  if (store.benchOf(1).length || store.benchOf(2).length) return false;
  toast(message);
  return true;
}

function wireToolbar() {
  $('#formation-name').addEventListener('input', (e) => store.setName(e.target.value));

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

  $('#btn-clear-field').addEventListener('click', () => {
    if (!store.allPlaced().length) return;
    store.clearField();
    toast('Field cleared — benches kept');
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
    store.clearAll();
    history.replaceState(null, '', location.pathname + location.search);
    toast('Cleared everything');
  });

  $('#btn-share').addEventListener('click', async () => {
    if (nothingBrought('Bring some Tatari first')) return;
    await openShare();
  });

  $('#btn-save').addEventListener('click', () => {
    if (nothingBrought('Nothing to save yet')) return;
    downloadJSON(slugFilename(store.formation.name, 'horde-formation'), store.toJSON());
    toast('Formation saved', 'ok');
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
