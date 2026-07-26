/** Boot and wiring. */

import { load, state } from './data.js';
import * as store from './store.js';
import { $, glitterOn, toast, downloadJSON, readJSONFile, slugFilename } from './ui.js';
import { buildGrid, renderGrid, renderSummary } from './grid.js';
import { buildFilters, renderRoster } from './roster.js';
import { buildPriority, renderPriority } from './priority.js';
import { buildCustom, importTatari } from './custom.js';

function renderAll() {
  renderGrid();
  renderPriority();
  renderRoster();
  renderSummary();

  const n = store.deployedCount();
  const counter = $('#deploy-count');
  counter.textContent = `${n} / ${store.MAX_DEPLOYED}`;
  counter.dataset.full = String(n >= store.MAX_DEPLOYED);
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
  renderAll();

  const hash = store.fromHash();
  if (hash?.unknown.length) {
    toast(`Skipped ${hash.unknown.length} unknown Tatari from that link`, 'error');
  }
  if (restored) renderAll();

  $('#formation-name').value = store.formation.name;
  $('#foot-meta').textContent =
    `${state.meta.counts.tatari} Tatari · ${state.meta.counts.families} evolution lines · wiki data ${state.meta.scrapedAt}`;

  wireToolbar();
}

function wireToolbar() {
  $('#formation-name').addEventListener('input', (e) => store.setName(e.target.value));

  $('#opt-glitter').addEventListener('change', (e) => {
    glitterOn.value = e.target.checked;
    renderAll();
  });

  // Squeezes everything toward the back rows without changing column or order.
  $('#btn-compact').addEventListener('click', () => {
    const occupants = [];
    for (let i = store.CELLS - 1; i >= 0; i--) {
      if (store.formation.cells[i]) occupants.push(store.formation.cells[i]);
    }
    store.clear();
    occupants.forEach((slug, k) => store.place(slug, store.CELLS - 1 - k));
    toast('Packed into the back rows');
  });

  $('#btn-clear').addEventListener('click', () => {
    if (!store.deployedCount()) return;
    store.clear();
    history.replaceState(null, '', location.pathname + location.search);
    toast('Formation cleared');
  });

  $('#btn-share').addEventListener('click', async () => {
    if (!store.deployedCount()) { toast('Place something first'); return; }
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
    if (!store.deployedCount()) { toast('Nothing to export yet'); return; }
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

      const bits = [`Loaded ${store.deployedCount()} Tatari`];
      if (addedCustom) bits.push(`${addedCustom} custom`);
      if (result.unknown.length) bits.push(`${result.unknown.length} unrecognised`);
      toast(bits.join(' · '), result.unknown.length ? 'error' : 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  window.addEventListener('hashchange', () => {
    const hash = store.fromHash();
    if (hash) renderAll();
  });
}

main();
