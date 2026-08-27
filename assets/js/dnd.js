/**
 * One pointer-based drag controller for the whole app.
 *
 * HTML5 drag-and-drop does not fire on touch, and this is a tool for a mobile
 * game, so dragging is built on Pointer Events instead. Mouse drags start after
 * a few pixels of movement; touch drags start after a short press, which leaves
 * ordinary vertical scrolling of the roster intact.
 */

const MOUSE_THRESHOLD = 5;
const TOUCH_HOLD_MS = 180;
const TOUCH_SLOP = 12;

/** @type {null | {payload: any, ghost: HTMLElement, source: HTMLElement, handlers: any}} */
let active = null;
let armed = null;

/**
 * @param {HTMLElement} el
 * @param {() => any} getPayload      describes what is being dragged
 * @param {() => string} getGhostHTML floating preview markup
 */
export function draggable(el, getPayload, getGhostHTML) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('button')) return;          // let the info/remove buttons work
    const payload = getPayload();
    if (!payload) return;

    disarm();
    /*
     * Does this surface already own the gesture?
     *
     * `touch-action: none` is the page telling the browser it will not scroll
     * here -- so on those surfaces the hold and the give-up-if-you-move rule
     * below are protecting a scroll that cannot happen. They only made the
     * gesture fail: press the sprite, swipe, and you got a cancelled drag and
     * no scroll either, which is nothing at all happening. A surface that has
     * declared itself gets the mouse's behaviour, moving straight into a drag.
     */
    const pressed = e.target instanceof Element ? e.target : el;
    const owns = e.pointerType !== 'mouse'
      && getComputedStyle(pressed).touchAction === 'none';

    armed = {
      el, payload, getGhostHTML,
      pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      touch: e.pointerType !== 'mouse',
      owns,
      timer: null,
    };

    /* Only a surface that still has to share the gesture waits. */
    if (armed.touch && !owns) {
      armed.timer = setTimeout(() => {
        if (armed) begin(armed.x0, armed.y0);
      }, TOUCH_HOLD_MS);
    }
  });
}

/**
 * @param {object} spec
 * @param {string} spec.selector        drop targets, resolved on each move
 * @param {(target: HTMLElement, payload: any) => boolean} spec.accepts
 * @param {(target: HTMLElement, payload: any) => void} spec.onDrop
 * @param {(target: HTMLElement|null, ok: boolean) => void} [spec.onHover]
 * @param {(target: HTMLElement, payload: any) => void} [spec.onRefuse]
 *        Dropped here, but `accepts` said no. For saying why.
 */
const zones = [];
export function dropZone(spec) { zones.push(spec); }

// ---------------------------------------------------------------- internals

function disarm() {
  if (armed?.timer) clearTimeout(armed.timer);
  armed = null;
}

function begin(x, y) {
  const { el, payload, getGhostHTML, pointerId, touch } = armed;
  disarm();

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.innerHTML = getGhostHTML();
  document.body.append(ghost);

  el.classList.add('is-dragging');
  document.body.classList.add('is-dragging-active');

  // Capture keeps the moves coming to this element once the finger leaves it,
  // which is most of a drag on a phone.
  try { el.setPointerCapture(pointerId); } catch { /* pointer already gone */ }

  // A short buzz is the only signal a touch user gets that the press became a
  // drag. Not supported everywhere, and no matter where it is not.
  if (touch) navigator.vibrate?.(8);

  active = { payload, ghost, source: el, hovered: null, pointerId };
  moveGhost(x, y);
}

function moveGhost(x, y) {
  active.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
}

/**
 * Finds the drop zone under the pointer, ignoring the ghost itself.
 *
 * The innermost match wins, not the first one registered. Zones nest: the whole
 * roster panel is a zone -- drag a Tatari back onto it to un-bench it -- and the
 * chips' tray sits inside that panel. First-registered meant the panel answered
 * for every point inside it, refused the chip payload, and the drop quietly did
 * nothing. Registration order is an accident of module load order and should
 * never have decided this.
 */
function hitTest(x, y) {
  active.ghost.style.visibility = 'hidden';
  const el = document.elementFromPoint(x, y);
  active.ghost.style.visibility = '';
  if (!el) return null;
  let best = null;      // innermost zone that will actually take this
  let shown = null;     // innermost zone under the pointer, accepting or not

  for (const zone of zones) {
    const target = el.closest(zone.selector);
    if (!target) continue;
    // Deeper wins; unrelated matches keep whichever was found first.
    if (!shown || shown.target.contains(target)) shown = { zone, target };
    if (!zone.accepts(target, active.payload)) continue;
    if (!best || best.target.contains(target)) best = { zone, target };
  }

  /*
   * A zone that will not take what you are carrying does not get to stand in
   * front of one that will.
   *
   * Depth alone was not enough. The roster panel takes a Tatari dragged off the
   * field, and the chips' own zone -- the card list inside that panel, which
   * only takes chips -- is deeper. So dragging a critter back to the roster
   * landed on the chip zone, which refused it, and the panel behind it never
   * heard about the drop. Nothing happened and nothing said why.
   *
   * When nothing will take it, the innermost is still returned so it can draw
   * the refusal. Being told no is not the same as being ignored.
   */
  return best ?? shown;
}

function setHover(hit) {
  const prev = active.hovered;
  if (prev?.target === hit?.target) return;
  if (prev) prev.zone.onHover?.(prev.target, false, active.payload);
  active.hovered = hit;
  if (hit) hit.zone.onHover?.(hit.target, hit.zone.accepts(hit.target, active.payload), active.payload);
}

/**
 * Coalesced to one frame.
 *
 * The move handler writes the ghost's transform and then hit-tests, and the hit
 * test reads `elementFromPoint`, which forces a synchronous style and layout
 * flush. Write, read, write -- once per pointermove, and a 120Hz pointer fires
 * more often than the screen redraws, so most of that work was thrown away
 * before anyone saw it. Now the last position each frame is the one that costs
 * anything.
 */
let queued = null;
let frame = null;

function flushMove() {
  frame = null;
  if (!queued || !active) return;
  const { x, y } = queued;
  moveGhost(x, y);
  setHover(hitTest(x, y));
}

function onMove(e) {
  if (active) {
    if (e.cancelable) e.preventDefault();
    queued = { x: e.clientX, y: e.clientY };
    if (frame === null) frame = requestAnimationFrame(flushMove);
    return;
  }
  if (!armed || e.pointerId !== armed.pointerId) return;

  const dx = e.clientX - armed.x0;
  const dy = e.clientY - armed.y0;
  const dist = Math.hypot(dx, dy);

  if (armed.touch && !armed.owns) {
    if (dist > TOUCH_SLOP) disarm();          // the user is scrolling, not dragging
  } else if (dist > MOUSE_THRESHOLD) {
    begin(e.clientX, e.clientY);
  }
}

function onUp(e) {
  if (!active) { disarm(); return; }

  const hit = hitTest(e.clientX, e.clientY);
  const { payload } = active;
  finish();
  if (!hit) return;
  if (hit.zone.accepts(hit.target, payload)) { hit.zone.onDrop(hit.target, payload); return; }
  /*
   * A refusal is an answer. Say it.
   *
   * Letting go over somewhere that will not take what you are carrying used to
   * do nothing whatsoever -- no move, no message -- which is indistinguishable
   * from a drag that failed to work. Clicking the same card has always
   * explained itself. A zone that has something to say implements onRefuse;
   * the ones where "no" is obvious from where you dropped it stay quiet.
   */
  hit.zone.onRefuse?.(hit.target, payload);
}

function finish() {
  if (!active) return;
  // A frame still pending would run moveGhost against a ghost that is about to
  // be removed, and hit-test a drag that has already ended.
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  queued = null;
  if (active.hovered) active.hovered.zone.onHover?.(active.hovered.target, false, active.payload);
  active.ghost.remove();
  active.source.classList.remove('is-dragging');
  try { active.source.releasePointerCapture(active.pointerId); } catch { /* already released */ }
  document.body.classList.remove('is-dragging-active');
  active = null;
}

export function cancelDrag() { disarm(); finish(); }

/**
 * Nothing in this app is a native drag source - every drag is pointer-driven.
 * Left alone, the browser starts its own drag of the sprite under the cursor
 * and hands it over as an image file, so the page's own "drop a formation
 * .json here" hint fires in the middle of dragging a Tatari to the field.
 * Text selections elsewhere (the formation name, say) keep working.
 */
document.addEventListener('dragstart', (e) => {
  if (e.target.closest?.('img, .card, .benchchip, .cell, .prio, .token')) e.preventDefault();
});

/**
 * The same collision, on touch: a long press is this app's drag gesture and it
 * is also the browser's "do something with this image" gesture, and the browser
 * wins. Pressing a bench chip to move a Tatari opened Download image / Open in
 * new tab instead. -webkit-touch-callout in app.css settles it on iOS; Chrome
 * on Android has no CSS equivalent, so the event itself has to be refused.
 *
 * Only for touch, and only over the surfaces that are dragged. Right-clicking a
 * sprite with a mouse is not a mistake and that menu is left alone, as is every
 * other image on the page -- long-pressing a posted card to save it still works.
 */
const DRAG_SURFACES = '.card, .benchchip, .cell, .prio, .token, .keptrow, .chipbench__chip';
let touchLast = false;
window.addEventListener('pointerdown', (e) => { touchLast = e.pointerType !== 'mouse'; }, true);

document.addEventListener('contextmenu', (e) => {
  if (!touchLast && !active) return;
  if (active || e.target.closest?.(DRAG_SURFACES)) e.preventDefault();
});

window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp);
window.addEventListener('pointercancel', cancelDrag);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelDrag(); });
// A drag survives re-renders of the source element, but a stale `.is-dragging`
// class must not.
window.addEventListener('blur', cancelDrag);
