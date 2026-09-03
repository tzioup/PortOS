/**
 * Beeper realtime transport (#33, decided on #12).
 *
 * One long-lived WebSocket from the PortOS server to Beeper Desktop's local
 * `/v1/ws`. The browser cannot hold this connection itself — Beeper binds to
 * loopback with CORS locked to the machine, and a browser cannot set an
 * `Authorization` header on `new WebSocket()` — so the server owns the socket
 * and relays over Socket.IO (`socket.js`, the `beeper` subscriber set).
 *
 * **The `ws` package, not Node's built-in WHATWG `WebSocket`.** A live 105-second
 * probe (#12) recorded a protocol-level server ping at 10.5s and then every 30s,
 * which the research note said did not exist. That ping is the only liveness
 * signal Beeper offers, and the built-in WebSocket does not surface ping frames
 * to application code at all — which is why `moltworldWs.js` cannot be copied
 * here, only imitated. Its reconnect shape is still the model.
 *
 * **This socket is not the source of truth.** Delivery is at-most-once with no
 * replay on reconnect, `seq` is per connection, an event is silently skipped
 * when the message is not yet retrievable, and the window before
 * `subscriptions.updated` is dark. Correctness comes from #32's HTTP sweep; the
 * socket only makes ingestion prompt, and asks the sweep to run early on the
 * three occasions frames could have been lost:
 *   - a reconnect (anything during the outage is gone),
 *   - a `seq` gap (frames dropped while the socket still looked healthy),
 *   - a recovery from an actionable `app.state` (the install was broken).
 *
 * **Never gated on `app.state`.** The probe measured it reporting `initializing`
 * for 105 continuous seconds while nine accounts were connected and a chat page
 * returned in 230ms. It is a display input for the settings card, never a gate.
 *
 * Everything below runs OUTSIDE the Express request lifecycle — socket callbacks
 * and timers — so hook bodies catch and log rather than letting a throw take the
 * process down, per root AGENTS.md.
 */

import WebSocket from 'ws';
import { beeperSocketEvents } from './beeperSocketEvents.js';
import { DEFAULT_BASE_URL, resolveBeeperConfig } from './beeperClient.js';
import { isBeeperIngestionArmed, runBeeperSweep } from './beeperSync.js';

const LOG_PREFIX = '🫧 Beeper socket';

// 2.5 missed server pings. Tight enough that the liveness dot cannot lie for
// long, loose enough to survive one late ping (#12 decision 5).
export const SILENCE_TIMEOUT_MS = 75_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// The four domain events, all with the same flat frame: `type`, `seq`, `ts`,
// `chatID`, `ids` required, `entries` OPTIONAL on every one of them (not only
// on deletes, as the research note recorded). `entries` is deliberately never
// read — see `toInvalidation` below.
const DOMAIN_EVENT_TYPES = new Set(['chat.upserted', 'chat.deleted', 'message.upserted', 'message.deleted']);

// The `app.state` values that mean a human has to do something. `initializing`
// and `needs-first-sync` are explicitly NOT in this set: the probe caught
// `initializing` lying for the whole session on a working install.
const ACTIONABLE_APP_STATES = new Set([
  'needs-login', 'needs-cross-signing-setup', 'needs-verification', 'needs-secrets',
]);

const DEFAULT_RUNTIME = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  random: () => Math.random(),
  createSocket: (url, options) => new WebSocket(url, options),
});

let runtime = { ...DEFAULT_RUNTIME };
let socket = null;
let watchdogTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectionCount = 0;
let running = false;
let connectionState = 'down';
let lastEventAt = null;
let lastPingAt = null;
let lastSeq = null;
let appState = null;
let requestCounter = 0;

/**
 * `http://127.0.0.1:23373` → `ws://127.0.0.1:23373/v1/ws`. Exported for the
 * test; the path is not in Beeper's OpenAPI document, so it is hardcoded here
 * rather than discovered.
 */
export function beeperWebSocketUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return `${trimmed.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://')}/v1/ws`;
}

/**
 * The transport liveness snapshot. Three states, matching what the settings
 * card renders: `connected`, `reconnecting` (down but trying), `down` (not
 * armed, or deliberately stopped).
 */
export function getBeeperRealtimeState() {
  return {
    state: connectionState,
    lastEventAt: lastEventAt === null ? null : new Date(lastEventAt).toISOString(),
    lastPingAt: lastPingAt === null ? null : new Date(lastPingAt).toISOString(),
    reconnectAttempts,
    appState,
    // The card's actionable-fault line: an `app.state` a human must act on.
    // Never `initializing`, which the probe proved is not evidence of anything.
    appStateActionable: appState !== null && ACTIONABLE_APP_STATES.has(appState),
  };
}

function emitState() {
  beeperSocketEvents.emit('state', getBeeperRealtimeState());
}

function setConnectionState(next) {
  if (connectionState === next) return;
  connectionState = next;
  console.log(`${LOG_PREFIX}: ${next}`);
  emitState();
}

function clearWatchdog() {
  if (watchdogTimer !== null) {
    runtime.clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    runtime.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Re-arm the silence watchdog. Called from the connection attempt (so a
 * half-open TCP handshake trips too) and from every inbound signal — a ping
 * frame, a pong, or any message. `ws` auto-replies to a ping, so counting it as
 * liveness is exactly the measured heartbeat and needs no keepalive of our own.
 */
function armWatchdog() {
  clearWatchdog();
  watchdogTimer = runtime.setTimeout(() => {
    watchdogTimer = null;
    console.warn(`${LOG_PREFIX}: silent for ${SILENCE_TIMEOUT_MS / 1000}s — tearing down and reconnecting`);
    dropSocket();
    scheduleReconnect();
  }, SILENCE_TIMEOUT_MS);
  if (typeof watchdogTimer?.unref === 'function') watchdogTimer.unref();
}

function noteFrame() {
  lastEventAt = runtime.now();
  armWatchdog();
}

/**
 * Ask #32's watermark-bounded sweep to run now. Fire-and-forget with its own
 * catch: this is a timer/socket callback, so an unhandled rejection here would
 * be an unhandled rejection in the process, not a 500.
 */
function triggerSweep(reason) {
  console.log(`${LOG_PREFIX}: requesting a sweep (${reason})`);
  Promise.resolve()
    .then(() => runBeeperSweep({ reason }))
    .catch((err) => console.error(`${LOG_PREFIX}: sweep (${reason}) failed: ${err?.message ?? err}`));
}

/**
 * Jittered exponential backoff: the delay lands in the top half of the
 * exponential window, so a fleet of retries cannot align on the same instant
 * and a single dead Beeper Desktop is not hammered at a fixed cadence.
 */
function nextReconnectDelayMs() {
  const capped = Math.min(BASE_RECONNECT_DELAY_MS * (2 ** reconnectAttempts), MAX_RECONNECT_DELAY_MS);
  return Math.round((capped / 2) + (runtime.random() * (capped / 2)));
}

function scheduleReconnect() {
  if (!running) return;
  clearReconnectTimer();
  const delay = nextReconnectDelayMs();
  reconnectAttempts += 1;
  setConnectionState('reconnecting');
  console.log(`${LOG_PREFIX}: reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  reconnectTimer = runtime.setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => console.error(`${LOG_PREFIX}: reconnect failed: ${err?.message ?? err}`));
  }, delay);
  if (typeof reconnectTimer?.unref === 'function') reconnectTimer.unref();
}

function dropSocket() {
  clearWatchdog();
  const dying = socket;
  socket = null;
  if (!dying) return;
  dying.removeAllListeners?.();
  // `terminate()` is the `ws` escape hatch for a socket that may be half-open —
  // `close()` waits for a close handshake the dead peer will never send.
  if (typeof dying.terminate === 'function') dying.terminate();
  else dying.close?.();
}

// ---------------------------------------------------------------------------
// Frame handling
// ---------------------------------------------------------------------------

function toIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The invalidation frame the browser gets — ids and kinds ONLY (#12 decision 3).
 *
 * Fields are picked EXPLICITLY, never spread: a Beeper domain frame may carry a
 * hydrated `entries` array with full message text, sender display names and
 * network handles, and none of that may leave this machine. The browser refetches
 * from the PortOS mirror instead, which also keeps "displayed" implying
 * "persisted" — a payload relay can render a message the mirror never committed.
 *
 * `ids` are message ids for `message.*` and chat ids for `chat.*`, matching the
 * frame's own shape.
 */
export function toInvalidation(frame) {
  return {
    kind: frame?.type ?? null,
    chatID: typeof frame?.chatID === 'string' ? frame.chatID : null,
    ids: Array.isArray(frame?.ids) ? frame.ids.filter((id) => typeof id === 'string') : [],
    seq: Number.isFinite(frame?.seq) ? frame.seq : null,
    ts: toIsoTimestamp(frame?.ts),
  };
}

/**
 * `seq` is a per-connection counter that spans every event type (the probe saw
 * `app.state.updated` arrive as `seq: 1`), so a jump means frames were dropped
 * while the socket still looked perfectly healthy — the one loss mode a
 * reconnect-triggered sweep would never notice.
 */
function checkSequence(frame) {
  if (!Number.isFinite(frame?.seq)) return;
  const seq = frame.seq;
  if (lastSeq !== null && seq > lastSeq + 1) {
    console.warn(`${LOG_PREFIX}: seq gap (${lastSeq} → ${seq}) — frames were dropped`);
    triggerSweep('socket-seq-gap');
  }
  lastSeq = seq;
}

function handleAppState(frame) {
  const next = typeof frame?.appState?.state === 'string' ? frame.appState.state : null;
  if (next === null || next === appState) return;
  const wasActionable = appState !== null && ACTIONABLE_APP_STATES.has(appState);
  appState = next;
  emitState();
  // A recovery FROM an actionable state means the install was broken and is now
  // working — whatever arrived while it was broken was never delivered here.
  if (wasActionable && !ACTIONABLE_APP_STATES.has(next)) triggerSweep('socket-app-state-recovery');
}

function sendSubscription(target) {
  requestCounter += 1;
  // `["*"]` plus app state, never a scoped chat set: `subscriptions.set`
  // replaces state wholesale and the window during a re-`set` is dark, so
  // re-subscribing on every conversation change would manufacture a loss window
  // on exactly the event you most want to catch — a brand new conversation.
  target.send(JSON.stringify({
    type: 'subscriptions.set',
    requestID: `portos-${requestCounter}`,
    chatIDs: ['*'],
    app: { state: true },
  }));
}

function handleFrame(raw, target) {
  // External data from a local daemon — a parse guard is justified here (this
  // runs in a socket callback, outside any Express error middleware).
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    console.error(`${LOG_PREFIX}: unparseable frame discarded`);
    return;
  }
  if (!frame || typeof frame !== 'object') return;

  checkSequence(frame);

  if (frame.type === 'ready') {
    sendSubscription(target);
    return;
  }
  if (frame.type === 'subscriptions.updated') {
    setConnectionState('connected');
    // The first connection of a process is not a reconnect: boot arms the
    // transport, it does not fire a sweep (`type: 'interval'` in #32's
    // scheduler makes the same choice for the same reason).
    if (connectionCount > 1) triggerSweep('socket-reconnect');
    return;
  }
  if (frame.type === 'error') {
    // The code only. A Beeper `error` frame carries a free-text `message` that
    // is not ours to log.
    console.error(`${LOG_PREFIX}: protocol error (${frame.code || 'unknown'})`);
    return;
  }
  if (frame.type === 'app.state.updated') {
    handleAppState(frame);
    return;
  }
  if (DOMAIN_EVENT_TYPES.has(frame.type)) {
    beeperSocketEvents.emit('invalidate', toInvalidation(frame));
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

async function connect() {
  if (!running || socket) return;
  const { baseUrl, token } = await resolveBeeperConfig();
  if (!token) {
    // The token went away mid-session (revoked, vault cleared). Stop rather
    // than loop against a socket that can only ever answer 401.
    console.warn(`${LOG_PREFIX}: no token configured — standing down`);
    stopBeeperSocket();
    return;
  }

  connectionCount += 1;
  lastSeq = null;
  if (connectionState !== 'reconnecting') setConnectionState('reconnecting');
  // Armed before the handshake so a half-open connect trips the watchdog too.
  armWatchdog();

  // The token rides the upgrade request's `Authorization` header and is never
  // logged, never placed in the URL, and never emitted to a browser.
  const instance = runtime.createSocket(beeperWebSocketUrl(baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket = instance;

  const guard = (label, handler) => (...args) => {
    if (socket !== instance) return; // a superseded socket must not drive state
    try {
      handler(...args);
    } catch (err) {
      console.error(`${LOG_PREFIX}: ${label} handler failed: ${err?.message ?? err}`);
    }
  };

  instance.on('open', guard('open', () => {
    reconnectAttempts = 0;
    noteFrame();
  }));
  // `ws` exposes the protocol ping the built-in WebSocket hides, and auto-replies
  // pong. Measured cadence: 10.5s after open, then every 30s.
  instance.on('ping', guard('ping', () => {
    lastPingAt = runtime.now();
    noteFrame();
    emitState();
  }));
  instance.on('pong', guard('pong', () => noteFrame()));
  instance.on('message', guard('message', (data) => {
    noteFrame();
    handleFrame(typeof data === 'string' ? data : String(data), instance);
  }));
  instance.on('error', guard('error', (err) => {
    console.error(`${LOG_PREFIX}: connection error: ${err?.message ?? err}`);
  }));
  instance.on('close', guard('close', (code) => {
    console.log(`${LOG_PREFIX}: closed (code=${code ?? 'none'})`);
    dropSocket();
    scheduleReconnect();
  }));
}

/**
 * Arm the realtime transport at boot. Same gate as #32's sweep scheduler — the
 * instance FEATURE on plus a token present, and never `app.state` — and just as
 * SILENT when it does not apply: a fresh install that has never opened the
 * Beeper card neither connects nor logs.
 *
 * `overrides` injects `{ now, setTimeout, clearTimeout, random, createSocket }`
 * so the watchdog and the backoff are provable without a real sleep.
 */
export async function startBeeperSocket(overrides = {}) {
  if (running) return false;
  if (!await isBeeperIngestionArmed()) return false;
  runtime = { ...DEFAULT_RUNTIME, ...overrides };
  running = true;
  reconnectAttempts = 0;
  connectionCount = 0;
  await connect();
  return true;
}

/** Tear the transport down (shutdown, or a token that disappeared). */
export function stopBeeperSocket() {
  running = false;
  clearReconnectTimer();
  dropSocket();
  reconnectAttempts = 0;
  lastSeq = null;
  setConnectionState('down');
  runtime = { ...DEFAULT_RUNTIME };
}
