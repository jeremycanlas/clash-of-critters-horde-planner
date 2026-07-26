/** Boot and wiring. */

import { load, state } from './data.js';
import * as store from './store.js';
import {
  $, $$, glitterOn, toast, downloadJSON, readJSONFile, slugFilename, dragScrollVelocity,
} from './ui.js';
import { buildGrid, renderGrid, renderBench, renderPlayerTabs, renderSummary } from './grid.js';
import { buildFilters, renderRoster } from './roster.js';
import { buildPriority, renderPriority } from './priority.js';
import { buildCustom, importTatari } from './custom.js';

function renderAll() {
  renderPlayerTabs();
  renderGrid();
  renderBench();
  renderPriority();
  renderRoster();
  renderSummary();
  renderCounter();

  for (const btn of $$('#mode-switch .segmented__btn')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === store.formation.mode));
  }
  document.body.dataset.mode = store.formation.mode;
  document.body.dataset.activePlayer = String(store.formation.activePlayer);
}

/** In co-op the per-player tabs carry the detail, so the chip stays a bare total. */
function renderCounter() {
  const counter = $('#deploy-count');
  const onField = store.allPlaced().length;
  const cap = store.fieldCap() * store.playerCount();
  counter.textContent = `${onField} / ${cap}`;
  counter.title = store.isCoop()
    ? `${onField} on the field across both players, ${store.fieldCap()} each`
    : `${onField} of ${cap} on the field`;
  counter.dataset.full = String(onField >= cap);
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
  buildFilters(() => renderRoster());
  buildCustom(renderAll);

  store.subscribe(renderAll);

  const restored = store.restore();
  const hash = store.fromHash();
  renderAll();

  if (hash?.unknown.length) {
    toast(`Skipped ${hash.unknown.length} unknown Tatari from that link`, 'error');
  }
  void restored;

  $('#formation-name').value = store.formation.name;
  $('#foot-meta').textContent =
    `${state.meta.counts.tatari} Tatari · ${state.meta.counts.families} evolution lines · wiki data ${state.meta.scrapedAt}`;

  wireToolbar();
  wireDragAutoScroll();
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

  $('#btn-clear-plan').addEventListener('click', () => {
    if (!store.formation.plan.length) return;
    store.clearPlan();
    toast('Level-up steps cleared');
  });

  $('#btn-clear').addEventListener('click', () => {
    const anything = store.allPlaced().length || store.benchOf(1).length || store.benchOf(2).length;
    if (!anything) return;
    store.clearAll();
    history.replaceState(null, '', location.pathname + location.search);
    toast('Cleared everything');
  });

  $('#btn-share').addEventListener('click', async () => {
    if (!store.benchOf(1).length && !store.benchOf(2).length) {
      toast('Bring some Tatari first');
      return;
    }
    const url = store.shareUrl();
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied', 'ok');
    } catch {
      toast('Link is in the address bar — copy it from there');
    }
  });

  $('#btn-export').addEventListener('click', () => {
    if (!store.benchOf(1).length && !store.benchOf(2).length) {
      toast('Nothing to export yet');
      return;
    }
    downloadJSON(slugFilename(store.formation.name, 'horde-formation'), store.toJSON());
  });

  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    try {
      const data = await readJSONFile(e.target);

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
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  window.addEventListener('hashchange', () => {
    if (store.fromHash()) renderAll();
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
