/**
 * Spots you have filled but have not settled.
 *
 * The problem this is for: you have three front-line squares and six Tatari you
 * would happily put in them. Three of them go down, the other three sit on the
 * bench, and nothing anywhere records that the three on the bench were ever in
 * the running. A day later the board looks decided, and the thinking is gone.
 *
 * So a group names some squares and the Tatari you would swap into them. Your
 * best guess stands on the board normally -- that is the load-bearing decision,
 * and everything follows from it. The type tally, the roles, the heals and
 * buffs, the plan: all of them count placements, and the placements are real, so
 * none of them has to learn a word about this. A copy of the tool that has never
 * heard of swaps still draws a whole, legal formation from the same link. It
 * simply does not know what else you considered.
 *
 * One record covers both shapes people wanted. Three squares and three
 * candidates is a front line; one square and two candidates is a single tile you
 * cannot decide about. The count is the number of squares, so nobody types it.
 *
 * Where the two halves are drawn is not arbitrary:
 *
 * - The legend goes *inside* .field-frame, beside the LF band, because the frame
 *   is what gets screenshotted into Discord and a shortlist outside it would be
 *   cropped off the one artifact it exists for.
 * - The editor goes *outside* the frame, beside #range-gap, because it is a
 *   control. The row above the frame already learned that lesson with the site
 *   URL: anything in the frame rides along in every share.
 */

import { state } from './data.js';
import * as store from './store.js';
import { $, artHTML, esc, toast } from './ui.js';

/* The frame is photographed, so nothing in it may still be loading. */
const ON_CARD = { lazy: false };

/** A, B, C, D. The badge on the square and the tag on the legend line agree. */
export const swapLetter = (index) => String.fromCharCode(65 + index);

/*
 * Marking is a state of the pointer, not of the formation -- the same split
 * flex marking makes. Which squares are grouped is saved, shared and undone with
 * the board; whether you are currently picking is not, and a co-op partner
 * opening your link should not arrive mid-edit.
 */
const picking = new Set();
const chosen = new Set();

const marking = () => document.body.classList.contains('is-flexing');

/** Everyone this player brought who is not already standing in the picked squares. */
function offerable() {
  const player = store.formation.activePlayer;
  const standing = new Set([...picking].map((i) => store.formation.cells[i]?.slug));
  return store.benchOf(player)
    .filter((slug) => !standing.has(slug))
    .map((slug) => state.bySlug.get(slug))
    .filter(Boolean);
}

/**
 * A tap on the board while marking.
 *
 * Called from the board handler in grid.js rather than from a listener of our
 * own, because two modes cannot both own a tap and the ordering between them has
 * to be decided in one place -- see the flex branch it sits beside.
 */
export function swapTap(cell) {
  const group = store.swapIndexAt(cell);
  if (group >= 0) {
    // A square already in a group is not a square to pick; the group is the
    // thing you are pointing at, and the only thing to do to it here is undo it.
    store.removeSwap(group);
    toast(`Group ${swapLetter(group)} dropped`, 'ok');
    return;
  }
  // Only ever called for an occupied square -- the board handler in grid.js
  // sends the empty ones to toggleFlex, which is the other half of this mode.
  if (picking.has(cell)) picking.delete(cell); else picking.add(cell);
  renderSwaps();
}

function reset() {
  picking.clear();
  chosen.clear();
}

export function buildSwaps() {
  /*
   * A second listener on the one marking switch rather than a switch of our own.
   *
   * grid.js owns that checkbox -- it is the one that knows how to redraw a board
   * -- and this half only needs to know that marking started or stopped, so it
   * can drop a half-built group rather than leave it lying around for the next
   * time the mode is opened.
   */
  $('#opt-flex')?.addEventListener('change', () => {
    reset();
    renderSwaps();
  });

  /*
   * The pressed state is written onto the button rather than redrawn from it.
   *
   * Rebuilding the picker on every tap replaced the very button under the
   * finger, which on a phone reads as a tap that did not land -- and in a burst
   * of taps the later ones are aimed at elements that no longer exist. So a
   * candidate tap touches one attribute and the two things that actually
   * changed; the row itself is only rebuilt when what is on offer changes,
   * which is when the board does.
   */
  $('#swap-picker')?.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-slug]');
    if (!opt) return;
    const slug = opt.dataset.slug;
    if (chosen.has(slug)) chosen.delete(slug); else chosen.add(slug);
    opt.setAttribute('aria-pressed', String(chosen.has(slug)));
    refreshBar();
  });

  $('#swap-save')?.addEventListener('click', () => {
    const result = store.addSwap([...picking], [...chosen]);
    if (!result.ok) { toast(result.reason, 'error'); return; }
    reset();
    renderSwaps();
  });

  $('#swap-cancel')?.addEventListener('click', () => {
    reset();
    renderSwaps();
  });
}

export function renderSwaps() {
  renderLegend();

  const bar = $('#swap-bar');
  if (!bar) return;
  bar.hidden = !marking();
  if (bar.hidden) return;

  // Squares that emptied under the picker are not squares any more.
  for (const cell of [...picking]) if (!store.formation.cells[cell]) picking.delete(cell);

  const offers = offerable();
  const live = new Set(offers.map((t) => t.slug));
  for (const slug of [...chosen]) if (!live.has(slug)) chosen.delete(slug);

  $('#swap-picker').innerHTML = offers.map((t) => `
    <button class="swap-pick" type="button" data-slug="${esc(t.slug)}"
            data-type="${esc(t.type)}" aria-pressed="${chosen.has(t.slug)}"
            title="${esc(t.name)}">
      ${artHTML(t, ON_CARD)}
    </button>`).join('') || '<p class="swapbar__none">Everyone you brought is already on the board.</p>';

  refreshBar();
}

/** The two things a candidate tap changes: what the bar says, and whether it can be saved. */
function refreshBar() {
  const hint = $('#swap-hint');
  if (!hint) return;
  const n = picking.size;
  hint.textContent = !n
    ? 'Tap the squares you have not settled on. Whoever is standing there stays put.'
    : !chosen.size
      ? `${n} square${n === 1 ? '' : 's'}. Now name who else you would put there.`
      : `Any ${n} of these ${n + chosen.size}, across ${n} square${n === 1 ? '' : 's'}.`;
  $('#swap-save').disabled = !n || !chosen.size;
}

/**
 * The strip inside the frame.
 *
 * Drawn whether or not marking is on, for the reason the FLEX word is: the
 * formation is mostly read as a screenshot by somebody who was never in marking
 * mode, and a shortlist that only showed while you were editing it would be
 * invisible in the one place it exists for.
 */
function renderLegend() {
  const shown = $('#field-swaps');
  if (!shown) return;
  const groups = store.formation.swaps;
  shown.hidden = !groups.length;
  shown.innerHTML = groups.map((g, i) => {
    const named = g.slugs.map((slug) => state.bySlug.get(slug)).filter(Boolean);
    return `<span class="field-swap">
      <span class="field-swap__tag">${swapLetter(i)}</span>
      <span class="field-swap__or">or</span>${
      named.map((t) => `<span class="field-swap__want" data-type="${esc(t.type)}">${
        artHTML(t, ON_CARD)}<span>${esc(t.name)}</span></span>`).join('')}
    </span>`;
  }).join('');
}
