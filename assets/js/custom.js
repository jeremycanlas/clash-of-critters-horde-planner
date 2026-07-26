/**
 * "Add your own Tatari" — homebrew and not-yet-documented critters, kept in
 * localStorage and bundled into the formation export so a plan built around
 * them still opens on someone else's machine.
 */

import { state, customList, setCustom, normalizeCustom, slugify } from './data.js';
import * as store from './store.js';
import { $, esc, toast, downloadJSON, readJSONFile } from './ui.js';

const dialog = $('#custom');
const form = $('#custom-form');

let onChanged = () => {};

export function buildCustom(callback) {
  onChanged = callback;

  $('#btn-add-custom').addEventListener('click', () => {
    renderList();
    dialog.showModal();
  });

  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dialog) dialog.close();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    if (!name) return;

    const slug = `custom-${slugify(name)}`;
    if (state.bySlug.has(slug)) { toast(`You already added ${name}`, 'error'); return; }

    const family = String(fd.get('family') || '').trim() || name;
    const next = [...customList().map(strip), {
      name, slug, family,
      type: fd.get('type'),
      role: fd.get('role'),
      tier: Number(fd.get('tier')) || 1,
      battleRow: fd.get('battleRow') || null,
      skill: String(fd.get('skill') || '').trim(),
      image: String(fd.get('image') || '').trim() || null,
    }];

    setCustom(next);
    form.reset();
    renderList();
    onChanged();
    toast(`${name} added to the roster`, 'ok');
  });

  $('#custom-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const slug = btn.dataset.remove;
    for (const player of [1, 2]) store.removeFromBench(slug, player);
    setCustom(customList().filter((t) => t.slug !== slug).map(strip));
    renderList();
    onChanged();
  });

  $('#btn-export-custom').addEventListener('click', () => {
    const list = customList();
    if (!list.length) { toast('Nothing to export yet'); return; }
    downloadJSON('my-tatari.json', {
      format: 'clash-of-critters-tatari',
      version: 1,
      tatari: list.map(strip),
      exportedAt: new Date().toISOString(),
    });
  });

  $('#btn-import-custom').addEventListener('click', () => $('#import-custom-file').click());
  $('#import-custom-file').addEventListener('change', async (e) => {
    try {
      const data = await readJSONFile(e.target);
      const added = importTatari(data);
      renderList();
      onChanged();
      toast(added ? `Imported ${added} Tatari` : 'No new Tatari in that file',
        added ? 'ok' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/** Drops the fields that are derived rather than authored. */
function strip(t) {
  const { _search, custom, familyId, stages, evolutionLine, ...rest } = t;
  return rest;
}

/**
 * Accepts either a `{tatari: [...]}` bundle or the `customTatari` block of an
 * exported formation. Existing slugs are left alone rather than overwritten.
 * @returns {number} how many were added
 */
export function importTatari(data) {
  const incoming = Array.isArray(data) ? data
    : Array.isArray(data?.tatari) ? data.tatari
      : Array.isArray(data?.customTatari) ? data.customTatari
        : [];
  if (!incoming.length) return 0;

  const existing = customList().map(strip);
  const known = new Set(state.all.map((t) => t.slug));
  const fresh = [];

  for (const raw of incoming) {
    const t = normalizeCustom(raw, existing.length + fresh.length);
    if (known.has(t.slug)) continue;
    known.add(t.slug);
    fresh.push(strip(t));
  }
  if (fresh.length) setCustom([...existing, ...fresh]);
  return fresh.length;
}

function renderList() {
  const list = customList();
  $('#custom-count').textContent = list.length ? `(${list.length})` : '';
  $('#custom-list').innerHTML = list.map((t) => `
    <li>
      <span>${esc(t.name)}</span>
      <span class="muted">${esc(t.type)} ${esc(t.role)} · T${t.tier}${
        t.family !== t.name ? ` · ${esc(t.family)} line` : ''}</span>
      <button class="btn btn--tiny btn--quiet" type="button"
              data-remove="${esc(t.slug)}">Remove</button>
    </li>`).join('');
}
