/**
 * The share sheet: a preview of the card, an optional name on it, and the ways
 * out - download the image, copy the image, copy the link, post it publicly.
 *
 * The name is remembered locally rather than kept in the formation: it is who
 * you are, not part of the plan, and it should not ride along in an export.
 *
 * Posting is injected rather than imported, the same way saves.js takes its
 * Post: this module draws a card and hands out copies of it, and it has no
 * business knowing that a database exists.
 */

import * as store from './store.js';
import { $, toast, copyText, downloadBlob, slugFilename, dismissOnBackdrop } from './ui.js';
import { drawCard, canvasBlob } from './card.js';
import { chipList, keptBy } from './chips.js';
import { roomInHash, withRoom } from './hash.js';
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

/**
 * @param {{canPost?: boolean, onPost?: () => void}} [opts]
 *   `canPost` reveals the Post row; `onPost` is called with the sheet already
 *   closed, so the dialog it opens is not the second modal on screen.
 */
export function buildShare(opts = {}) {
  if (opts.canPost && opts.onPost) {
    $('#share-post-row').hidden = false;
    $('#share-post').addEventListener('click', () => {
      // Closed first. Two stacked modals put the formation's picture behind a
      // second backdrop, and Escape then closes the wrong one.
      dialog.close();
      opts.onPost();
    });
  }

  $('#share-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scope]');
    if (!btn || btn.dataset.scope === scope) return;
    scope = btn.dataset.scope;
    renderScope();
    redraw();
  });
  renderScope();
  renderShareRoutes();

  try { nameField.value = localStorage.getItem(NAME_KEY) || ''; } catch { /* private mode */ }

  nameField.addEventListener('input', () => {
    try { localStorage.setItem(NAME_KEY, nameField.value); } catch { /* private mode */ }
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(redraw, 180);
  });

  /*
   * The native share sheet, when the browser has one.
   *
   * This is the answer to the number in PRODUCT.md: 286 opens produced four
   * downloads, three image copies and zero copied links. On iOS (47% of
   * browsers here) none of the other three routes actually reaches Discord.
   * Writing an image to the clipboard is unreliable there, and a download lands
   * in Files rather than Photos, which is not where anyone posts from.
   *
   * `navigator.share` with a File is one tap into Messages, Discord or anywhere
   * else, and it needs no clipboard permission. Feature-detected with canShare
   * on the actual file, because Android Chrome exposes `share` while refusing
   * files in some configurations — asking about the thing we are sending is the
   * only test that means anything.
   *
   * AbortError is the person changing their mind, not a failure. Saying
   * "couldn't share" to somebody who pressed Cancel would be the tool arguing
   * with them.
   */
  $('#share-native').addEventListener('click', async () => {
    if (!cardBlob) return;
    const file = new File([cardBlob],
      slugFilename(store.formation.name, 'horde-formation', 'png'), { type: 'image/png' });
    if (!navigator.canShare?.({ files: [file] })) {
      toast('This browser cannot share a file. Use Download instead', 'error');
      return;
    }
    try {
      await navigator.share({
        files: [file],
        title: store.formation.name || 'Horde formation',
      });
      track('card-shared');
    } catch (err) {
      if (err?.name !== 'AbortError') toast('Could not open the share sheet', 'error');
    }
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
      toast('Card copied. Paste it anywhere', 'ok');
      track('card-copied');
    } catch {
      toast('This browser will not let a page copy an image. Use Download instead', 'error');
    }
  });

  $('#share-copy-link').addEventListener('click', async () => {
    const url = store.shareUrl();
    /*
     * The copied link carries the formation and not the room, which is the
     * distinction between the two features: a share link hands somebody the
     * build to take away, and dragging a stranger into a live session because
     * they were sent a picture is not what either of them asked for.
     *
     * The address bar is the other way round. shareUrl() rebuilds the fragment
     * from scratch, so writing it here would quietly drop the room from the
     * address of a session that is still running — and the next person to copy
     * what is in the bar, or to reload, would find themselves alone.
     */
    history.replaceState(null, '', withRoom(url, roomInHash(location.hash)));
    toast(await copyText(url)
      ? 'Share link copied'
      : 'Link is in the address bar. Copy it from there', 'ok');
    track('link-copied');
  });

  $('#share-close').addEventListener('click', () => dialog.close());

  // Click the backdrop to dismiss, matching the detail sheet.
  dismissOnBackdrop(dialog);
  dialog.addEventListener('close', releasePreview);
}

/**
 * Share... is primary where it exists, and absent where it does not.
 *
 * A button that is present but always fails is worse than one that never
 * appeared, so this is decided once from canShare rather than being disabled
 * later. Where it is offered, Download stops being the loudest thing in the
 * row — on a phone it is the worst of the three.
 */
function renderShareRoutes() {
  const probe = new File([new Blob([''], { type: 'image/png' })], 'x.png', { type: 'image/png' });
  const native = !!navigator.canShare?.({ files: [probe] });
  $('#share-native').hidden = !native;
  $('#share-download').classList.toggle('btn--primary', !native);
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
  /*
   * The chips travel with the picture, because the picture is how formations
   * travel. Resolved to names and tiers here rather than in card.js: what you
   * kept lives in the chips module and card.js has no business learning about a
   * fourth data source for one optional strip.
   */
  const kept = keptBy(store.formation.activePlayer);
  const byName = new Map(chipList().map((c) => [c.name, c]));
  const named = (list) => list
    .map((name) => ({ name, tier: byName.get(name)?.tier ?? 1 }));

  cardBlob = await canvasBlob(
    await drawCard({
      username: nameField.value,
      full: scope === 'full',
      chips: { main: named(kept.main), extra: named(kept.extra) },
    }));
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
