import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

// The Beeper sweep scheduler's own gate (#32): the shared factory contract is
// pinned for every domain at once in syncSchedulers.parity.test.js, so this
// file covers only what is specific to Beeper — the feature+token gate that
// runs BEFORE the factory, and the interval surviving a throwing sweep.
const state = {
  armed: true,
  config: { enabled: true, intervalMinutes: 1 },
  sweep: vi.fn(async () => ({ skipped: false })),
};

vi.mock('./beeperSync.js', () => ({
  isBeeperIngestionArmed: async () => state.armed,
  getBeeperSyncConfig: async () => state.config,
  runBeeperSweep: (...args) => state.sweep(...args),
}));

const { startBeeperScheduler } = await import('./beeperScheduler.js');
const { cancel, getEvent, getHistory } = await import('./eventScheduler.js');

function captureLogs() {
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation((line) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line) => { lines.push(String(line)); });
  return lines;
}

beforeEach(() => {
  state.armed = true;
  state.config = { enabled: true, intervalMinutes: 1 };
  state.sweep = vi.fn(async () => ({ skipped: false }));
});

afterEach(() => {
  cancel('beeper-sync');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('startBeeperScheduler gating', () => {
  // #32 acceptance: "With the feature off, or with no token, nothing is
  // registered and nothing logs." Silence is the assertion — a fresh install
  // that has never opened the Beeper card must not narrate a feature it does
  // not have, which is why this gate sits ahead of the shared factory (whose
  // disabled path deliberately DOES log).
  it('registers nothing and logs nothing when the feature is off or no token is configured', async () => {
    state.armed = false;
    const logs = captureLogs();

    await startBeeperScheduler();

    expect(getEvent('beeper-sync')).toBeFalsy();
    expect(logs).toEqual([]);
  });

  it('registers nothing but DOES log when armed and the user turned scheduled sync off', async () => {
    state.config = { enabled: false, intervalMinutes: 5 };
    const logs = captureLogs();

    await startBeeperScheduler();

    expect(getEvent('beeper-sync')).toBeFalsy();
    expect(logs).toContain('🫧 Beeper sync scheduler: disabled in settings — skipping');
  });

  it('registers an interval that does not run at boot when armed and enabled', async () => {
    captureLogs();

    await startBeeperScheduler();

    const event = getEvent('beeper-sync');
    expect(event).toBeTruthy();
    expect(event.type).toBe('interval');
    expect(event.intervalMs).toBe(60_000);
    expect(state.sweep).not.toHaveBeenCalled();
  });
});

describe('the armed interval', () => {
  it('runs the sweep on each tick and keeps ticking after one throws', async () => {
    // Real eventScheduler, fake clock: a throwing handler must not cost the
    // schedule its re-arm (eventScheduler.runEvent catches and re-arms in its
    // `finally`). Proven by a SECOND tick after the first rejects, not by
    // trusting the contract — a sweep can throw on any pass (Beeper Desktop
    // quits mid-request) and an ingestion timer that dies on the first bad
    // pass silently stops archiving until the next server restart.
    vi.useFakeTimers();
    captureLogs();
    state.sweep = vi.fn()
      .mockRejectedValueOnce(new Error('Beeper request failed: ECONNREFUSED'))
      .mockResolvedValueOnce({ skipped: false });

    await startBeeperScheduler();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.sweep).toHaveBeenCalledTimes(1);
    expect(state.sweep).toHaveBeenCalledWith({ reason: 'scheduler' });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.sweep).toHaveBeenCalledTimes(2);
    expect(getEvent('beeper-sync').active).toBe(true);

    // getHistory() is newest-first: the failed pass is recorded, and the pass
    // AFTER it succeeded — the interval outlived the throw.
    const runs = getHistory({ eventId: 'beeper-sync' });
    expect(runs.map((entry) => entry.success)).toEqual([true, false]);
  });

  it('skips the run without calling the sweep when the toggle went off since registration', async () => {
    vi.useFakeTimers();
    const logs = captureLogs();

    await startBeeperScheduler();
    state.config = { enabled: false, intervalMinutes: 1 };

    await vi.advanceTimersByTimeAsync(60_000);

    expect(state.sweep).not.toHaveBeenCalled();
    expect(logs).toContain('🫧 Beeper sync scheduler: disabled since registration — skipping run');
  });
});
