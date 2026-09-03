/**
 * Beeper Ingestion Sweep Scheduler (#32, decided on #12).
 *
 * The fifth instance of `createSyncScheduler`, alongside iMessage, Signal,
 * Spotify and YouTube, so the per-tick `enabled` re-read and the self-healing
 * re-arm come free and `syncSchedulers.parity.test.js` pins this domain's id,
 * source and log line like every other.
 *
 * TWO gates, and they are not the same flag (#11 keeps them apart):
 *   - `isBeeperIngestionArmed()` — the instance FEATURE plus a configured
 *     token. Checked here, and SILENTLY: #32's acceptance is that with the
 *     feature off or no token, nothing registers and nothing logs, so a fresh
 *     install never narrates a feature it does not have.
 *   - `settings.beeper.enabled` — the user's own "Enable scheduled Beeper
 *     sync" toggle from the Comms → Beeper card. Handed to the factory as
 *     `enabled`, so turning it off mid-session stops runs without a restart
 *     and logs the same "disabled in settings" line every other domain does.
 *
 * `type: 'interval'` means the first run is one interval AFTER registration,
 * never at boot — intended: boot should not fire a network sweep. A throwing
 * handler cannot kill the interval either; `eventScheduler.runEvent` catches
 * the rejection, records the failed run and re-arms.
 *
 * The interval is LOCKED at registration (the factory's documented carry-over
 * from the four hand-written originals), so changing `intervalMinutes` takes
 * effect at the next process start.
 *
 * No LLM calls happen on this path — ingestion is deterministic — so the
 * no-cold-bootstrap AI policy does not gate it; the opt-in is about the user's
 * credential and intent.
 */

import { createSyncScheduler } from './createSettingsGatedSyncScheduler.js';
import { getBeeperSyncConfig, isBeeperIngestionArmed, runBeeperSweep } from './beeperSync.js';

const registerBeeperScheduler = createSyncScheduler({
  id: 'beeper-sync',
  label: 'Beeper',
  icon: '🫧',
  source: 'beeperScheduler',
  getConfig: getBeeperSyncConfig,
  runSync: () => runBeeperSweep({ reason: 'scheduler' }),
});

/**
 * Start the Beeper ingestion sweep scheduler. Returns without registering —
 * and without logging — when the instance feature is off or no token is
 * configured.
 */
export async function startBeeperScheduler() {
  if (!await isBeeperIngestionArmed()) return;
  await registerBeeperScheduler();
}
