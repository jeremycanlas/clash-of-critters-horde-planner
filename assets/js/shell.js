/**
 * The phone shell.
 *
 * On a phone the field owns the screen, and the roster, the summary and the
 * plan are sheets drawn over it rather than sections further down a long page.
 * All three are the same elements the wider layouts use — the sheet is done in
 * CSS, so nothing here has to re-render them and every existing handler inside
 * them keeps working.
 *
 * Above 760px this module still runs but has nothing to do: the panels are on
 * the page, the app bar is display:none, and no sheet can be opened.
 */

import { $, toast } from './ui.js';
import * as store from './store.js';

const PHONE = matchMedia('(max-width: 760px)');

const bar = $('#appbar');
const scrim = $('#scrim');

/** Which sheet is open, or null. Mirrored onto body[data-sheet] for the CSS. */
let open = null;

/** What had focus before the sheet opened, so closing can give it back. */
let returnTo = null;

const SHEETS = {
  roster: '.panel--roster',
  summary: '#summary',
  priority: '.panel--priority',
  saves: '.panel--saves',
};

export function buildShell() {
  bar.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="share"]')) {
      setSheet(null);
      // Reuses the toolbar's own button rather than opening the dialog a second
      // way, so the share sheet keeps one owner and one set of guards.
      $('#btn-share')?.click();
      return;
    }
    const btn = e.target.closest('[data-sheet]');
    if (btn) setSheet(open === btn.dataset.sheet ? null : btn.dataset.sheet);
  });

  // Tapping the field behind an open sheet means "I want the field", which is
  // the same thing as dismissing.
  scrim.addEventListener('click', () => setSheet(null));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setSheet(null);
    }
  });

  /*
   * Android's back gesture must close the sheet, not leave the site.
   *
   * On a phone a sheet is visually a new screen, and back-to-dismiss is the
   * platform's contract rather than a nicety — 129 of 455 visits are Android,
   * and every one of them could open the roster and be thrown out of the
   * drafter by the gesture they use to go back. Opening pushes a history entry;
   * back pops it and lands here.
   *
   * `fromPop` stops the pair fighting: the listener closes without pushing, and
   * closing any other way pops without re-entering.
   */
  addEventListener('popstate', () => {
    if (open) setSheet(null, { fromPop: true });
  });

  // Rotating to landscape or dragging the window wider must not leave a sheet
  // stranded: past 760px these are ordinary panels sitting on the page, and a
  // body[data-sheet] left behind would have nothing to act on.
  PHONE.addEventListener('change', (e) => { if (!e.matches) setSheet(null); });

  watchDock();
  buildCleanView();
}

/**
 * Clean view: everything off the screen except the field.
 *
 * The dock is fixed and, in co-op, tall enough to cover the bottom of the frame
 * — including the LF and HAVE lines, which are drawn inside the frame precisely
 * so they survive being cropped. Rather than trade away the dock, this gets the
 * chrome out of the way on request, so the phone's own screenshot button
 * captures the formation and nothing else.
 */
function buildCleanView() {
  const leave = () => document.body.classList.remove('is-clean');

  /*
   * Delegated, because one of these buttons lives on the bench dock and the
   * dock is rewritten on every change. The other is in the Formation tools for
   * desktop, where there is no dock.
   */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-clean]')) return;
    setSheet(null);
    document.body.classList.add('is-clean');
    // No toast: it would land on the grid, which is the one thing this view
    // exists to hand over unobstructed. .clean-hint says the same thing from
    // below the frame, where it cannot overlap.
  });

  /*
   * Capture, so the tap that leaves is only a tap that leaves: without it the
   * same tap would land on whatever cell happens to be under the finger and
   * pick up a Tatari on the way out.
   */
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('is-clean')) return;
    e.preventDefault();
    e.stopPropagation();
    leave();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') leave();
  });
}

/**
 * Publishes the dock's height as --dock-h.
 *
 * The dock is fixed above the app bar on a phone, so it covers whatever the page
 * scrolls under it, and the page needs to know how much room to leave. Its
 * height is not a constant: co-op shows two benches, and an empty one collapses
 * to a line. Measuring it is shorter than the cases would be.
 */
function watchDock() {
  const dock = $('#bench');
  if (!dock) return;
  const apply = () =>
    document.documentElement.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
  new ResizeObserver(apply).observe(dock);
  apply();
}

/**
 * Opens one sheet, or closes whatever is open when passed null.
 *
 * Focus moves into the sheet and comes back to the button that opened it, since
 * on a phone the panel is visually a new screen even though it never left the
 * page.
 */
function setSheet(name, { fromPop = false } = {}) {
  if (name === open) return;

  /*
   * One history entry per open sheet, so back closes it. Pushed before the
   * sheet paints and popped when it closes any other way, which keeps the
   * stack the same depth however the sheet was dismissed — otherwise a scrim
   * tap would leave an orphan entry and back would appear to do nothing.
   */
  if (!fromPop) {
    if (name && !open) history.pushState({ sheet: name }, '');
    else if (!name && open) history.back();
  }

  if (name && !returnTo) returnTo = document.activeElement;
  open = name;

  if (name) document.body.dataset.sheet = name;
  else delete document.body.dataset.sheet;

  scrim.hidden = !name;

  /*
   * Everything behind an open sheet goes inert.
   *
   * The sheet looks modal (it sits over an opaque scrim) but Tab walked
   * straight past its last control into the field, the topbar and the footer,
   * all of them invisible underneath. `inert` is the one-property version of a
   * focus trap, and it also hides the background from assistive technology, so
   * the sheet reads as the screen it appears to be.
   *
   * Named one by one rather than by inerting <main>, because three of the four
   * sheets live *inside* <main> — inerting it would disable the sheet being
   * opened. `inert` is inherited and a descendant cannot opt back out, so the
   * only correct move is to never set it on an ancestor of the open panel.
   *
   * That last sentence was the rule and the list below broke it. The summary
   * sheet is `#summary`, which lives inside `.panel--field`, so opening it
   * inerted its own container: the sheet slid up, looked entirely normal, and
   * ignored every tap — the taps fell through to the scrim behind it, whose job
   * is to dismiss, so touching anything in the summary closed it. The roster and
   * the plan are siblings of the field panel and never showed it.
   *
   * So the test is containment rather than identity: nothing that contains the
   * open sheet may be inerted, whatever its selector says. The cost is that the
   * field panel stays reachable behind the summary — one panel less trapped than
   * ideal, against a sheet that does not work at all.
   */
  const openSel = name ? SHEETS[name] : null;
  const openEl = openSel ? $(openSel) : null;
  const behind = ['.topbar', '.foot', '.panel--field', ...Object.values(SHEETS)];
  for (const sel of behind) {
    const el = $(sel);
    if (!el) continue;
    const isOpen = sel === openSel;
    const wrapsOpen = !!openEl && el !== openEl && el.contains(openEl);
    el.inert = !!name && !isOpen && !wrapsOpen;
  }

  renderShell();

  if (name) {
    const panel = $(SHEETS[name]);
    if (panel) {
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
    }
    return;
  }

  if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  returnTo = null;
}

/** Closes any open sheet. Exported so placing a Tatari can get out of the way. */
export function closeSheet() {
  setSheet(null);
}

/**
 * The counts on the app bar. They are the only thing about the roster, the
 * summary and the plan that stays visible while the field has the screen, so
 * they carry the state you would otherwise have to open a sheet to check.
 */
export function renderShell() {
  const bench = store.players().reduce((n, p) => n + store.benchOf(p).length, 0);
  const steps = store.players().reduce((n, p) => n + store.planFor(p).length, 0);

  count('#appbar-bench', bench);
  count('#appbar-field', store.allPlaced().length);
  count('#appbar-steps', steps);

  for (const btn of bar.querySelectorAll('[data-sheet]')) {
    btn.setAttribute('aria-expanded', String(btn.dataset.sheet === open));
  }

  /*
   * The accent points at the next thing to do, not at the last.
   *
   * On a cold screen the only filled control was Share, which answers "Bring
   * some Tatari first" — so the loudest thing on the page refused, while Add,
   * the actual first step, was the same grey as everything else. Until there is
   * something to share, Add is the one lit; the moment anything is brought, the
   * accent moves back to Share and the empty-handed controls come alive.
   */
  const empty = !bench;
  const share = bar.querySelector('[data-action="share"]');
  const add = bar.querySelector('[data-sheet="roster"]');
  share?.classList.toggle('appbar__btn--go', !empty);
  add?.classList.toggle('appbar__btn--go', empty);
  if (share) share.disabled = empty;
  // Clean view offers to strip the chrome off an empty grid; the dock's own
  // Clear is already guarded, but this one was not.
  for (const el of document.querySelectorAll('[data-clean]')) el.disabled = empty;
}

/**
 * Zero reads as "nothing here yet", which the empty state already says.
 *
 * Missing is fine too: the range recorder hosts this same shell for its roster
 * sheet and has no bench, no field and no plan to count.
 */
function count(selector, n) {
  const el = $(selector);
  if (el) el.textContent = n ? String(n) : '';
}
