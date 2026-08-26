/**
 * Live sessions: two or more browsers editing one formation.
 *
 * live.js moves the messages; this decides what they mean. Everything here is
 * dormant until somebody starts a session or opens a link with a room in it, and
 * that is the whole design constraint — solo and co-op behave exactly as they
 * did, no socket is opened, and `session.js` may as well not exist. Nothing in
 * the drafter asks whether a session is running; this module listens to the
 * store like any other panel and pushes what changed.
 *
 * ## Seats are not people
 *
 * Co-op already had two players, and it keeps them: P1 and P2 are halves of a
 * formation, not chairs. Everybody in a room can move everybody's Tatari, switch
 * the player tab, and edit either bench — the same tool, with more hands on it.
 * The one piece of state that stays private is which tab you are looking at,
 * and that falls out for free: `store.snapshot()` has never included
 * `activePlayer`, so it is the one field this module cannot sync even by
 * accident. You can be drafting P1 while somebody else drafts P2 on the same
 * board.
 *
 * A room is capped at two people — see enforceCap() and MAX_PEERS. Two is what
 * the planning call this is for needs, and it keeps the cost bounded: a broadcast
 * fans out to everyone else in the room, so a third person turns every cursor
 * move from one message into two, and an afternoon-long four-way room is how a
 * month's Realtime allowance disappears.
 *
 * ## Why there is no CRDT here
 *
 * Text needs one because inserting a character moves every character after it,
 * so two edits have to be rewritten against each other before they can both
 * apply. A formation is not text. It is 36 numbered slots, two benches, a plan
 * and a handful of scalars, and none of those indices shift under each other.
 * Last-writer-wins on each field independently is not a compromise, it is the
 * correct answer: if we both drop something on cell 14, one of us gets it and we
 * both see the same board a moment later.
 *
 * So the unit of sync is a *field*, and `flatten()` below decides what one is —
 * each cell separately, so two people working opposite corners never touch the
 * same field, and the bigger structures whole, because a plan with one step
 * reordered is cheaper to send entire than to describe.
 *
 * ## Ordering
 *
 * Each field carries `[count, peer]`. A write bumps the count; a tie is broken
 * on the peer id, which is arbitrary but identical everywhere, so every browser
 * resolves the same collision the same way without a clock. Wall time would have
 * been simpler and wrong: two laptops disagree about what time it is by more
 * than the width of a drag.
 */

import * as store from './store.js';
import { ALL_CELLS } from './rules.js';
import { $, esc, toast, copyText, dismissOnBackdrop } from './ui.js';
import { cellElement } from './grid.js';
import { joinRoom, newRoom, isRoom } from './live.js';
import { roomInHash, withRoom, withoutRoom } from './hash.js';
import { track } from './analytics.js';
import { isConfigured } from './supabase.js';

/**
 * The shortest gap between two "I am on this square" messages.
 *
 * Not a send rate — watchPointer() speaks only when the square changes, and a
 * hand crossing a board changes squares a few times a second at most. This is
 * the floor for the one case that could be noisy: a pointer resting on a seam
 * between two cells, where the smallest wobble alternates between them. 90ms
 * caps that at about eleven a second and is imperceptible for real movement.
 *
 * See the note in live.js about why none of this can use presence, which is
 * limited to one update every six seconds.
 */
const CURSOR_MS = 90;

/**
 * The off switch.
 *
 * Set to false and the Live button never appears, no socket is ever opened, and
 * the drafter is exactly what it was before any of this existed. It is here
 * because a shared quota is the one thing this feature can exhaust that other
 * people would notice — running out of Realtime messages stops live sessions
 * until the month turns over, and this is how you stop them yourself first,
 * with a one-line change and a deploy.
 *
 * Nothing else is affected either way. The gallery talks to a different service
 * with its own allowance, and the drafter has never needed the network at all.
 */
const LIVE_ENABLED = true;

/**
 * The most messages one session will spend on pointers before it stops sending
 * them and carries on as a plain shared board.
 *
 * A generous twenty-minute session costs a few hundred now that pointers are
 * sent per square rather than per frame, so nobody reaches this by collaborating
 * normally. It is a stop for the case that is not normal — an afternoon-long
 * room, or a hand resting somewhere that keeps changing its mind — so that no
 * single session can quietly spend a month's allowance. Set low deliberately:
 * 1,500 is far above real use and still caps a runaway room at a fraction of a
 * percent of the monthly free tier.
 *
 * Editing is never cut off. Losing sight of somebody's pointer is a shame;
 * losing the ability to move a Tatari is the feature not working.
 */
const CURSOR_BUDGET = 1_500;

/**
 * A live room is two people, enforced by everyone in it — see enforceCap().
 * Raising this raises the Realtime cost more than linearly (every broadcast fans
 * out to each other peer), so it is a deliberate ceiling, not a default.
 */
const MAX_PEERS = 2;

/** How long a peer's pointer stays on screen after it stops arriving. */
const CURSOR_IDLE_MS = 8_000;

let link = null;                 // the live.js handle, or null when not in a session
let fields = null;               // the shared view: field name -> value
let version = new Map();         // field name -> [count, peer]
let applying = false;            // suppresses the echo while a remote edit lands
let caughtUp = false;            // the room has answered our first hello
let committed = false;           // we have seen the room had space for us — see enforceCap()
let preJoin = null;              // the board we had before joining, restored if the room turns us away
let spentOnCursors = 0;          // pointer messages this session — see CURSOR_BUDGET
let invited = null;              // a room from a link, held until the arrival is answered
let peers = new Map();           // peer key -> {name, colour, ...}
let cursors = new Map();         // peer key -> {el, cell, seen}
let layer = null;                // the fixed-position layer remote pointers live in
let unsubscribe = null;

/** Who this browser says it is. Kept across sessions; it is only a label. */
const NAME_KEY = 'coc.live.name';
const myName = () => (localStorage.getItem(NAME_KEY) || '').trim();

/**
 * The rooms this browser opened.
 *
 * Being the host is not a thing the room can tell you — presence is whatever
 * each peer says about itself, so "I started this" would be a claim anybody
 * could make. It does not need to be authoritative to be useful: it decides
 * which browser draws the Kick buttons, and the kick itself works by moving
 * everybody else somewhere new rather than by an instruction the kicked peer is
 * trusted to obey. See kick().
 *
 * In localStorage rather than a variable because a host who reloads is arriving
 * on their own link, and would otherwise come back as a guest in their own room.
 */
const HOSTED_KEY = 'coc.live.hosted';

function hostedRooms() {
  try { return new Set(JSON.parse(localStorage.getItem(HOSTED_KEY) || '[]')); } catch { return new Set(); }
}

function rememberHosted(room) {
  const all = [...hostedRooms(), room].slice(-20);   // no need to remember forever
  try { localStorage.setItem(HOSTED_KEY, JSON.stringify(all)); } catch { /* private mode */ }
}

/** What the user typed, or '' when they are happy to be a guest. */
let chosen = myName();
/** The guest number we hold while `chosen` is empty. */
let display = 'Guest';
/** Whether this browser opened the room it is in. */
let hosting = false;

// ---------------------------------------------------------------- fields

/**
 * A snapshot as a flat map of independently-versioned fields.
 *
 * Every cell is a separate entry — all 78 of them, the 6×6 field and the Zobo
 * ground beyond the contact line that Sandbox and a boss pull reach into — and
 * everything else is whole. That split is the entire conflict story: two people
 * placing Tatari in different squares are writing different keys and cannot
 * collide, while two people reordering the same plan are writing one key and the
 * later write wins — the only behaviour that makes sense for an ordered list
 * nobody can merge blind.
 *
 * `sandbox`, `zoboGround` and `pullRows` ride as whole fields of their own. They
 * are what opens the ground past the line, so without them a peer's Zobo lands
 * on a row the other browser has not opened and reconcile() sweeps it straight
 * back to the bench — the same class of bug the share link had before it carried
 * pullRows.
 */
function flatten(snap) {
  const out = {
    mode: snap.mode,
    name: snap.name,
    lfMode: snap.lfMode,
    sandbox: snap.sandbox,
    zoboGround: snap.zoboGround,
    pullRows: snap.pullRows,
    b1: snap.bench[1],
    b2: snap.bench[2],
    plan: snap.plan,
    llf: snap.lines.lf,
    lhave: snap.lines.have,
  };
  for (let i = 0; i < ALL_CELLS; i++) out[`c${i}`] = snap.cells[i] ?? null;
  return out;
}

/** The inverse, for handing back to store.applySnapshot(). */
function toSnapshot(f) {
  return {
    mode: f.mode,
    name: f.name,
    lfMode: f.lfMode,
    sandbox: f.sandbox,
    zoboGround: f.zoboGround,
    pullRows: f.pullRows,
    bench: { 1: f.b1 ?? [], 2: f.b2 ?? [] },
    plan: f.plan ?? [],
    lines: { lf: f.llf ?? { wants: [], note: '' }, have: f.lhave ?? { wants: [], note: '' } },
    cells: Array.from({ length: ALL_CELLS }, (_, i) => f[`c${i}`] ?? null),
  };
}

/**
 * Are two field values the same?
 *
 * Structural, and it has to be. This was `JSON.stringify(a) === JSON.stringify(b)`
 * — one line, obviously correct, and the cause of a permanent loop between every
 * pair of browsers in a room.
 *
 * `JSON.stringify` preserves insertion order, so `{slug, player}` and
 * `{player, slug}` serialise differently while being the same occupant. The two
 * orders are both real: a cell built by store.place() lists its keys in one
 * order and one rebuilt by apply() from a peer's patch lists them in the other,
 * and neither is wrong. The diff below then reported a change nobody had made,
 * broadcast it, and the peer receiving it did exactly the same in reply — a
 * cell and both LF lines bouncing back and forth about six times a second, for
 * as long as two people were in a room.
 *
 * It cost nothing visible on a still board, which is why it survived testing:
 * every re-render redrew the same picture. It showed up the moment somebody
 * hovered a Tatari, because a re-render rebuilds the roster and the card under
 * the pointer stops being the element that was being hovered — so the highlight
 * blinked several times a second.
 *
 * A false "these differ" is therefore not the cheap mistake it looks like. It
 * costs a message, and the message costs a reply.
 *
 * Cycles are not a concern: everything here came out of snapshot(), which is a
 * deep copy of plain data.
 */
function same(a, b) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === y) return true;
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (Array.isArray(x)) {
    return x.length === y.length && x.every((v, i) => same(v, y[i]));
  }
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every((k) => Object.hasOwn(y, k) && same(x[k], y[k]));
}

/** Does an incoming write beat what we hold? See the ordering note up top. */
function beats(key, stamp) {
  if (!Array.isArray(stamp)) return false;
  const mine = version.get(key);
  if (!mine) return true;
  return stamp[0] > mine[0] || (stamp[0] === mine[0] && String(stamp[1]) > String(mine[1]));
}

// ---------------------------------------------------------------- sync

/**
 * Everything that changed here since the last time we looked, sent to the room.
 *
 * Runs on every store change, which is every keystroke in the name field and
 * every step of a drag — so the diff has to be the cheap path, and it is: eight
 * comparisons plus 36 cells against values that are usually identical.
 *
 * Also the tail of applyRemote(). Applying somebody's edit runs reconcile(),
 * which can legitimately change more than arrived — dropping a plan step whose
 * Tatari just left the field, say — and that residue is a local edit like any
 * other. Letting it fall through here rather than suppressing it is what stops
 * two browsers disagreeing about a plan neither of them typed.
 */
function pushLocal() {
  if (!link || !fields) return;

  const next = flatten(store.snapshot());
  const patch = {};
  const stamps = {};

  for (const key of Object.keys(next)) {
    if (same(next[key], fields[key])) continue;
    const count = (version.get(key)?.[0] ?? 0) + 1;
    const stamp = [count, link.id];
    version.set(key, stamp);
    fields[key] = next[key];
    patch[key] = next[key];
    stamps[key] = stamp;
  }

  if (Object.keys(patch).length) link.send('edit', { patch, stamps });
}

/**
 * One peer's edit. Fields we hold a newer write for are dropped on the floor.
 *
 * `adopt` is the exception, and it exists for exactly one message: the board a
 * peer sends because we asked to be caught up. Comparing versions there is not
 * just unnecessary, it is wrong. A browser that has only this second joined
 * stamped every field `[0, itself]` on the way in, which ties with the room's
 * own `[0, …]` on anything nobody has touched yet — and a tie breaks on the peer
 * id, so whether a newcomer accepted the formation already on the board or
 * replaced it with their empty one came down to which random uuid sorted higher.
 * Half of all joins would have wiped the room.
 *
 * Nothing is lost by adopting. Somebody who joins with work in progress gets it
 * back from the Undo on the toast startSession() raises, which is a better
 * answer than a coin toss either way.
 */
function applyRemote({ patch, stamps, adopt = false }) {
  if (!fields || !patch) return;

  let took = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in fields)) continue;
    if (!adopt && !beats(key, stamps?.[key])) continue;
    if (Array.isArray(stamps?.[key])) version.set(key, stamps[key]);
    fields[key] = value;
    took++;
  }
  if (!took) return;

  /*
   * store.applySnapshot() is the only way in, deliberately: it runs the same
   * validation a shared link does, so a peer cannot put a Tatari this build has
   * never heard of onto the field, and reconcile() re-establishes every
   * invariant afterwards. A remote edit gets no more trust than a pasted URL.
   */
  applying = true;
  try {
    store.applySnapshot(toSnapshot(fields));
  } finally {
    applying = false;
  }
  showName();
  pushLocal();
}

/**
 * The name box, which renderAll() does not touch.
 *
 * Every other control redraws itself from the store, but the formation name is
 * an `<input>` the user owns — app.js writes it once at boot and again after a
 * load, and otherwise leaves it alone. A renamed formation therefore arrives
 * everywhere except the field it was typed into, so this is the one piece of
 * rendering a session has to do for itself.
 *
 * Never while it has focus. Somebody mid-word does not want the caret jumping
 * to the end because a teammate touched the same box, and the name they are
 * typing is the one that will win a moment later anyway.
 */
function showName() {
  const box = $('#formation-name');
  if (!box || box === document.activeElement) return;
  if (box.value !== store.formation.name) box.value = store.formation.name;
}

/** The whole board, for somebody who just walked in. */
function sendState(to) {
  link?.send('state', {
    to,
    fields,
    stamps: Object.fromEntries(version),
  });
}

/**
 * Answering a newcomer.
 *
 * Everyone in the room hears the hello, and one reply is enough — so the peer
 * whose id sorts first answers and the rest stay quiet. Any tie-break would do;
 * this one needs no coordination because every browser sorts the same list.
 */
function answerHello(from) {
  const here = [link.id, ...peers.keys()].filter((k) => k !== from).sort();
  if (here[0] === link.id) sendState(from);
}

// ---------------------------------------------------------------- cursors

/** A stable colour per peer, so the same person is the same colour to everyone. */
function hueOf(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function cursorLayer() {
  if (layer) return layer;
  layer = document.createElement('div');
  layer.className = 'cursors';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  return layer;
}

/**
 * Where to draw a peer who is on a given square.
 *
 * The centre of the cell, nudged by a fixed amount per peer. Without the nudge
 * two people pointing at the same square sit exactly on top of each other and
 * the room looks like it has one fewer person in it. The offset comes from the
 * same hash as the colour, so it is stable — a peer does not wander around
 * inside a square between updates.
 */
function cellSpot(cell, key) {
  const el = cellElement(cell);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const n = hueOf(key);
  return {
    x: r.left + r.width / 2 + (((n % 5) - 2) * r.width * 0.13),
    y: r.top + r.height / 2 + ((((n / 5) | 0) % 5 - 2) * r.height * 0.13),
  };
}

function drawCursor(key, at) {
  const cell = Number.isInteger(at?.cell) ? at.cell : null;
  if (cell === null) return;
  const spot = cellSpot(cell, key);
  if (!spot) return;

  let entry = cursors.get(key);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'cursor';
    el.style.setProperty('--hue', String(hueOf(key)));
    el.innerHTML = '<svg viewBox="0 0 12 18" aria-hidden="true">'
      + '<path d="M1 1l10 7-4.5 1.2L9 15l-2.2 1-2.4-5L1 14z"/></svg>'
      + '<span class="cursor__name"></span>';
    cursorLayer().append(el);
    entry = { el, cell: null, seen: 0 };
    cursors.set(key, entry);
  }

  entry.el.querySelector('.cursor__name').textContent = peers.get(key)?.name || 'Guest';
  entry.el.style.transform = `translate(${spot.x}px, ${spot.y}px)`;
  entry.el.hidden = false;
  entry.seen = performance.now();

  // The square itself is marked as well as pointed at. renderGrid() only ever
  // toggles its own classes, so this one survives a re-render — and it has to be
  // a class rather than a child, because a re-render rewrites the cell's
  // innerHTML.
  if (entry.cell !== cell) {
    if (entry.cell !== null) cellElement(entry.cell)?.classList.remove('is-peer-over');
    cellElement(cell)?.classList.add('is-peer-over');
    entry.cell = cell;
  }
}

function dropCursor(key) {
  const entry = cursors.get(key);
  if (!entry) return;
  if (entry.cell !== null) cellElement(entry.cell)?.classList.remove('is-peer-over');
  entry.el.remove();
  cursors.delete(key);
}

/**
 * Pointers that stopped arriving — a closed laptop rather than a clean leave,
 * which presence would have told us about. The peer is left in the room and in
 * the strip; it is only their pointer that is no longer worth believing, so the
 * square it was over has to stop being highlighted too.
 */
function reapCursors() {
  const now = performance.now();
  for (const [, entry] of cursors) {
    if (entry.el.hidden || now - entry.seen <= CURSOR_IDLE_MS) continue;
    entry.el.hidden = true;
    if (entry.cell !== null) {
      cellElement(entry.cell)?.classList.remove('is-peer-over');
      entry.cell = null;
    }
  }
}

/**
 * Redraws every pointer where it now belongs. Scrolling and resizing move the
 * squares under the peers standing on them; the square each one is on has not
 * changed, only where that square is on screen.
 */
let lastAt = new Map();
function replaceCursors() {
  for (const [key, at] of lastAt) if (cursors.has(key)) drawCursor(key, at);
}

/**
 * Telling the room which square you are on.
 *
 * This used to be a stream: the pointer's position as a fraction of the field,
 * fifteen times a second for as long as the hand was moving. It was smooth and
 * it was far too expensive — about ten thousand messages for a twenty-minute
 * session between two people, which is roughly a hundred and eighty sessions
 * against the free tier's two million a month. A feature that breaks when it
 * becomes popular is the wrong shape of feature.
 *
 * It is an event now: one message when the square under your pointer changes,
 * and nothing at all while it sits still or wanders around the roster. On a
 * six-by-six board that is a handful of messages a second at worst and none most
 * of the time — an order of magnitude cheaper, and no less informative, because
 * "which square are you pointing at" was always the whole content of the signal.
 * The pixels between squares were never worth sending.
 *
 * It also deletes a problem rather than solving it: a cell number means the same
 * thing on a phone and on a desktop, so there is nothing left to normalise
 * against a window somebody else is looking at.
 */
function watchPointer() {
  let onCell = null;             // the square we last told the room about
  let pending = null;            // a change waiting for the floor below to pass
  let sentAt = 0;
  let timer = null;

  const flush = () => {
    timer = null;
    if (!link || pending === null || pending === onCell) return;
    onCell = pending;
    pending = null;
    sentAt = performance.now();
    if (spentOnCursors >= CURSOR_BUDGET) return;
    spentOnCursors++;
    if (spentOnCursors === CURSOR_BUDGET) {
      // Said once, and only to the person who spent it.
      toast('Pointers are off for the rest of this session. Editing carries on.');
      link.send('cursor', { away: true });
      return;
    }
    link.send('cursor', { cell: onCell });
  };

  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, CURSOR_MS - (performance.now() - sentAt));
    timer = setTimeout(flush, wait);
  };

  window.addEventListener('pointermove', (e) => {
    if (!link) return;

    // Outside the field: say so once, rather than leaving a pointer parked on a
    // square nobody is looking at any more.
    if (!e.target?.closest?.('#grid')) {
      if (onCell !== null || pending !== null) {
        onCell = null;
        pending = null;
        clearTimeout(timer);
        timer = null;
        link.send('cursor', { away: true });
      }
      return;
    }

    // Inside the field but between two squares — the grid's own gap. Keep
    // whatever we last said rather than blinking off and on crossing a seam.
    const el = e.target.closest('.cell');
    if (!el) return;

    const cell = Number(el.dataset.cell);
    if (cell === onCell || cell === pending) return;
    pending = cell;
    schedule();
  }, { passive: true });

  setInterval(reapCursors, 2_000);
  addEventListener('scroll', replaceCursors, { passive: true });
  addEventListener('resize', replaceCursors, { passive: true });
}

// ---------------------------------------------------------------- room

function onMessage(event, payload, from) {
  if (event === 'edit') { applyRemote(payload); return; }

  if (event === 'hello') { answerHello(from); return; }

  if (event === 'state') {
    // Addressed to whoever asked; everybody else already has this.
    if (!link || payload?.to !== link.id) return;
    /*
     * Wholesale the first time, merged every time after. The first answer is
     * the room telling a newcomer what the board is, and there is nothing on
     * this side worth weighing it against. A later one is the answer to a
     * reconnect, where the counters have real history behind them and the edits
     * made while the socket was down are worth keeping — adopting there would
     * throw away work nobody had the chance to see.
     */
    applyRemote({ patch: payload.fields, stamps: payload.stamps, adopt: !caughtUp });
    caughtUp = true;
    return;
  }

  if (event === 'cursor') {
    if (payload?.away) { lastAt.delete(from); dropCursor(from); return; }
    lastAt.set(from, payload);
    drawCursor(from, payload);
    return;
  }

  // The room is moving and we are invited. Only the host sends this, and only
  // the peers named in `keep` follow it — see kick().
  if (event === 'migrate') {
    if (!link || !isRoom(payload?.to)) return;
    if (!Array.isArray(payload.keep) || !payload.keep.includes(link.id)) return;
    startSession(payload.to, { joining: true, quiet: true });
    return;
  }

  if (event === 'kicked') {
    if (!link || payload?.who !== link.id) return;
    endSession({ quiet: true });
    toast('You were removed from the session. Your formation is still here.', 'error');
    track('live-was-kicked');
  }
}

function onPeers(list) {
  peers = new Map(list.map((p) => [p.key, p]));
  if (enforceCap()) return;              // we stepped out of a room that was full
  for (const key of [...cursors.keys()]) if (!peers.has(key)) dropCursor(key);
  settleGuestName();
  renderPresence();
}

/**
 * Keeping a room to two people, without a server to keep it for us.
 *
 * Presence tells everyone who is here, so the room can police its own size the
 * same cooperative way kick() moves people: whoever arrives to find it already
 * full steps back out, and if two people race into the last seat at once the
 * excess is decided by the same id-sort the field versions use — arbitrary, but
 * identical on every browser, so nobody has to be asked.
 *
 * `committed` is the "I already fit" latch. Set the first time we see the room
 * with room to spare, it stops an established peer from ejecting itself the
 * moment a third person's presence arrives — that third person is the one whose
 * own check fails, not us.
 *
 * Like kick(), this keeps an honest guest out and a runaway room off the
 * Realtime bill; it is not a security boundary, because presence is whatever a
 * client says about itself and a modified one could lie. See the note on kick().
 *
 * @returns {boolean} true when it ended the session, so the caller stops.
 */
function enforceCap() {
  if (!link) return false;
  const others = [...peers.keys()].filter((k) => k !== link.id).length;

  if (!committed) {
    if (others >= MAX_PEERS) { leaveFull(); return true; }
    if (peers.size <= MAX_PEERS) {
      committed = true;
      // Now that we know we are staying, it is safe to say we joined — and to
      // offer back the board the join replaced.
      if (preJoin) announceJoined();
    }
  }

  // A simultaneous over-join: everyone ranks the same list and the ones past the
  // cap leave. The host is never one of them — it opened the room.
  if (committed && peers.size > MAX_PEERS && !hosting) {
    const keep = new Set([...peers.keys()].sort().slice(0, MAX_PEERS));
    if (!keep.has(link.id)) { leaveFull(); return true; }
  }
  return false;
}

function leaveFull() {
  const restore = preJoin;
  endSession({ quiet: true });            // clears preJoin
  if (restore) store.applySnapshot(restore);
  toast('That live session is full. It is limited to two people, and your formation is safe.', 'error');
  track('live-room-full');
}

/** The join announcement, held back until enforceCap() knows we are staying. */
function announceJoined() {
  toast('Joined a live session', 'ok', {
    label: 'Undo',
    fn: () => { if (preJoin) { store.applySnapshot(preJoin); toast('Put your formation back'); } },
  });
}

// ---------------------------------------------------------------- names

/**
 * Guest, Guest 2, Guest 3.
 *
 * Somebody who joins without typing a name still has to be somebody: "two people
 * editing" is useless when both of them are called nothing, and a cursor with no
 * label beside it is worse than one with a dull label. So a blank name is not an
 * absence, it is a request to be given one.
 *
 * The number is taken rather than assigned, because there is nobody to assign
 * it. Each browser looks at the names already in the room and claims the lowest
 * one free, which is stable as long as they do not look at the same instant —
 * and when they do, settleGuestName() below unpicks the tie.
 */
const guestLabel = (n) => (n === 1 ? 'Guest' : `Guest ${n}`);

function freeGuestName(taken) {
  for (let n = 1; ; n++) if (!taken.has(guestLabel(n))) return guestLabel(n);
}

/**
 * Keeps an unnamed guest's number honest as the room changes.
 *
 * Two people arriving together both see an empty room and both claim "Guest".
 * Presence tells them about each other a moment later, and the one whose peer id
 * sorts higher gives way — the same arbitrary-but-identical rule the field
 * versions use, so both browsers reach the same answer without asking.
 *
 * Only ever renames a guest. Somebody who typed a name keeps it, duplicate or
 * not: two players called Sam is their business, and quietly renaming one of
 * them to Sam 2 would be the tool overruling them.
 */
function settleGuestName() {
  if (!link || chosen) return;

  const others = [...peers.entries()].filter(([key]) => key !== link.id);
  const taken = new Set(
    others
      .filter(([key, p]) => p?.name && (!isGuestName(p.name) || String(key) < String(link.id)))
      .map(([, p]) => p.name)
  );

  const want = freeGuestName(taken);
  if (want === display) return;
  display = want;
  link.track({ name: display });
}

const isGuestName = (name) => /^Guest(?: \d+)?$/.test(String(name ?? ''));

/** What the room should call us: the typed name, or the guest number we hold. */
const myLabel = () => chosen || display;

/**
 * Opens a room and starts sharing.
 *
 * `room` is a fresh id when you start a session and the one off the link when
 * you join somebody's. The difference matters exactly once: joining hands your
 * board over to theirs a moment later, so the state you had is saved to a toast
 * you can press to get it back. Somebody clicking a link in Discord did not
 * intend to throw away what was on their screen.
 */
export function startSession(room = newRoom(), { joining = false, quiet = false } = {}) {
  if (!LIVE_ENABLED || !isConfigured()) {
    toast('Live sessions are switched off in this copy');
    return false;
  }
  if (!isRoom(room)) return false;
  if (link) endSession({ quiet: true });
  spentOnCursors = 0;
  committed = false;

  preJoin = joining && !quiet ? store.snapshot() : null;

  if (!joining) rememberHosted(room);
  hosting = hostedRooms().has(room);

  // Whoever opens a room is its starting truth and has nothing to catch up on.
  // Only somebody arriving on a link does.
  caughtUp = !joining;
  fields = flatten(store.snapshot());
  display = chosen ? '' : guestLabel(1);

  link = joinRoom({
    room,
    self: { name: myLabel(), host: hosting },
    onMessage,
    onPeers,
    onStatus: (up, why) => {
      /*
       * `why` means live.js has stopped trying. The commonest cause is the one
       * worth naming plainly: Realtime has a monthly allowance, and when it runs
       * out the room is refused until the month turns over. Everything else on
       * the site keeps working — the gallery is a different service and the
       * drafter needs no network at all — so the honest thing is to end the
       * session, say what is and is not affected, and leave the formation alone.
       */
      if (why) {
        endSession({ quiet: true });
        toast(why === 'refused'
          ? 'Live sessions are unavailable right now. Your formation is safe and everything else still works.'
          : 'Could not reach the live session. Your formation is safe.', 'error');
        track('live-unavailable');
        return;
      }
      document.body.classList.toggle('is-live-down', !up);
      renderPresence();
      // A reconnect may have missed edits, so ask for the board again rather
      // than trusting a diff against a state that moved on without us.
      if (up) link.send('hello', {});
    },
  });

  if (!link) { fields = null; return false; }

  /*
   * Every field starts stamped rather than unstamped, so `beats()` always has
   * two numbers to compare. The alternative — treating "no stamp" as "anything
   * wins" — collapses on the case that matters most: the first person to open a
   * room has edited nothing, so an unstamped state message would let their empty
   * board overwrite the formation somebody joined with.
   */
  version = new Map(Object.keys(fields).map((key) => [key, [0, link.id]]));

  unsubscribe = store.subscribe(() => { if (!applying) pushLocal(); });

  document.body.classList.add('is-live');
  history.replaceState(null, '', withRoom(location.href, room));
  paintDialog();

  // The "Joined" toast and its Undo wait until enforceCap() has confirmed the
  // room had space for us — a join that is about to be turned away should not
  // first announce itself or leave the other board in place. See announceJoined().
  if (!quiet) track(joining ? 'live-joined' : 'live-started');
  return true;
}

export function endSession({ quiet = false } = {}) {
  link?.close();
  link = null;
  fields = null;
  caughtUp = false;
  committed = false;
  preJoin = null;
  hosting = false;
  version = new Map();
  unsubscribe?.();
  unsubscribe = null;
  for (const key of [...cursors.keys()]) dropCursor(key);
  lastAt = new Map();
  peers = new Map();
  document.body.classList.remove('is-live', 'is-live-down');
  history.replaceState(null, '', withoutRoom(location.href));
  paintDialog();
  if (!quiet) { toast('Left the live session'); track('live-left'); }
}

/**
 * Removing somebody, by moving everybody else.
 *
 * A broadcast telling a peer to leave is a request, and a request is only worth
 * as much as the browser receiving it. So the kick does not rely on one: the
 * host opens a *new* room and privately tells everyone who is staying where it
 * is. The kicked peer is not on that list, so it is left holding a room id
 * nobody is in any more. That works without a server to appeal to, which is the
 * constraint this whole feature is built under.
 *
 * The board survives the move untouched — it lives in the store, and the new
 * room is seeded from it exactly as the first one was.
 *
 * Worth being straight about the limit: everyone hears the migrate message, so
 * somebody running a modified client could read the new room out of it and
 * follow. This keeps out a person, not an adversary. Genuinely sealing a room
 * needs the channel to be private and the membership checked by Supabase rather
 * than by the people in it.
 */
function kick(who) {
  if (!link || !hosting) return;

  const name = peers.get(who)?.name || 'They';
  const next = newRoom();
  const keep = [...peers.keys()].filter((key) => key !== who);

  link.send('migrate', { to: next, keep });
  link.send('kicked', { who });

  // A beat, so both messages are on the wire before this socket goes away.
  setTimeout(() => {
    rememberHosted(next);
    startSession(next, { quiet: true });
    toast(`${name} was removed from the session`);
  }, 250);
  track('live-kicked');
}

export const inSession = () => !!link;

// ---------------------------------------------------------------- ui

/**
 * The strip of who is here, in the topbar.
 *
 * Hidden outright when there is no session — this is the rule the whole feature
 * follows, that a drafter nobody shared is the drafter it always was.
 */
/** Everybody in the room, us first, with no duplicate for our own presence key. */
function roster() {
  const mine = { key: link.id, name: myLabel(), me: true, host: hosting };
  return [mine, ...peers.values()]
    .filter((p, i, list) => list.findIndex((o) => o.key === p.key) === i);
}

function renderPresence() {
  const strip = $('#live-who');
  if (!strip) return;

  if (!link) { strip.hidden = true; strip.innerHTML = ''; return; }

  const all = roster();
  strip.hidden = false;
  strip.innerHTML = all.map((p) => {
    const label = p.me ? `${p.name} (you)` : (p.name || 'Guest');
    const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
    return `<span class="who" style="--hue:${hueOf(p.key)}" title="${esc(label)}">${esc(initial)}</span>`;
  }).join('');

  const count = all.length;
  const label = $('#live-count');
  if (label) {
    label.textContent = count === 1
      ? 'Just you so far — send the link to somebody'
      : `${count} people editing`;
  }
  renderPeerList();
}

/**
 * The list inside the sheet, which is the only place a kick can be pressed.
 *
 * Deliberately not in the topbar strip. Removing somebody is rare, awkward and
 * irreversible from their side, and a control for it sitting permanently beside
 * their initial is an invitation to do it by accident.
 */
function renderPeerList() {
  const list = $('#live-peers');
  if (!list || !link) return;

  list.innerHTML = roster().map((p) => {
    const name = p.name || 'Guest';
    const tags = [p.me ? 'you' : '', p.host ? 'host' : ''].filter(Boolean).join(' · ');
    const canKick = hosting && !p.me;
    return `<li class="peer">
      <span class="who" style="--hue:${hueOf(p.key)}" aria-hidden="true">${esc(name.charAt(0).toUpperCase())}</span>
      <span class="peer__name">${esc(name)}${tags ? ` <span class="muted">${esc(tags)}</span>` : ''}</span>
      ${canKick ? `<button class="btn btn--tiny btn--quiet" type="button" data-kick="${esc(p.key)}">Remove</button>` : ''}
    </li>`;
  }).join('');
}

/**
 * Puts the sheet into the state the session is actually in.
 *
 * Module-level rather than tucked inside buildSession, because a session can end
 * without anybody pressing anything in here — a host can remove you, and a room
 * can be refused. When that happened while the sheet was open it went on showing
 * the connected panel, complete with a session link to a room nobody was in.
 */
function paintDialog() {
  const dlg = $('#dlg-live');
  if (!dlg) return;
  dlg.dataset.state = link ? 'on' : (invited ? 'ask' : 'off');
  // startSession() has already stamped the room into the address bar, so the
  // link to hand out is simply where we are.
  if (link) $('#live-link').value = location.href;
  for (const sel of ['#live-name', '#live-ask-name', '#live-name-on']) {
    const box = $(sel);
    if (box && box.value !== chosen) box.value = chosen;
  }
  renderPresence();
}

export function buildSession() {
  const dlg = $('#dlg-live');
  if (!dlg) return;

  /*
   * Switched off, or a fork with no project behind it: take the button away
   * rather than leaving one that explains itself only after being pressed. A
   * link with a room in it also does nothing, which is the right answer — there
   * is nothing on the other end of it here.
   */
  if (!LIVE_ENABLED || !isConfigured()) {
    const btn = $('#btn-live');
    if (btn) btn.hidden = true;
    return;
  }

  /*
   * Three name boxes, one per panel, because a single input cannot be in three
   * places and each panel has to read as a whole thought on its own. They all
   * write the same value, and paintDialog() puts that value back into all of
   * them, so whichever one you last typed in is the one every panel shows.
   */
  const nameBoxes = () => ['#live-name', '#live-ask-name', '#live-name-on']
    .map((sel) => $(sel)).filter(Boolean);

  const paint = paintDialog;

  /** Both name boxes write the same thing; only one of them is ever on screen. */
  const setName = (raw) => {
    chosen = String(raw ?? '').slice(0, 24).trim();
    try { localStorage.setItem(NAME_KEY, chosen); } catch { /* private mode */ }
    if (link) {
      // Giving a name up puts us back in the guest numbering, which needs the
      // room's current names to pick from — settleGuestName does that on the
      // next presence tick, so this only has to stop claiming the old one.
      display = chosen ? '' : guestLabel(1);
      link.track({ name: myLabel(), host: hosting });
      settleGuestName();
      renderPresence();
    }
  };

  $('#btn-live').addEventListener('click', () => { paint(); dlg.showModal(); });

  $('#live-start').addEventListener('click', () => {
    setName($('#live-name').value);
    if (startSession()) paint();
  });

  // Arriving on somebody's link: the name is asked for before the socket opens,
  // so nobody ever appears in the room as an unnamed nobody and then changes.
  $('#live-join').addEventListener('click', () => {
    setName($('#live-ask-name').value);
    const room = invited;
    invited = null;
    startSession(room, { joining: true });
    paint();
    // Join means "put me on the board", not "show me a panel about it". The
    // host keeps the sheet open because they still need the link out of it;
    // somebody arriving has already used theirs.
    dlg.close();
  });

  $('#live-decline').addEventListener('click', () => {
    invited = null;
    history.replaceState(null, '', withoutRoom(location.href));
    paint();
    dlg.close();
  });

  $('#live-copy').addEventListener('click', async () => {
    const ok = await copyText($('#live-link').value);
    toast(ok ? 'Live link copied' : 'Could not copy the link', ok ? 'ok' : 'error');
    if (ok) track('live-link-copied');
  });

  $('#live-leave').addEventListener('click', () => { endSession(); paint(); });

  // `change`, not `input`: presence is rate-limited to five calls per thirty
  // seconds, and a track() per keystroke would spend that budget on the word
  // "Jeremy" and then go quiet for half a minute.
  for (const box of nameBoxes()) {
    box.addEventListener('change', (e) => { setName(e.target.value); paint(); });
  }

  $('#live-peers').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kick]');
    if (btn) kick(btn.dataset.kick);
  });

  dismissOnBackdrop(dlg);

  watchPointer();

  /*
   * A link with a room in it asks before it joins.
   *
   * It used to connect on arrival, which read as the page deciding on your
   * behalf that you were now in a room with somebody. Asking costs one press and
   * buys two things: a name to put on your cursor, and a moment to notice that
   * the formation on screen is about to become somebody else's.
   */
  invited = roomInHash(location.hash);
  if (invited) { paint(); dlg.showModal(); }
}
