/**
 * The Realtime transport: one socket, one room.
 *
 * This is the only file in the project that opens a WebSocket, and it holds
 * nothing about formations — it moves opaque messages and reports who is in the
 * room. What those messages mean is session.js's problem. The split is worth the
 * extra file: the protocol below is fiddly and has nothing to do with Horde, and
 * the sync rules are subtle and have nothing to do with Phoenix.
 *
 * ## Why this is hand-written
 *
 * Realtime is normally reached through `@supabase/realtime-js`. Pulling it in
 * would give this project its first runtime dependency and would have to be
 * vendored to keep a clone working offline — the same objection supabase.js
 * raises against the REST client, and the same answer: the wire format is
 * documented JSON over a socket the browser already has.
 *
 * ## The protocol, in one place
 *
 * Realtime speaks Phoenix channels. With `vsn=2.0.0` every frame is an array,
 * `[join_ref, ref, topic, event, payload]`, which is what the constants and the
 * `frame()` helper below assemble. Four things have to happen and keep
 * happening:
 *
 *   1. Connect to `wss://<ref>.supabase.co/realtime/v1/websocket?apikey=…`.
 *   2. `phx_join` on `realtime:<room>`, carrying the feature config. Nothing is
 *      delivered before the server answers that join with `phx_reply` ok.
 *   3. A `heartbeat` on the `phoenix` topic every 25 seconds, forever. Miss two
 *      and the server closes the socket.
 *   4. Re-do all of the above when it closes anyway, which on a laptop that has
 *      been shut and reopened is every time.
 *
 * ## Presence is not for cursors
 *
 * Realtime rate-limits presence to five calls per client per thirty seconds, on
 * every plan including paid ones. That is one update every six seconds, so
 * presence answers "who is here" and cannot answer "where is their pointer".
 * Pointers ride on broadcast instead, which gets 100 messages a second on the
 * free tier — comfortable for a handful of people at the ~15Hz session.js sends,
 * and the reason it throttles rather than sending on every pointermove.
 *
 * ## Failure is not an error state
 *
 * Same contract as supabase.js. A room that cannot be reached calls `onDown`
 * and the drafter carries on as a drafter; nothing here throws into a caller and
 * nothing here shows the user anything. Losing the connection costs you the
 * other person, not your formation, because every edit has already been applied
 * locally and written to localStorage before it was ever sent.
 */

import { CONFIG, isConfigured } from './supabase.js';

/** Phoenix wants a distinct topic namespace; Realtime's is `realtime:`. */
const TOPIC = (room) => `realtime:${room}`;

/**
 * 25 seconds. The server's tolerance is 60 and it counts from the last frame of
 * any kind, so this is two missed beats of headroom on a quiet room.
 */
const HEARTBEAT_MS = 25_000;

/**
 * Reconnect backoff, in milliseconds, then every 10s after the last. A room is
 * two people on a voice call noticing the other one froze, so the first few
 * retries are fast; the tail is slow enough not to hammer a project that is
 * genuinely down.
 */
const BACKOFF = [500, 1000, 2000, 5000, 10_000];

/**
 * How many times to try a room we have never once been inside.
 *
 * A session that drops after working is worth chasing indefinitely — that is a
 * tunnel, a sleeping laptop, a train. A room that will not let us in on the
 * first attempt is a different thing, and retrying it forever only produces a
 * page that claims to be connecting for the rest of the afternoon.
 */
const COLD_ATTEMPTS = 4;

/**
 * A room id, for the address bar.
 *
 * 16 characters of crypto-grade base32 — about 80 bits. This is the whole of
 * the access control: anyone holding it can join and edit, which is exactly the
 * "anyone with the link" bargain the feature is offering, and the reason the id
 * has to be unguessable rather than merely unique. A counter or a timestamp
 * would let somebody walk into a stranger's session.
 *
 * No `l`, `1`, `0` or `o`: these get read aloud over voice chat.
 */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function newRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Room ids only ever come from newRoom(), so anything else is not one. */
export const isRoom = (id) => typeof id === 'string' && /^[a-z2-9]{16}$/.test(id);

/**
 * Opens a room and keeps it open.
 *
 * @param {object} opts
 * @param {string} opts.room            the id from newRoom(), or off a link
 * @param {object} opts.self            what to tell the room about you — see track()
 * @param {(event: string, payload: object, from: string) => void} opts.onMessage
 * @param {(peers: object[]) => void} opts.onPeers   everyone here, you included
 * @param {(up: boolean, why?: 'refused'|'unreachable') => void} opts.onStatus
 *   connected, or not. A `why` means it has stopped trying and the room is not
 *   coming back on its own — the caller should end the session and say so.
 * @returns {{send: Function, track: Function, close: Function, id: string}|null}
 *   null when there is no project configured to connect to.
 */
export function joinRoom({ room, self, onMessage, onPeers, onStatus }) {
  if (!isConfigured() || !isRoom(room)) return null;

  /*
   * Who this browser is, for the length of the session. Presence keys the room
   * by it and every broadcast carries it, which is what lets a peer ignore its
   * own echo and lets a cursor be attributed to a face.
   *
   * Deliberately not the Discord account id. A room is joinable without signing
   * in — that is the point of a link — so identity here is per-tab and means
   * nothing beyond it. Two tabs on one machine are two peers, correctly.
   */
  const id = crypto.randomUUID();

  let socket = null;
  let joined = false;          // the server has answered phx_join with ok
  let everJoined = false;      // ...at least once, ever. See COLD_ATTEMPTS.
  let closed = false;          // close() was called; stop trying
  let attempt = 0;
  let beat = null;
  let retry = null;
  let ref = 0;
  const joinRef = '1';
  let meta = { ...self };
  let peers = new Map();       // presence key -> meta

  const nextRef = () => String(++ref);
  const live = () => socket?.readyState === WebSocket.OPEN;

  const frame = (event, payload, topic = TOPIC(room)) =>
    JSON.stringify([joinRef, nextRef(), topic, event, payload]);

  const push = (event, payload, topic) => {
    if (!live()) return false;
    try {
      socket.send(frame(event, payload, topic));
      return true;
    } catch {
      // A socket can be OPEN and still refuse a frame while it is tearing down.
      // The reconnect below is already on its way; nothing to report here.
      return false;
    }
  };

  // -------------------------------------------------------------- presence

  /*
   * presence_state arrives once, on join, and holds everyone already here.
   * presence_diff arrives on every arrival and departure and holds only the
   * change. Both shapes nest the useful part under `metas`, an array because
   * Phoenix allows one key to be present from several sockets at once; this
   * project has no use for that, so it reads the first and moves on.
   */
  const metaOf = (entry) => entry?.metas?.[0] ?? null;

  const announce = () => onPeers?.([...peers.entries()].map(([key, m]) => ({ ...m, key })));

  function presenceState(payload) {
    peers = new Map();
    for (const [key, entry] of Object.entries(payload ?? {})) {
      const m = metaOf(entry);
      if (m) peers.set(key, m);
    }
    announce();
  }

  function presenceDiff(payload) {
    for (const key of Object.keys(payload?.leaves ?? {})) peers.delete(key);
    for (const [key, entry] of Object.entries(payload?.joins ?? {})) {
      const m = metaOf(entry);
      if (m) peers.set(key, m);
    }
    announce();
  }

  // -------------------------------------------------------------- socket

  function open() {
    if (closed) return;

    const url = `${CONFIG.url.replace(/^http/, 'ws')}/realtime/v1/websocket`
      + `?apikey=${encodeURIComponent(CONFIG.anonKey)}&vsn=2.0.0`;

    try {
      socket = new WebSocket(url);
    } catch {
      schedule();
      return;
    }

    socket.addEventListener('open', () => {
      /*
       * `self: false` — the server does not echo a broadcast back to whoever
       * sent it. session.js relies on this: it applies its own edits locally the
       * instant they happen, so an echo would be a second application of a
       * change it has already made, and with per-cell versioning that is not
       * harmless. It would look like a peer overwriting you with your own move.
       *
       * `private: false` — the room is reachable with the anon key alone. There
       * is no RLS to satisfy because there is no table: broadcast messages are
       * never persisted, so the id in the link is the only thing standing
       * between a session and a stranger, and that is by design.
       */
      push('phx_join', {
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: id, enabled: true },
          postgres_changes: [],
          private: false,
        },
      });

      beat = setInterval(() => {
        // join_ref is null on the phoenix topic — it belongs to no channel.
        if (live()) socket.send(JSON.stringify([null, nextRef(), 'phoenix', 'heartbeat', {}]));
      }, HEARTBEAT_MS);
    });

    socket.addEventListener('message', (e) => {
      let parsed;
      try { parsed = JSON.parse(e.data); } catch { return; }
      if (!Array.isArray(parsed)) return;
      const [, , topic, event, payload] = parsed;

      if (event === 'phx_reply') {
        // The join is the only reply worth acting on. Everything else this
        // module sends is fire-and-forget, and `ack: false` means most of it
        // is not replied to at all.
        if (topic !== TOPIC(room) || joined) return;
        if (payload?.status === 'ok') {
          joined = true;
          everJoined = true;
          attempt = 0;
          onStatus?.(true);
          // Presence has to be re-tracked after every reconnect: the server
          // dropped this key when the old socket died.
          push('presence', { type: 'presence', event: 'track', payload: meta });
        } else {
          /*
           * The server answered the join with a refusal rather than dropping the
           * connection. That is a policy answer — a spent quota, a paused
           * project, a key that is no longer valid — and none of those get
           * better by asking again in half a second.
           *
           * It used to be ignored, which was the worst of both: the socket
           * stayed open and heartbeating, `joined` never became true, and so
           * neither branch of onStatus ever fired. The page went on showing a
           * connected session that had never existed.
           */
          giveUp('refused');
        }
        return;
      }

      if (event === 'presence_state') { presenceState(payload); return; }
      if (event === 'presence_diff') { presenceDiff(payload); return; }

      if (event === 'broadcast') {
        const from = payload?.payload?.from;
        // Belt and braces against `self: false` — a message with no sender, or
        // one claiming to be us, is not something session.js should act on.
        if (!from || from === id) return;
        onMessage?.(payload.event, payload.payload, from);
      }
    });

    const down = () => {
      clearInterval(beat);
      beat = null;
      if (joined) onStatus?.(false);
      joined = false;
      schedule();
    };

    socket.addEventListener('close', down);
    // An error is always followed by a close, so this only stops the page from
    // logging an unhandled one.
    socket.addEventListener('error', () => {});
  }

  /**
   * Stop, for a reason that will not improve on its own, and say which.
   *
   * Distinct from close(): close() is somebody leaving, this is the room being
   * unavailable. `why` reaches session.js through onStatus so it can say
   * something true rather than spinning.
   */
  function giveUp(why) {
    closed = true;
    clearInterval(beat);
    clearTimeout(retry);
    beat = null;
    retry = null;
    try { socket?.close(); } catch { /* already gone */ }
    socket = null;
    joined = false;
    onStatus?.(false, why);
  }

  function schedule() {
    if (closed || retry) return;
    // Never got in at all: stop asking, rather than leaving a page that says it
    // is connecting until somebody reloads it.
    if (!everJoined && attempt >= COLD_ATTEMPTS) { giveUp('unreachable'); return; }
    const wait = BACKOFF[Math.min(attempt++, BACKOFF.length - 1)];
    retry = setTimeout(() => { retry = null; open(); }, wait);
  }

  open();

  return {
    id,

    /**
     * One broadcast to the room. Silently dropped while the socket is down,
     * which is the right call for this feature: every message it carries is a
     * fresh snapshot of some part of the state, so a lost one is superseded by
     * the next rather than leaving a hole. Nothing here is a delta that has to
     * arrive to make sense of the one after it.
     */
    send(event, payload) {
      return push('broadcast', {
        type: 'broadcast',
        event,
        payload: { ...payload, from: id },
      });
    },

    /**
     * Change what the room knows about you — your name, your colour, which
     * player tab you are on. Rate-limited to five calls per thirty seconds by
     * the server, so callers must treat this as "my identity changed", never as
     * "something happened".
     */
    track(next) {
      meta = { ...meta, ...next };
      push('presence', { type: 'presence', event: 'track', payload: meta });
    },

    close() {
      closed = true;
      clearInterval(beat);
      clearTimeout(retry);
      beat = null;
      retry = null;
      try { socket?.close(); } catch { /* already gone */ }
      socket = null;
      joined = false;
    },
  };
}
