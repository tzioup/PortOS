import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

// The regression this file exists for (fork issue #1, final live pass): the
// arming gate — instance feature plus a stored token — used to be read at boot
// and nowhere else, so connecting on a running install left realtime down and
// no sweep registered for as long as the process stayed up, and a disconnect
// left the relay running on a revoked token.
//
// The scheduler side runs for REAL here (real `eventScheduler`, real
// `beeperScheduler`) so "registered" is the scheduler's own answer rather than a
// mock's; only the socket is doubled, since it owns a `ws` connection.
const state = {
  armed: true,
  config: { enabled: true, intervalMinutes: 5 },
};

const socket = {
  running: false,
  starts: 0,
  stops: 0,
  // Both default to an immediate no-op so every existing test below observes
  // exactly the old synchronous mock. The overlapping arm/disarm test further
  // down replaces them for that one case, to force `startBeeperSocket()` to
  // suspend at a known point instead of resolving on the same microtask tick.
  gate: Promise.resolve(),
  onStart: () => {},
};

vi.mock('./beeperSync.js', () => ({
  isBeeperIngestionArmed: async () => state.armed,
  getBeeperSyncConfig: async () => state.config,
  runBeeperSweep: vi.fn(),
}));

vi.mock('./beeperSocket.js', () => ({
  // Same contract as the real module: declines (false) when already running.
  startBeeperSocket: async () => {
    socket.starts += 1;
    socket.onStart();
    await socket.gate;
    if (socket.running) return false;
    socket.running = true;
    return true;
  },
  stopBeeperSocket: () => {
    socket.stops += 1;
    const wasRunning = socket.running;
    socket.running = false;
    return wasRunning;
  },
  isBeeperSocketRunning: () => socket.running,
}));

const { reconcileBeeperIngestion } = await import('./beeperArming.js');
const { cancel, getEvent } = await import('./eventScheduler.js');

function captureLogs() {
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line) => { lines.push(String(line)); });
  return lines;
}

beforeEach(() => {
  state.armed = true;
  state.config = { enabled: true, intervalMinutes: 5 };
  socket.running = false;
  socket.starts = 0;
  socket.stops = 0;
  socket.gate = Promise.resolve();
  socket.onStart = () => {};
});

afterEach(() => {
  cancel('beeper-sync');
  vi.restoreAllMocks();
});

describe('reconcileBeeperIngestion', () => {
  it('arms the transport and the sweep when a credential lands on a running install', async () => {
    captureLogs();

    const result = await reconcileBeeperIngestion({ reason: 'oauth-connect' });

    expect(socket.running).toBe(true);
    expect(getEvent('beeper-sync')).toBeTruthy();
    expect(result).toMatchObject({ armed: true, socketRunning: true, schedulerRegistered: true, changed: true });
  });

  it('is idempotent — a repeat call restarts nothing and does not push the next sweep out', async () => {
    captureLogs();
    await reconcileBeeperIngestion({ reason: 'oauth-connect' });
    const firstRun = getEvent('beeper-sync').nextRunAt;

    const result = await reconcileBeeperIngestion({ reason: 'feature-toggle' });

    // `eventScheduler.schedule` cancels and replaces an event with the same id,
    // resetting `nextRunAt` a whole interval into the future. Re-registering on
    // every unrelated toggle would keep the sweep permanently five minutes away.
    expect(getEvent('beeper-sync').nextRunAt).toBe(firstRun);
    expect(socket.running).toBe(true);
    expect(result.changed).toBe(false);
  });

  it('arms the transport but registers no sweep while the user has scheduled sync off', async () => {
    // The two flags stay distinct (#11): the feature+token gate arms the
    // transport, `settings.beeper.enabled` is the ingestion opt-in.
    state.config = { enabled: false, intervalMinutes: 5 };
    captureLogs();

    const result = await reconcileBeeperIngestion({ reason: 'oauth-connect' });

    expect(socket.running).toBe(true);
    expect(getEvent('beeper-sync')).toBeFalsy();
    expect(result).toMatchObject({ armed: true, schedulerRegistered: false });
  });

  it('stops the relay and cancels the sweep when the credential is deleted', async () => {
    captureLogs();
    await reconcileBeeperIngestion({ reason: 'oauth-connect' });
    expect(socket.running).toBe(true);

    state.armed = false;
    const result = await reconcileBeeperIngestion({ reason: 'disconnect' });

    expect(socket.running).toBe(false);
    expect(getEvent('beeper-sync')).toBeFalsy();
    expect(result).toMatchObject({ armed: false, socketRunning: false, schedulerRegistered: false, changed: true });
  });

  it('does nothing and says nothing on an install that was never armed', async () => {
    // #32's acceptance: with the feature off or no token, nothing registers and
    // nothing logs — a fresh install must not narrate a feature it does not have.
    state.armed = false;
    const logs = captureLogs();

    const result = await reconcileBeeperIngestion({ reason: 'feature-toggle' });

    expect(getEvent('beeper-sync')).toBeFalsy();
    expect(socket.running).toBe(false);
    expect(result.changed).toBe(false);
    expect(logs).toEqual([]);
  });

  it('serializes overlapping triggers so a toggle landing mid-connect cannot double-arm', async () => {
    captureLogs();

    await Promise.all([
      reconcileBeeperIngestion({ reason: 'oauth-connect' }),
      reconcileBeeperIngestion({ reason: 'feature-toggle' }),
    ]);

    expect(socket.running).toBe(true);
    // Two calls into the transport, but only the first one started it.
    expect(socket.starts).toBe(2);
    expect(getEvent('beeper-sync')).toBeTruthy();
  });

  // The serialization case an arm+arm race does not stress: two OPPOSITE
  // triggers landing in the same tick. Without the `tail` queue in
  // `reconcileBeeperIngestion`, both calls' `reconcileOnce()` run concurrently
  // instead of one fully finishing before the next starts, and whichever one's
  // async chain happens to settle LAST wins — not whichever was issued last.
  // Here that would leave the socket running and the sweep registered even
  // though `disconnect` (issued second) is the trigger that should have had
  // the final say.
  //
  // This is proved by temporarily removing the queue: replace
  // `reconcileBeeperIngestion`'s body in beeperArming.js with
  // `return reconcileOnce(reason);` and re-run this file. The socket stays
  // running (asserted false below) because the arm call's `startBeeperSocket()`
  // — parked on `socket.gate` until this test releases it — resumes and starts
  // the socket AFTER the disarm call has already run and found nothing to stop.
  // Restore the `tail.then(run, run)` body afterward; this test passes again
  // once it is back.
  it('lets a disarm issued while an arm is still starting the socket win the final state', async () => {
    captureLogs();
    let releaseSocket;
    socket.gate = new Promise((resolve) => { releaseSocket = resolve; });
    const socketStartSeen = new Promise((resolve) => { socket.onStart = resolve; });

    // `state.armed` is read again inside `reconcileOnce` — flipping it here
    // (once the arm call has already captured `true` and is parked inside
    // `startBeeperSocket()`) is what makes the disarm call, issued next, a
    // genuine disarm rather than a second arm.
    const armPromise = reconcileBeeperIngestion({ reason: 'oauth-connect' });
    await socketStartSeen;
    state.armed = false;
    const disarmPromise = reconcileBeeperIngestion({ reason: 'disconnect' });
    releaseSocket();

    await Promise.all([armPromise, disarmPromise]);

    expect(socket.running).toBe(false);
    expect(getEvent('beeper-sync')).toBeFalsy();
  });
});
