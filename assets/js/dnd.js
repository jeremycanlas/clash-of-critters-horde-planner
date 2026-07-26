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
    armed = {
      el, payload, getGhostHTML,
      pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      touch: e.pointerType !== 'mouse',
      timer: null,
    };

    if (armed.touch) {
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
 */
let zones = [];
export function dropZone(spec) { zones.push(spec); }
export function clearDropZones() { zones = []; }

// ---------------------------------------------------------------- internals

function disarm() {
  if (armed?.timer) clearTimeout(armed.timer);
  armed = null;
}

function begin(x, y) {
  const { el, payload, getGhostHTML } = armed;
  disarm();

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.innerHTML = getGhostHTML();
  document.body.append(ghost);

  el.classList.add('is-dragging');
  document.body.classList.add('is-dragging-active');

  active = { payload, ghost, source: el, hovered: null };
  moveGhost(x, y);
}

function moveGhost(x, y) {
  active.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
}

/** Finds the drop zone under the pointer, ignoring the ghost itself. */
function hitTest(x, y) {
  active.ghost.style.visibility = 'hidden';
  const el = document.elementFromPoint(x, y);
  active.ghost.style.visibility = '';
  if (!el) return null;
  for (const zone of zones) {
    const target = el.closest(zone.selector);
    if (target) return { zone, target };
  }
  return null;
}

function setHover(hit) {
  const prev = active.hovered;
  if (prev?.target === hit?.target) return;
  if (prev) prev.zone.onHover?.(prev.target, false, active.payload);
  active.hovered = hit;
  if (hit) hit.zone.onHover?.(hit.target, hit.zone.accepts(hit.target, active.payload), active.payload);
}

function onMove(e) {
  if (active) {
    if (e.cancelable) e.preventDefault();
    moveGhost(e.clientX, e.clientY);
    setHover(hitTest(e.clientX, e.clientY));
    return;
  }
  if (!armed || e.pointerId !== armed.pointerId) return;

  const dx = e.clientX - armed.x0;
  const dy = e.clientY - armed.y0;
  const dist = Math.hypot(dx, dy);

  if (armed.touch) {
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
  if (hit && hit.zone.accepts(hit.target, payload)) hit.zone.onDrop(hit.target, payload);
}

function finish() {
  if (!active) return;
  if (active.hovered) active.hovered.zone.onHover?.(active.hovered.target, false, active.payload);
  active.ghost.remove();
  active.source.classList.remove('is-dragging');
  document.body.classList.remove('is-dragging-active');
  active = null;
}

export function cancelDrag() { disarm(); finish(); }

window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp);
window.addEventListener('pointercancel', cancelDrag);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelDrag(); });
// A drag survives re-renders of the source element, but a stale `.is-dragging`
// class must not.
window.addEventListener('blur', cancelDrag);
