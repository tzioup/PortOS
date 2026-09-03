import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

/**
 * The realtime transport (#33). Time is INJECTED throughout — the watchdog is a
 * 75-second contract and the backoff is a jittered exponential, and proving
 * either with a real sleep would put a minute-plus of wall clock into CI for
 * behaviour a fake clock pins exactly.
 *
 * The `ws` module is mocked at the boundary: these tests drive a fake socket's
 * `open` / `ping` / `message` / `close` events and assert what PortOS does with
 * them, not what `ws` does with a TCP stream.
 */

const createdSockets = [];

class FakeSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.terminated = false;
    this.listeners = new Map();
    createdSockets.push(this);
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  removeAllListeners() { this.listeners.clear(); }
  send(payload) { this.sent.push(payload); }
  terminate() { this.terminated = true; }
  close() { this.terminated = true; }

  fire(event, ...args) {
    for (const handler of [...(this.listeners.get(event) || [])]) handler(...args);
  }

  // Walk the documented handshake: open → ready → subscriptions.updated.
  handshake() {
    this.fire('open');
    this.fire('message', JSON.stringify({ type: 'ready', version: 1, chatIDs: [], app: { state: false } }));
    this.fire('message', JSON.stringify({ type: 'subscriptions.updated', requestID: 'r1', chatIDs: ['*'] }));
  }
}

vi.mock('ws', () => ({ default: FakeSocket }));

let armed = true;
let resolvedConfig = { baseUrl: 'http://127.0.0.1:23373', token: 'example-token' };
const sweeps = [];

vi.mock('./beeperSync.js', () => ({
  isBeeperIngestionArmed: vi.fn(async () => armed),
  runBeeperSweep: vi.fn(async ({ reason }) => { sweeps.push(reason); return { skipped: false }; }),
}));
vi.mock('./beeperClient.js', () => ({
  DEFAULT_BASE_URL: 'http://127.0.0.1:23373',
  resolveBeeperConfig: vi.fn(async () => resolvedConfig),
}));

const {
  startBeeperSocket, stopBeeperSocket, getBeeperRealtimeState, toInvalidation,
  beeperWebSocketUrl, SILENCE_TIMEOUT_MS,
} = await import('./beeperSocket.js');
const { beeperSocketEvents } = await import('./beeperSocketEvents.js');
const { isBeeperIngestionArmed } = await import('./beeperSync.js');

// A controllable clock: timers are recorded rather than run, so a test advances
// exactly the one it cares about.
function makeClock() {
  const timers = new Map();
  let nextId = 1;
  let current = 0;
  return {
    timers,
    now: () => current,
    advance: (ms) => { current += ms; },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    // Run every timer scheduled for exactly `ms`, newest first.
    runTimersWithDelay: (ms) => {
      const due = [...timers.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      return due.length;
    },
    delaysFor: (predicate) => [...timers.values()].filter(predicate).map((timer) => timer.ms),
  };
}

let clock;
let random;

async function start(overrides = {}) {
  clock = makeClock();
  return startBeeperSocket({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: () => random,
    ...overrides,
  });
}

const latest = () => createdSockets[createdSockets.length - 1];

describe('beeperSocket — arming gate', () => {
  beforeEach(() => {
    createdSockets.length = 0;
    sweeps.length = 0;
    armed = true;
    random = 0.5;
    resolvedConfig = { baseUrl: 'http://127.0.0.1:23373', token: 'example-token' };
  });
  afterEach(() => { stopBeeperSocket(); vi.restoreAllMocks(); });

  it('opens one authenticated socket at the derived ws:// URL when the feature is on and a token is present', async () => {
    expect(await start()).toBe(true);
    expect(createdSockets).toHaveLength(1);
    expect(latest().url).toBe('ws://127.0.0.1:23373/v1/ws');
    expect(latest().options.headers.Authorization).toBe('Bearer example-token');
  });

  it('does not connect, and does not log, with the instance feature off', async () => {
    armed = false;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await start()).toBe(false);
    expect(createdSockets).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not connect, and does not log, with no token configured', async () => {
    // The gate is `isBeeperIngestionArmed`, which is token-aware — a fresh
    // install must neither open a reconnect loop against an absent localhost
    // port nor narrate a feature it does not have.
    armed = false;
    resolvedConfig = { baseUrl: 'http://127.0.0.1:23373', token: null };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await start()).toBe(false);
    expect(createdSockets).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
    expect(vi.mocked(isBeeperIngestionArmed)).toHaveBeenCalled();
  });

  it('never gates on app.state: an install reporting `initializing` still connects and stays connected', async () => {
    await start();
    latest().handshake();
    latest().fire('message', JSON.stringify({ type: 'app.state.updated', seq: 1, ts: 1, appState: { state: 'initializing' } }));
    expect(getBeeperRealtimeState().state).toBe('connected');
    expect(sweeps).toEqual([]);
  });

  it('subscribes to ["*"] plus app state, never a scoped chat set', async () => {
    await start();
    latest().fire('open');
    latest().fire('message', JSON.stringify({ type: 'ready', version: 1, chatIDs: [] }));
    const frame = JSON.parse(latest().sent[0]);
    expect(frame.type).toBe('subscriptions.set');
    expect(frame.chatIDs).toEqual(['*']);
    expect(frame.app).toEqual({ state: true });
  });

  it('derives the ws URL from the configured base URL, wss:// for https', () => {
    expect(beeperWebSocketUrl('https://192.0.2.10:23373/')).toBe('wss://192.0.2.10:23373/v1/ws');
    expect(beeperWebSocketUrl('')).toBe('ws://127.0.0.1:23373/v1/ws');
  });
});

describe('beeperSocket — silence watchdog (injected time)', () => {
  beforeEach(() => {
    createdSockets.length = 0;
    sweeps.length = 0;
    armed = true;
    random = 0.5;
    resolvedConfig = { baseUrl: 'http://127.0.0.1:23373', token: 'example-token' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { stopBeeperSocket(); vi.restoreAllMocks(); });

  it('tears the connection down after 75s of total silence and schedules a reconnect', async () => {
    await start();
    latest().handshake();
    const first = latest();

    expect(clock.runTimersWithDelay(SILENCE_TIMEOUT_MS)).toBe(1);

    expect(first.terminated).toBe(true);
    expect(getBeeperRealtimeState().state).toBe('reconnecting');
  });

  it('counts a server ping as liveness, so a quiet-but-alive connection is never torn down', async () => {
    await start();
    latest().handshake();
    const first = latest();

    // The measured heartbeat: 10.5s after open, then every 30s. Each one
    // re-arms the watchdog, so the pre-ping timer is gone.
    for (const at of [10_500, 40_500, 70_500, 100_500]) {
      clock.advance(at - clock.now());
      first.fire('ping');
    }
    expect(clock.runTimersWithDelay(SILENCE_TIMEOUT_MS)).toBe(1); // exactly one live watchdog, re-armed
    expect(first.terminated).toBe(true); // ...and it only fires once nothing else arrives

    const state = getBeeperRealtimeState();
    expect(state.lastPingAt).toBe(new Date(100_500).toISOString());
  });

  it('reconnects with jitter inside the exponential window, never at a fixed cadence', async () => {
    await start();
    latest().handshake();

    random = 0; // bottom of the jitter window
    clock.runTimersWithDelay(SILENCE_TIMEOUT_MS);
    const [low] = clock.delaysFor((timer) => timer.ms !== SILENCE_TIMEOUT_MS);
    expect(low).toBe(500); // 1000ms base → [500, 1000]

    // Same attempt count, top of the window: a different delay, so two installs
    // (or two retries) cannot align.
    stopBeeperSocket();
    await start();
    latest().handshake();
    random = 0.999;
    clock.runTimersWithDelay(SILENCE_TIMEOUT_MS);
    const [high] = clock.delaysFor((timer) => timer.ms !== SILENCE_TIMEOUT_MS);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThanOrEqual(1000);
  });

  it('backs off exponentially while reconnects keep failing, and resets once one succeeds', async () => {
    await start();
    latest().handshake();
    random = 0; // pin the low bound of each window so the growth is readable

    const delays = [];
    // First trip is the watchdog; every retry after it dies before it opens.
    clock.runTimersWithDelay(SILENCE_TIMEOUT_MS);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [delay] = clock.delaysFor((timer) => timer.ms !== SILENCE_TIMEOUT_MS);
      delays.push(delay);
      clock.runTimersWithDelay(delay); // fire the reconnect timer
      await Promise.resolve();
      await Promise.resolve();
      latest().fire('close', 1006); // the retry never got to `open`
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    expect(delays.every((delay) => delay <= 60_000)).toBe(true);

    // A connection that actually opens resets the ladder, so a long outage
    // followed by a brief blip does not inherit a minute-long delay.
    const [delay] = clock.delaysFor((timer) => timer.ms !== SILENCE_TIMEOUT_MS);
    clock.runTimersWithDelay(delay);
    await Promise.resolve();
    await Promise.resolve();
    latest().handshake();
    latest().fire('close', 1006);
    expect(clock.delaysFor((timer) => timer.ms !== SILENCE_TIMEOUT_MS)).toEqual([500]);
  });
});

describe('beeperSocket — sweep triggers', () => {
  beforeEach(() => {
    createdSockets.length = 0;
    sweeps.length = 0;
    armed = true;
    random = 0.5;
    resolvedConfig = { baseUrl: 'http://127.0.0.1:23373', token: 'example-token' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { stopBeeperSocket(); vi.restoreAllMocks(); });

  it('does not sweep on the first connection of the process — boot arms, it does not fire', async () => {
    await start();
    latest().handshake();
    await Promise.resolve();
    expect(sweeps).toEqual([]);
  });

  it('sweeps once a RECONNECT is subscribed again, because nothing replays across the gap', async () => {
    await start();
    latest().handshake();

    latest().fire('close', 1006);
    const [delay] = clock.delaysFor((timer) => timer.ms !== SILENCE_TIMEOUT_MS);
    clock.runTimersWithDelay(delay);
    await Promise.resolve();
    await Promise.resolve();
    latest().handshake();
    await Promise.resolve();

    expect(sweeps).toEqual(['socket-reconnect']);
  });

  it('sweeps on a seq gap — frames dropped while the socket still looked healthy', async () => {
    await start();
    latest().handshake();
    latest().fire('message', JSON.stringify({ type: 'message.upserted', seq: 4, ts: 1, chatID: 'chat-1', ids: ['m1'] }));
    latest().fire('message', JSON.stringify({ type: 'message.upserted', seq: 9, ts: 2, chatID: 'chat-1', ids: ['m2'] }));
    await Promise.resolve();
    expect(sweeps).toEqual(['socket-seq-gap']);
  });

  it('does not sweep on a contiguous seq run', async () => {
    await start();
    latest().handshake();
    for (const seq of [2, 3, 4]) {
      latest().fire('message', JSON.stringify({ type: 'message.upserted', seq, ts: 1, chatID: 'chat-1', ids: ['m'] }));
    }
    await Promise.resolve();
    expect(sweeps).toEqual([]);
  });

  it('sweeps when app.state RECOVERS from an actionable fault, but not on the way into one', async () => {
    await start();
    latest().handshake();
    const send = (state) => latest().fire('message', JSON.stringify({
      type: 'app.state.updated', seq: null, ts: 1, appState: { state },
    }));

    send('needs-login');
    await Promise.resolve();
    expect(sweeps).toEqual([]);
    expect(getBeeperRealtimeState().appStateActionable).toBe(true);

    send('ready');
    await Promise.resolve();
    expect(sweeps).toEqual(['socket-app-state-recovery']);
    expect(getBeeperRealtimeState().appStateActionable).toBe(false);
  });
});

describe('beeperSocket — invalidation payloads carry no content', () => {
  beforeEach(() => {
    createdSockets.length = 0;
    sweeps.length = 0;
    armed = true;
    random = 0.5;
    resolvedConfig = { baseUrl: 'http://127.0.0.1:23373', token: 'example-token' };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { stopBeeperSocket(); vi.restoreAllMocks(); });

  it('drops `entries` entirely — ids and kinds only, never bodies, names or handles', async () => {
    // `entries` is optional on ALL FOUR domain events, and when present it is
    // hydrated with the full message. Relaying it would put message content on
    // a Socket.IO channel; the browser refetches from the local mirror instead.
    const frame = {
      type: 'message.upserted',
      seq: 42,
      ts: '2026-05-06T20:20:12.497Z',
      chatID: 'chat-1',
      ids: ['msg-1'],
      entries: [{
        id: 'msg-1',
        text: 'secret message body',
        senderName: 'Alice Example',
        senderID: 'alice@example.com',
      }],
    };
    const emitted = toInvalidation(frame);
    expect(emitted).toEqual({
      kind: 'message.upserted', chatID: 'chat-1', ids: ['msg-1'], seq: 42, ts: '2026-05-06T20:20:12.497Z',
    });
    expect(JSON.stringify(emitted)).not.toContain('secret message body');
    expect(JSON.stringify(emitted)).not.toContain('Alice Example');
    expect(JSON.stringify(emitted)).not.toContain('example.com');
  });

  it('accepts both the epoch-ms and the ISO spelling of `ts`', () => {
    expect(toInvalidation({ type: 'chat.upserted', ts: 1739320000000, chatID: 'c', ids: [] }).ts)
      .toBe(new Date(1739320000000).toISOString());
    expect(toInvalidation({ type: 'chat.upserted', ts: 'not-a-date', chatID: 'c', ids: [] }).ts).toBeNull();
  });

  it('emits one invalidation per domain frame and nothing for control frames', async () => {
    const seen = [];
    const listener = (data) => seen.push(data);
    beeperSocketEvents.on('invalidate', listener);
    await start();
    latest().handshake();
    latest().fire('message', JSON.stringify({
      type: 'message.deleted', seq: 2, ts: 1, chatID: 'chat-1', ids: ['m1', 'm2'],
    }));
    beeperSocketEvents.off('invalidate', listener);

    expect(seen).toEqual([{ kind: 'message.deleted', chatID: 'chat-1', ids: ['m1', 'm2'], seq: 2, ts: new Date(1).toISOString() }]);
  });

  it('survives an unparseable frame without killing the connection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await start();
    latest().handshake();
    latest().fire('message', 'not json at all');
    expect(getBeeperRealtimeState().state).toBe('connected');
  });
});
