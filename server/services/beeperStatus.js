/**
 * Beeper status resolution for the Comms → Beeper status card (#30, fork
 * issue #1). Combines three things the card renders from:
 *   - whether a token is configured (never the token itself — the vaulted
 *     credential store #31 landed answers presence/expiry/provenance without
 *     ever decrypting, and this module has no path to the value);
 *   - a liveness probe against the local Beeper Desktop API;
 *   - the read-only account roster mirrored by fork issue #27's schema, so
 *     the card renders something even with Beeper Desktop closed (accounts
 *     survive from the last ingestion sweep, once #32 lands).
 *
 * Two flags stay distinct, per the fork issue #11 decision #30 carries
 * forward: the INSTANCE FEATURE (`instanceFeatureRegistry.js` `beeper`)
 * governs navigation; `settings.beeper.enabled` governs ingestion. This
 * module answers the connection/status question only.
 */
import { query } from '../lib/db.js';
import {
  probeBeeperInfo, getInfo, assertValidInfoResponse, BeeperApiError, resolveBeeperBaseUrl,
} from './beeperClient.js';
import { getBeeperRealtimeState } from './beeperSocket.js';
import { getOutboxStatus } from './beeperOutbox.js';
import { resolveBeeperTokenMeta } from './beeperCredentials.js';

const TOKEN_EXPIRY_WARNING_DAYS = 7;

// Expiry rides beside the token in the vault (#11 decision 10 — "stored beside
// the token and displayed without a network call"). There is no refresh grant,
// so `tokenExpired` is an actionable RE-CONNECT state, deliberately distinct
// from `tokenExpiringSoon`; a pasted no-expiry token (`tokenExpiresAt: null`)
// triggers neither, which is exactly why that path exists.
function tokenExpiryInfo(tokenExpiresAt) {
  if (typeof tokenExpiresAt !== 'string' || !tokenExpiresAt) {
    return { tokenExpiresAt: null, tokenExpiresInDays: null, tokenExpiringSoon: false, tokenExpired: false };
  }
  const expires = new Date(tokenExpiresAt);
  if (Number.isNaN(expires.getTime())) {
    return { tokenExpiresAt: null, tokenExpiresInDays: null, tokenExpiringSoon: false, tokenExpired: false };
  }
  const remainingMs = expires.getTime() - Date.now();
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  return {
    tokenExpiresAt,
    tokenExpiresInDays: days,
    tokenExpiringSoon: days <= TOKEN_EXPIRY_WARNING_DAYS,
    tokenExpired: remainingMs <= 0,
  };
}

/**
 * The read-only account roster mirrored by fork issue #27's schema, so the
 * status card can render even with Beeper Desktop closed. Always an array —
 * an empty result is a trustworthy "no accounts synced yet", not a fault:
 * fork issue #32 (the ingestion sweep) is what populates this table and
 * hasn't landed yet, so an install on this slice alone always sees `[]`.
 */
export async function listBeeperAccounts() {
  const result = await query(
    `SELECT account_id AS "accountId", network, display_name AS "displayName",
            status, bridge_id AS "bridgeId", last_seen_at AS "lastSeenAt"
     FROM beeper_accounts
     ORDER BY display_name ASC, account_id ASC`,
  );
  return Array.isArray(result?.rows) ? result.rows : [];
}

/**
 * The full status payload the Comms → Beeper card renders from (#30). Never
 * throws — every sub-fetch degrades to its own "unknown" value so one failure
 * (a DB hiccup, Beeper Desktop closed) doesn't blank the whole card. Use
 * `checkBeeperConnection` below for an action that DOES throw a typed,
 * coded error (the card's "Retry" button on the unreachable state).
 *
 * `reachable` is a tri-state, never collapsed to a boolean: `true`/`false`
 * once probed, `null` when the probe was never attempted (no token
 * configured) — the absent-vs-empty sentinel from root AGENTS.md. `null`
 * must never render as offline; this function never lies and reports
 * `false` for a question it never asked.
 */
export async function getBeeperStatus() {
  // `resolveBeeperBaseUrl()`, never a raw `settings.beeper.baseUrl` read
  // (SEC-2): it re-applies the loopback-only gate `beeperSettingsSchema`
  // enforces on the PUT route, which a hand-edited `settings.json` can still
  // bypass on read. The probe and the payload's own `baseUrl` field both have
  // to report the SAME (validated) value the sweep and every other call
  // actually use.
  const resolvedBaseUrl = await resolveBeeperBaseUrl();
  // Deliberately NOT wrapped in a catch: an unreadable credential store throws
  // (#11 decision 8), and the card renders its "could not read status" branch
  // rather than telling a connected install to connect again.
  const credential = await resolveBeeperTokenMeta();
  const expiry = tokenExpiryInfo(credential.tokenExpiresAt);

  const [probe, accounts] = await Promise.all([
    credential.tokenConfigured
      ? probeBeeperInfo({ baseUrl: resolvedBaseUrl })
      : Promise.resolve(null),
    listBeeperAccounts().catch(() => []),
  ]);

  return {
    tokenConfigured: credential.tokenConfigured,
    // 'oauth' | 'pasted' | 'legacy-settings' | null — provenance, never the
    // value. This is the ONLY credential detail a client payload ever carries
    // besides presence and expiry.
    tokenSource: credential.tokenSource,
    baseUrl: resolvedBaseUrl,
    reachable: probe ? probe.reachable : null,
    lastProbeError: probe?.error ?? null,
    appVersion: probe?.info?.app?.version ?? null,
    ...expiry,
    // Transport liveness for the card's dot and its actionable-fault line
    // (#33): `connected | reconnecting | down`, plus the last frame and last
    // server ping. `appState` rides along because an actionable value
    // (`needs-login`, `needs-verification`, `needs-secrets`) is exactly what
    // the iMessage-shape card exists to surface — it is NEVER a gate, having
    // been measured reporting `initializing` for 105s on a working install.
    realtime: getBeeperRealtimeState(),
    // Outbound-send health (#36): the runaway breaker's state, and how many
    // sends are still awaiting confirmation. The breaker is the one fault here
    // that needs a human action, so it renders on the settings card the same
    // way an actionable transport fault does — never as a global banner.
    outbox: getOutboxStatus(),
    accounts,
  };
}

/**
 * A live, uncached connectivity check — the card's "Retry" action on the
 * "token present, unreachable" state. Unlike `getBeeperStatus` (which always
 * resolves, via `probeBeeperInfo`'s own swallowed-error contract), this
 * THROWS a typed `BeeperApiError` so the route can map it to a real HTTP
 * status per fork-issue-#30-and-later's status-code contract instead of the
 * status route's flattened `lastProbeError` string.
 */
export async function checkBeeperConnection() {
  const { tokenConfigured } = await resolveBeeperTokenMeta();
  if (!tokenConfigured) {
    throw new BeeperApiError('Beeper access token is not configured', {
      status: 401, code: 'NOT_CONFIGURED', retryable: false,
    });
  }
  // `resolveBeeperBaseUrl()`, never a raw `settings.beeper.baseUrl` read — see
  // the same note on `getBeeperStatus` above (SEC-2).
  const info = await getInfo({ baseUrl: await resolveBeeperBaseUrl() });
  assertValidInfoResponse(info);
  return { reachable: true, info };
}
