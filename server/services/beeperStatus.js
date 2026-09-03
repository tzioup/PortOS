/**
 * Beeper status resolution for the Comms → Beeper status card (#30, fork
 * issue #1). Combines three things the card renders from:
 *   - whether a token is configured (never the token itself — #31 owns the
 *     vault and the connect flow; this module never reads or writes
 *     `settings.beeper.token` beyond checking its presence);
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
import { probeBeeperInfo, getInfo, assertValidInfoResponse, BeeperApiError, DEFAULT_BASE_URL } from './beeperClient.js';
import { getBeeperRealtimeState } from './beeperSocket.js';
import { getSettings } from './settings.js';

const TOKEN_EXPIRY_WARNING_DAYS = 7;

function hasConfiguredToken(settings) {
  const token = settings?.beeper?.token;
  return typeof token === 'string' && token.trim().length > 0;
}

// `tokenExpiresAt` rides beside the token in whatever store #31 lands it in
// (per the fork issue #11 decision: "token expiry stored beside the token").
// This module only ever READS it to warn — it never writes it, so it stays
// correct however #31 ultimately persists the pair.
function tokenExpiryInfo(settings) {
  const raw = settings?.beeper?.tokenExpiresAt;
  if (typeof raw !== 'string' || !raw) {
    return { tokenExpiresAt: null, tokenExpiresInDays: null, tokenExpiringSoon: false };
  }
  const expires = new Date(raw);
  if (Number.isNaN(expires.getTime())) {
    return { tokenExpiresAt: null, tokenExpiresInDays: null, tokenExpiringSoon: false };
  }
  const days = Math.ceil((expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return { tokenExpiresAt: raw, tokenExpiresInDays: days, tokenExpiringSoon: days <= TOKEN_EXPIRY_WARNING_DAYS };
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
  const settings = await getSettings();
  const tokenConfigured = hasConfiguredToken(settings);
  const expiry = tokenExpiryInfo(settings);

  const [probe, accounts] = await Promise.all([
    tokenConfigured
      ? probeBeeperInfo({ baseUrl: settings?.beeper?.baseUrl })
      : Promise.resolve(null),
    listBeeperAccounts().catch(() => []),
  ]);

  return {
    tokenConfigured,
    baseUrl: settings?.beeper?.baseUrl || DEFAULT_BASE_URL,
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
  const settings = await getSettings();
  if (!hasConfiguredToken(settings)) {
    throw new BeeperApiError('Beeper access token is not configured', {
      status: 401, code: 'NOT_CONFIGURED', retryable: false,
    });
  }
  const info = await getInfo({ baseUrl: settings?.beeper?.baseUrl });
  assertValidInfoResponse(info);
  return { reachable: true, info };
}
