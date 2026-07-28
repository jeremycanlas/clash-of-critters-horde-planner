/**
 * The share sheet: a preview of the card, an optional name on it, and the three
 * ways out - download the image, copy the image, copy the link.
 *
 * The name is remembered locally rather than kept in the formation: it is who
 * you are, not part of the plan, and it should not ride along in an export.
 */

import * as store from './store.js';
import { $, toast, copyText, downloadBlob, slugFilename } from './ui.js';
import { drawCard, canvasBlob } from './card.js';
import { track } from './analytics.js';

const NAME_KEY = 'coc.sharename';

const dialog = $('#share');
const preview = $('#share-preview');
const nameField = $('#share-name');

/**
 * The card as last drawn. Encoding it is the slow part - about a second at this
 * size - so the preview, the download and the clipboard all share one blob.
 */
let cardBlob = null;
let previewUrl = null;
let redrawTimer = null;

/**
 * How much of the formation the picture carries.
 *
 * 'grid' is the default because that is what actually gets posted — a picture
 * of the field, croppable and readable at thumbnail size in a Discord channel.
 * 'full' is the whole card, for handing someone a complete build.
 */
let scope = 'grid';

const SCOPE_NOTE = {
  grid: 'The field on its own, with what the formation brings. Reads at a glance in a chat.',
  full: 'The field, both benches, the level-up plan and what the formation brings.',
};

export function buildShare() {
  $('#share-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scope]');
    if (!btn || btn.dataset.scope === scope) return;
    scope = btn.dataset.scope;
    renderScope();
    redraw();
  });
  renderScope();

  try { nameField.value = localStorage.getItem(NAME_KEY) || ''; } catch { /* private mode */ }

  nameField.addEventListener('input', () => {
    try { localStorage.setItem(NAME_KEY, nameField.value); } catch { /* private mode */ }
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(redraw, 180);
  });

  $('#share-download').addEventListener('click', () => {
    if (!cardBlob) return;
    downloadBlob(slugFilename(store.formation.name, 'horde-formation', 'png'), cardBlob);
    toast('Card downloaded', 'ok');
    track('card-downloaded');
  });

  $('#share-copy-image').addEventListener('click', async () => {
    if (!cardBlob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob })]);
      toast('Card copied — paste it anywhere', 'ok');
      track('card-copied');
    } catch {
      toast('This browser will not let a page copy an image — use Download instead', 'error');
    }
  });

  $('#share-copy-link').addEventListener('click', async () => {
    const url = store.shareUrl();
    history.replaceState(null, '', url);
    toast(await copyText(url)
      ? 'Share link copied'
      : 'Link is in the address bar — copy it from there', 'ok');
    track('link-copied');
  });

  $('#share-close').addEventListener('click', () => dialog.close());

  // Click the backdrop to dismiss, matching the detail sheet.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', releasePreview);
}

function renderScope() {
  for (const btn of $('#share-scope').children) {
    btn.setAttribute('aria-pressed', String(btn.dataset.scope === scope));
  }
  $('#share-scope-note').textContent = SCOPE_NOTE[scope];
}

function releasePreview() {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
}

/** The action buttons act on the last drawn card, so they wait for it. */
function setBusy(busy) {
  $('#share-drawing').hidden = !busy;
  for (const id of ['#share-download', '#share-copy-image']) $(id).disabled = busy;
}

async function redraw() {
  setBusy(true);
  cardBlob = await canvasBlob(
    await drawCard({ username: nameField.value, full: scope === 'full' }));
  releasePreview();
  previewUrl = URL.createObjectURL(cardBlob);
  preview.src = previewUrl;
  preview.hidden = false;
  setBusy(false);
}

/**
 * The sheet opens before the card is drawn: decoding a dozen sprites takes long
 * enough that waiting first reads as the button doing nothing.
 */
export async function openShare() {
  preview.hidden = true;
  setBusy(true);
  dialog.showModal();
  await redraw();
}
