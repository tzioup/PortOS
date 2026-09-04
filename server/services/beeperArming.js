/**
 * Beeper ingestion arming — the one place that decides whether the sweep
 * scheduler and the realtime transport should be live (fork issue #1, found on
 * the final live pass).
 *
 * Both are gated on `isBeeperIngestionArmed()` — the instance FEATURE plus a
 * vaulted token — and both used to be evaluated at boot and nowhere else. So on
 * a live install, storing a credential or turning the feature on left realtime
 * down (`reconnectAttempts: 0`) and no sweep registered until the next server
 * restart; the mirror image was a `disconnect` that revoked the token while the
 * WebSocket kept relaying on it.
 *
 * `reconcileBeeperIngestion()` closes both halves. It reads the gate and moves
 * the two subsystems to match it, so every caller is the same one line:
 *
 *   - after a credential is stored (OAuth callback, pasted token),
 *   - after the instance feature (or the Comms group that contains it) changes,
 *   - after a disconnect deletes the credential.
 *
 * It is IDEMPOTENT and safe to call repeatedly: `startBeeperSocket()` declines
 * while the transport is already running, and the scheduler is only registered
 * when `eventScheduler` does not already hold `beeper-sync` (re-registering
 * would silently push the next sweep a full interval into the future every time
 * a user touched an unrelated toggle).
 *
 * Calls are serialized on one tail so two overlapping triggers — a feature
 * toggle landing while a connect is finishing — cannot interleave their
 * gate-read and their start/stop and settle on the losing answer. That is the
 * single-writer re-entrancy guard root AGENTS.md sanctions, not a defence
 * against competing humans.
 *
 * Logging is transition-only, which keeps #32's "a fresh install narrates
 * nothing it does not have" acceptance intact: reconciling an install with the
 * feature off and no token stops nothing, starts nothing and says nothing.
 */

import { isBeeperIngestionArmed } from './beeperSync.js';
import { isBeeperSchedulerRegistered, startBeeperScheduler, stopBeeperScheduler } from './beeperScheduler.js';
import { isBeeperSocketRunning, startBeeperSocket, stopBeeperSocket } from './beeperSocket.js';

const LOG_PREFIX = '🫧 Beeper ingestion';

// Serializes overlapping reconciles. Rejections are absorbed here so one failed
// reconcile cannot poison every later one.
let tail = Promise.resolve();

/**
 * Bring the sweep scheduler and the realtime transport into line with the
 * current arming gate.
 *
 * @param {object} [options]
 * @param {string} [options.reason] - What triggered this, for the log line.
 * @returns {Promise<{armed: boolean, socketRunning: boolean, schedulerRegistered: boolean, changed: boolean}>}
 */
export function reconcileBeeperIngestion({ reason = 'unspecified' } = {}) {
  const run = () => reconcileOnce(reason);
  const next = tail.then(run, run);
  tail = next.then(() => {}, () => {});
  return next;
}

async function reconcileOnce(reason) {
  // A gate that cannot be read (corrupt settings, unreadable vault) already
  // resolves to `false` inside `isBeeperIngestionArmed`, which says so once and
  // declines to arm — so there is no third answer to handle here.
  if (!await isBeeperIngestionArmed()) return disarm(reason);

  // The transport arms on the feature+token gate alone: it writes nothing, and
  // the liveness dot it feeds is what the settings card shows while the user
  // decides whether to enable ingestion. Returns false when already running.
  const socketStarted = await startBeeperSocket();

  // The sweep carries the user's own `settings.beeper.enabled` opt-in on top of
  // the gate; `startBeeperScheduler` owns that check, so a reconcile with the
  // toggle off correctly registers nothing.
  let schedulerStarted = false;
  if (!isBeeperSchedulerRegistered()) {
    await startBeeperScheduler();
    schedulerStarted = isBeeperSchedulerRegistered();
  }

  const changed = socketStarted || schedulerStarted;
  if (changed) console.log(`${LOG_PREFIX}: armed (${reason})`);
  return {
    armed: true,
    socketRunning: isBeeperSocketRunning(),
    schedulerRegistered: isBeeperSchedulerRegistered(),
    changed,
  };
}

function disarm(reason) {
  const socketStopped = stopBeeperSocket();
  const schedulerStopped = stopBeeperScheduler();
  const changed = socketStopped || schedulerStopped;
  if (changed) console.log(`${LOG_PREFIX}: disarmed (${reason})`);
  return { armed: false, socketRunning: false, schedulerRegistered: false, changed };
}
