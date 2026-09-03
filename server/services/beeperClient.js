/**
 * Beeper Desktop API client (fork issue #29, part of #1).
 *
 * Raw `fetch`, deliberately NOT `@beeper/desktop-api` — the published SDK lags
 * the live API and exposes no `Account.status`, no `loginID`, no `/v1/bridges`;
 * `GET /v1/spec` on the running instance is the authoritative reference (see
 * the API-surface research note, `docs/research/2026-08-31-beeper-api-surface.md`
 * on the `research/beeper` branch — not merged onto `beeper/integration`, so the
 * path is not resolvable from this branch alone). Every other Beeper feature
 * (#30-#37) is built on this module.
 *
 * `server/lib/safeUrlFetch.js` cannot wrap this: it blocks loopback in both
 * postures by design, and Beeper Desktop's whole API IS a loopback service
 * (default `http://127.0.0.1:23373`). This module goes straight to
 * `fetchWithTimeout` instead, same as `ollamaManager.js` / `lmStudioManager.js`
 * for the other local-daemon integrations. `safeUrlFetch`'s `readBodyCapped`
 * two-stage byte cap (Content-Length early-out, then a streamed abort once
 * accumulated bytes exceed the ceiling) is NOT reused here — every response
 * this module reads is small JSON from a local trusted process, read via
 * `readResponseJson`. A future byte-streaming asset fetch (attachment mirror,
 * #37) is the caller that would want that pattern; it doesn't exist yet.
 *
 * Auth and base URL: `settings.beeper.baseUrl` (default below) and
 * `settings.beeper.token`. Durable, encrypted token storage is #31's scope
 * (OAuth connect + vault, per fork issue #11 decision 10 — vaultCrypto in
 * Postgres). This module reads a plain `settings.beeper.token` field so #31
 * has one stable call site (`resolveBeeperConfig`) to swap real vault-backed
 * resolution behind, without touching anything else in this file — every
 * caller-facing function already accepts an explicit `{ baseUrl, token }`
 * override for exactly this reason.
 */

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { describeFetchError, isReplayableConnectionError } from '../lib/fetchErrorChain.js';
import { ServerError } from '../lib/errorHandler.js';
import { isPlainObject } from '../lib/objects.js';
import { getSettings } from './settings.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:23373';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
// A live Beeper Desktop answers in single-digit-to-low-double-digit ms and a
// closed loopback port refuses near-instantly, so 1s is generous headroom for
// a liveness probe, not a real request budget.
export const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
// Reads may retry once on a replayable connection failure (Beeper Desktop
// restarting mid-request); a fresh request-scoped budget on the replay, same
// shape as fetchWithTimeout's own retry contract.
const READ_RETRY = { retries: 1, retryDelayMs: 300, shouldRetry: isReplayableConnectionError };

/**
 * Typed Beeper API error. `retryable` reflects the mapping in
 * `mapBeeperResponseError`, clamped to `false` whenever the originating call
 * ran with `allowRetry: false` (every write: send/edit/delete/react/archive/
 * read-state) — callers building their own retry policy on top of this client
 * should key on it rather than re-deriving from `status`.
 */
export class BeeperApiError extends ServerError {
  constructor(message, { status = 500, code, retryable = false, details } = {}) {
    super(message, { status, code, context: { retryable, ...(details !== undefined ? { details } : {}) } });
    this.name = 'BeeperApiError';
    this.retryable = retryable;
    // ServerError's constructor does `this.status = options.status || 500`, which
    // silently rewrites a deliberate `status: 0` ("no HTTP response at all", the
    // network-error case below) into a fabricated 500. Restore the caller's actual
    // value here so `err.status === 0` is a reliable way to spot a transport
    // failure, not just `err.code === 'NETWORK_ERROR'`.
    this.status = status;
  }
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_BASE_URL;
}

function normalizeToken(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve `{ baseUrl, token }` for a call. An explicit `baseUrl` AND `token`
 * (token may be `null`, meaning "deliberately unauthenticated") skip the
 * settings read entirely — this is what keeps every test in this file free of
 * a `settings.js` mock. Otherwise each field falls back independently to
 * `settings.beeper.{baseUrl,token}`, then to the hardcoded default base URL.
 */
export async function resolveBeeperConfig({ baseUrl, token } = {}) {
  if (baseUrl !== undefined && token !== undefined) {
    return { baseUrl: normalizeBaseUrl(baseUrl), token: normalizeToken(token) };
  }
  const settings = await getSettings().catch(() => null);
  const resolvedBaseUrl = baseUrl !== undefined ? baseUrl : settings?.beeper?.baseUrl;
  const resolvedToken = token !== undefined ? token : settings?.beeper?.token;
  return { baseUrl: normalizeBaseUrl(resolvedBaseUrl), token: normalizeToken(resolvedToken) };
}

/**
 * Map a non-ok Beeper response to a typed, retry-classified error.
 *
 * `retryEligible` (default `true`) clamps every status-table verdict to
 * non-retryable when the call itself was never eligible to retry. A write
 * call runs with `allowRetry: false` (the client-wide send-safe default) and
 * must never hand back `retryable: true` on its thrown error — that field is
 * the client's own documented "key on this, not on status" contract
 * (`BeeperApiError` above), and a caller following it would otherwise
 * duplicate a real send. `beeperRequest` passes its own `allowRetry` through
 * unchanged as `retryEligible`; only the asset-502 branch below ignores it,
 * since that mapping is `retryable: false` unconditionally regardless of
 * retry eligibility.
 *
 * The one non-conventional case: a missing/expired asset answers `502`
 * ("Failed to download asset: Transfer failed for mxc://…"), not `404`. A
 * generic "5xx is transient" retry policy loops forever on media the network
 * has aged out, so an asset-endpoint `502` maps to a TERMINAL
 * `ASSET_UNAVAILABLE` rather than the ordinarily-retryable `UPSTREAM_ERROR`.
 * Every other status follows the spec's documented meaning (see the
 * API-surface research note, `docs/research/2026-08-31-beeper-api-surface.md`
 * §7, on the `research/beeper` branch); `code` is never a published enum, so
 * it rides along under `details` for logging only.
 */
export function mapBeeperResponseError(status, body, { isAssetEndpoint = false, retryEligible = true } = {}) {
  const beeperCode = body?.code;
  const message = typeof body?.message === 'string' && body.message
    ? body.message
    : `Beeper API error: ${status}`;
  const details = beeperCode !== undefined ? { beeperCode } : undefined;

  if (status === 502 && isAssetEndpoint) {
    return new BeeperApiError(message, { status, code: 'ASSET_UNAVAILABLE', retryable: false, details });
  }

  const STATUS_TABLE = {
    400: { code: 'BAD_REQUEST', retryable: false },
    401: { code: 'UNAUTHORIZED', retryable: false },
    403: { code: 'FORBIDDEN', retryable: false },
    404: { code: 'NOT_FOUND', retryable: false },
    409: { code: 'CONFLICT', retryable: false },
    422: { code: 'VALIDATION_ERROR', retryable: false },
    429: { code: 'RATE_LIMITED', retryable: true },
    500: { code: 'INTERNAL_ERROR', retryable: true },
    502: { code: 'UPSTREAM_ERROR', retryable: true },
  };
  const mapped = STATUS_TABLE[status] || { code: 'UNKNOWN_ERROR', retryable: status >= 500 };
  return new BeeperApiError(message, { status, code: mapped.code, retryable: retryEligible && mapped.retryable, details });
}

/**
 * Low-level authenticated request. Every call goes through `fetchWithTimeout`
 * (requirement: "fetchWithTimeout on every call"). `allowRetry` is OFF by
 * default — the send-safe default, since Beeper has no idempotency key on
 * send and a retried POST duplicates a real message. Read call sites opt in
 * explicitly with `allowRetry: true`.
 */
async function beeperRequest(path, {
  method = 'GET',
  body,
  headers,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  baseUrl,
  token,
  requireAuth = true,
  allowRetry = false,
  isAssetEndpoint = false,
} = {}) {
  const resolved = await resolveBeeperConfig({ baseUrl, token });
  if (requireAuth && !resolved.token) {
    throw new BeeperApiError('Beeper access token is not configured', {
      status: 401, code: 'NOT_CONFIGURED', retryable: false,
    });
  }

  const reqHeaders = { 'Content-Type': 'application/json', ...headers };
  if (resolved.token) reqHeaders.Authorization = `Bearer ${resolved.token}`;

  let response;
  try {
    response = await fetchWithTimeout(`${resolved.baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs, allowRetry ? READ_RETRY : {});
  } catch (err) {
    throw new BeeperApiError(`Beeper request failed: ${describeFetchError(err)}`, {
      status: 0, code: 'NETWORK_ERROR', retryable: allowRetry && isReplayableConnectionError(err),
    });
  }

  if (response.status === 204) return null;
  const data = await readResponseJson(response, { fallback: (text) => ({ message: text }) });
  if (!response.ok) throw mapBeeperResponseError(response.status, data, { isAssetEndpoint, retryEligible: allowRetry });
  return data;
}

// ---------------------------------------------------------------------------
// Discovery / liveness
// ---------------------------------------------------------------------------

/** `GET /v1/info` — the one unauthenticated endpoint. */
export async function getInfo({ baseUrl, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return beeperRequest('/v1/info', { baseUrl, token: null, requireAuth: false, timeoutMs });
}

/**
 * Structural check on `/v1/info`'s response body (#30 — a wave-one reviewer
 * requirement on the status probe). `app.name` and `server.status` are the
 * two fields every documented shape carries (see the API-surface research
 * note). A 200 with an unexpected body — some other local HTTP service
 * answering on a misconfigured `settings.beeper.baseUrl` (#30 makes that
 * user-editable), or a Beeper Desktop version mid-upgrade — must not be
 * reported as a healthy probe just because the transport succeeded. Exported
 * so a caller that wants the raw typed error (rather than `probeBeeperInfo`'s
 * swallowed boolean) can throw it directly.
 */
export function assertValidInfoResponse(info) {
  const valid = isPlainObject(info)
    && typeof info?.app?.name === 'string' && info.app.name.length > 0
    && typeof info?.server?.status === 'string' && info.server.status.length > 0;
  if (!valid) {
    throw new BeeperApiError('Beeper API returned an unexpected /v1/info response shape (expected { app: { name }, server: { status } })', {
      status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
    });
  }
}

/**
 * Liveness probe with a 1s cap (#11) — generous headroom over a live Beeper
 * Desktop's actual response time, without being a real request budget. Never
 * throws — an unreachable/misconfigured install is a normal outcome for a
 * feature the user hasn't set up yet, not an exceptional one. A shape-invalid
 * 200 (see `assertValidInfoResponse`) reports `reachable: false` exactly like
 * a transport failure — a body that isn't Beeper's `/v1/info` never counts as
 * "reachable" just because *something* answered.
 */
export async function probeBeeperInfo({ baseUrl, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  try {
    const info = await getInfo({ baseUrl, timeoutMs });
    assertValidInfoResponse(info);
    return { reachable: true, info, error: null };
  } catch (err) {
    return { reachable: false, info: null, error: err instanceof BeeperApiError ? err.message : describeFetchError(err) };
  }
}

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

/**
 * Walk a cursor-paginated Beeper endpoint as an async iterator, so callers
 * never hand-roll the cursor loop. `fetchPage({ cursor, direction })` must
 * return the standard envelope `{ items, hasMore, oldestCursor, newestCursor }`.
 *
 * `direction: 'before'` (default) walks `oldestCursor` — the only direction
 * the endpoints this client wraps document as safe to auto-paginate (the SDK's
 * own auto-pagination only ever walks backwards too). `hasMore: true` with no
 * cursor to continue on is treated as exhausted rather than looping forever —
 * a defensive stop, since the spec never documents that combination. Same
 * defense if a server answers `hasMore: true` with the SAME cursor it was
 * just called with (a value that would otherwise walk in place forever).
 *
 * A page whose `items` isn't an array (a malformed/unexpected response body —
 * see `getAccounts`/`getBridges` below for the same rule) throws a typed
 * `MALFORMED_RESPONSE` `BeeperApiError` rather than silently coercing to `[]`
 * and reporting "no items" — the AGENTS.md "sentinel + validate" rule: absent,
 * failed, and invalid must never collapse into the same value as
 * legitimately-empty.
 */
export async function* paginateBeeperCursor(fetchPage, { direction = 'before' } = {}) {
  let cursor;
  for (;;) {
    const page = await fetchPage({ cursor, direction });
    if (!Array.isArray(page?.items)) {
      throw new BeeperApiError('Beeper API returned an unexpected paginated response shape (expected { items: [] })', {
        status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
      });
    }
    for (const item of page.items) yield item;
    if (!page?.hasMore) return;
    const nextCursor = direction === 'after' ? page?.newestCursor : page?.oldestCursor;
    if (!nextCursor || nextCursor === cursor) return;
    cursor = nextCursor;
  }
}

function cursorQuery({ cursor, direction }) {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  if (direction) qs.set('direction', direction);
  const query = qs.toString();
  return query ? `?${query}` : '';
}

function clampLimit(value, { min = 1, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Append arbitrary search/filter params onto a `URLSearchParams`. An array
 * value (`accountIDs`, `chatIDs`, `mediaTypes` — all declared as array query
 * params in `/v1/spec`) is serialized as REPEATED keys (`?chatIDs=a&chatIDs=b`),
 * not `qs.set(key, String(array))`, which would comma-join it into one value
 * (`chatIDs=a%2Cb`) that the server reads as a single id matching nothing.
 */
function appendSearchParams(qs, params) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        qs.append(key, String(item));
      }
      continue;
    }
    qs.set(key, String(value));
  }
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/**
 * `GET /v1/chats` — no `limit` param (server-chosen page size). One page.
 *
 * `accountIDs` is the endpoint's only filter and is declared as an ARRAY query
 * param, so it goes through `appendSearchParams` (repeated keys) rather than
 * `qs.set`, which would comma-join two ids into one value matching no account.
 * The ingestion sweep (#32) pages one account at a time so a chat row is
 * always attributable to the account whose cursor bounds it — without the
 * filter it would have to page the whole cross-account list once per account.
 * An omitted/empty `accountIDs` sends no filter at all (every account), never
 * an empty `accountIDs=` that the server would read as "match nothing".
 */
export async function listChatsPage({ cursor, direction = 'before', accountIDs, baseUrl, token, timeoutMs } = {}) {
  const qs = new URLSearchParams();
  appendSearchParams(qs, { accountIDs });
  if (cursor) qs.set('cursor', cursor);
  if (direction) qs.set('direction', direction);
  const query = qs.toString();
  return beeperRequest(`/v1/chats${query ? `?${query}` : ''}`, { baseUrl, token, timeoutMs, allowRetry: true });
}

/** Async iterator over every chat, walking cursors automatically. */
export function listChats({ direction = 'before', accountIDs, baseUrl, token, timeoutMs } = {}) {
  return paginateBeeperCursor(
    ({ cursor, direction: dir }) => listChatsPage({
      cursor, direction: dir, accountIDs, baseUrl, token, timeoutMs,
    }),
    { direction },
  );
}

export async function getChat(chatId, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}`, { baseUrl, token, timeoutMs, allowRetry: true });
}

/** `GET /v1/chats/search` — has `limit` (default 50, max 200). One page. */
export async function searchChatsPage({ limit, cursor, direction = 'before', baseUrl, token, timeoutMs, ...params } = {}) {
  const qs = new URLSearchParams();
  appendSearchParams(qs, params);
  const clamped = clampLimit(limit, { min: 1, max: 200, fallback: undefined });
  if (clamped !== undefined) qs.set('limit', String(clamped));
  if (cursor) qs.set('cursor', cursor);
  if (direction) qs.set('direction', direction);
  const query = qs.toString();
  return beeperRequest(`/v1/chats/search${query ? `?${query}` : ''}`, { baseUrl, token, timeoutMs, allowRetry: true });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** `GET /v1/chats/{chatID}/messages` — no `limit` param. One page. */
export async function listMessagesPage(chatId, { cursor, direction = 'before', baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(
    `/v1/chats/${encodeURIComponent(chatId)}/messages${cursorQuery({ cursor, direction })}`,
    { baseUrl, token, timeoutMs, allowRetry: true },
  );
}

/** Async iterator over every message in a chat, walking cursors automatically. */
export function listMessages(chatId, { direction = 'before', baseUrl, token, timeoutMs } = {}) {
  return paginateBeeperCursor(
    ({ cursor, direction: dir }) => listMessagesPage(chatId, { cursor, direction: dir, baseUrl, token, timeoutMs }),
    { direction },
  );
}

export async function getMessage(chatId, messageId, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    { baseUrl, token, timeoutMs, allowRetry: true },
  );
}

/** `GET /v1/messages/search` — `limit` is hard-capped at 20 (default 20). One page. */
export async function searchMessagesPage({ limit, cursor, direction = 'before', baseUrl, token, timeoutMs, ...params } = {}) {
  const qs = new URLSearchParams();
  appendSearchParams(qs, params);
  const clamped = clampLimit(limit, { min: 1, max: 20, fallback: 20 });
  qs.set('limit', String(clamped));
  if (cursor) qs.set('cursor', cursor);
  if (direction) qs.set('direction', direction);
  return beeperRequest(`/v1/messages/search?${qs.toString()}`, { baseUrl, token, timeoutMs, allowRetry: true });
}

/**
 * Send a message. Retry is OFF (the client-wide default) — there is no
 * idempotency key on send, so a retried POST sends a second real message.
 */
export async function sendMessage(chatId, { text, replyToMessageID, attachment } = {}, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: { text, replyToMessageID, attachment },
    baseUrl, token, timeoutMs,
  });
}

/** Edit a message. No retry — same send-safety posture as `sendMessage`. */
export async function editMessage(chatId, messageId, text, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PUT',
    body: { text },
    baseUrl, token, timeoutMs,
  });
}

/**
 * Delete (unsend) a message. `forEveryone` is REQUIRED and must be an
 * explicit boolean — the API defaults it to `true` when omitted, unsending
 * for every participant on networks that support it. No retry.
 */
export async function deleteMessage(chatId, messageId, forEveryone, { baseUrl, token, timeoutMs } = {}) {
  if (typeof forEveryone !== 'boolean') {
    throw new BeeperApiError(
      'deleteMessage requires an explicit boolean forEveryone — Beeper defaults an omitted value to true (unsend for everyone)',
      { status: 400, code: 'FOR_EVERYONE_REQUIRED', retryable: false },
    );
  }
  return beeperRequest(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}?forEveryone=${forEveryone}`,
    { method: 'DELETE', baseUrl, token, timeoutMs },
  );
}

export async function addReaction(chatId, messageId, reactionKey, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: 'POST',
    body: { reactionKey },
    baseUrl, token, timeoutMs,
  });
}

export async function removeReaction(chatId, messageId, reactionKey, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(
    `/v1/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionKey)}`,
    { method: 'DELETE', baseUrl, token, timeoutMs },
  );
}

// ---------------------------------------------------------------------------
// Chat state (archive / read)
// ---------------------------------------------------------------------------

/** `PATCH /v1/chats/{chatID}` with `{isArchived}` — returns the updated Chat. */
export async function archiveChat(chatId, archived = true, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}`, {
    method: 'PATCH',
    body: { isArchived: archived },
    baseUrl, token, timeoutMs,
  });
}

export async function markRead(chatId, { messageID } = {}, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/read`, {
    method: 'POST',
    body: messageID ? { messageID } : {},
    baseUrl, token, timeoutMs,
  });
}

export async function markUnread(chatId, { messageID } = {}, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest(`/v1/chats/${encodeURIComponent(chatId)}/unread`, {
    method: 'POST',
    body: messageID ? { messageID } : {},
    baseUrl, token, timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * `POST /v1/assets/download` — resolves an `mxc://`/`localmxc://` reference to
 * a local file URL. A missing/expired asset answers `502` (not `404`); that
 * maps to the terminal `ASSET_UNAVAILABLE`, never a retryable error (see
 * `mapBeeperResponseError`). Byte streaming (`GET /v1/assets/serve`) and disk
 * mirroring are #37's scope, not implemented here.
 */
export async function downloadAsset(url, { baseUrl, token, timeoutMs } = {}) {
  return beeperRequest('/v1/assets/download', {
    method: 'POST',
    body: { url },
    baseUrl, token, timeoutMs,
    isAssetEndpoint: true,
  });
}

// ---------------------------------------------------------------------------
// Accounts / bridges
// ---------------------------------------------------------------------------

// Strips the top-level `loginID` field — it is the user's phone number
// (requirement: never log or persist it from either /v1/accounts or
// /v1/bridges) — and ONLY that field. This is a narrow, named boundary, not a
// PII allowlist: `GET /v1/spec`'s `Account.user` (a `User`) carries its own
// `phoneNumber`/`email`/`fullName`, and none of those are touched here — they
// deliberately survive into every caller of `getAccounts`/`getBridges`/
// `getJoinedAccounts`, because fork issue #10 (Tribe identity) needs
// `user.phoneNumber` from this same client. A caller that logs or persists a
// whole account/user row is still responsible for that PII itself.
function stripLoginId(account) {
  if (!account || typeof account !== 'object') return account;
  const { loginID, ...rest } = account;
  return rest;
}

// Also strips `activeAccountCount` — documented to over-report (requirement:
// do not surface it) — alongside the nested loginID strip, so a bridge row
// never carries either field past this boundary.
function stripBridgeAccountsLoginId(bridge) {
  if (!bridge || typeof bridge !== 'object') return bridge;
  const { activeAccountCount, ...rest } = bridge;
  return {
    ...rest,
    accounts: Array.isArray(bridge.accounts) ? bridge.accounts.map(stripLoginId) : bridge.accounts,
  };
}

/**
 * `GET /v1/accounts` — a BARE array, not a paginated envelope.
 *
 * Throws a typed `MALFORMED_RESPONSE` `BeeperApiError` when the body isn't an
 * array, instead of coercing to `[]` — the AGENTS.md "sentinel + validate"
 * rule (`lmStudioManager.getLastListError` is the named precedent): a 200 with
 * a non-JSON body becomes `{ message: text }` and a blank 200 becomes `{}` via
 * `readResponseJson`'s fallback, and both used to be indistinguishable from a
 * genuinely empty roster. With `settings.beeper.baseUrl` user-editable (#30),
 * any other local service answering 200 must surface as a fault here, not as
 * "no accounts connected".
 */
export async function getAccounts({ baseUrl, token, timeoutMs } = {}) {
  const raw = await beeperRequest('/v1/accounts', { baseUrl, token, timeoutMs, allowRetry: true });
  if (!Array.isArray(raw)) {
    throw new BeeperApiError('Beeper API returned an unexpected /v1/accounts response shape (expected an array)', {
      status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
    });
  }
  return raw.map(stripLoginId);
}

/**
 * `GET /v1/bridges` — `{ items: Bridge[] }`. Deliberately does not surface
 * `activeAccountCount` (documented to over-report; requirement: do not use it).
 *
 * Same "sentinel + validate" rule as `getAccounts` above: throws a typed
 * `MALFORMED_RESPONSE` `BeeperApiError` when `items` isn't an array, instead
 * of coercing a missing/invalid `items` to `[]`.
 */
export async function getBridges({ baseUrl, token, timeoutMs } = {}) {
  const raw = await beeperRequest('/v1/bridges', { baseUrl, token, timeoutMs, allowRetry: true });
  if (!Array.isArray(raw?.items)) {
    throw new BeeperApiError('Beeper API returned an unexpected /v1/bridges response shape (expected { items: [] })', {
      status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
    });
  }
  return { items: raw.items.map(stripBridgeAccountsLoginId) };
}

/**
 * Join accounts to their bridge by `accountID` through each bridge's nested
 * `accounts[]` — NOT by `network` (accounts carry a display name, bridges
 * carry a lowercase slug; that join returns zero rows). An account with no
 * matching bridge is kept, with bridge-derived fields `null`.
 *
 * `statusText` is taken from the bridge only — observed live (#11) to exist
 * only on `connected` bridge rows and never populated on the account itself,
 * even though the account schema allows the field.
 *
 * Pure — no I/O — so it's testable directly against a fixture without a
 * network mock. `getJoinedAccounts` is the I/O wrapper below.
 */
export function joinAccountsWithBridges(accounts, bridgesResponse) {
  const bridges = Array.isArray(bridgesResponse?.items) ? bridgesResponse.items : [];
  const bridgeByAccountId = new Map();
  for (const bridge of bridges) {
    for (const acct of Array.isArray(bridge?.accounts) ? bridge.accounts : []) {
      if (acct?.accountID) bridgeByAccountId.set(acct.accountID, bridge);
    }
  }
  return (Array.isArray(accounts) ? accounts : []).map((account) => {
    const safeAccount = stripLoginId(account);
    const bridge = safeAccount?.accountID ? bridgeByAccountId.get(safeAccount.accountID) : null;
    return {
      ...safeAccount,
      network: safeAccount.network ?? bridge?.network ?? null,
      bridgeId: bridge?.id ?? null,
      bridgeStatus: bridge?.status ?? null,
      statusText: bridge?.statusText ?? null,
    };
  });
}

/** `getAccounts()` joined to `getBridges()` by `accountID`. */
export async function getJoinedAccounts({ baseUrl, token, timeoutMs } = {}) {
  const [accounts, bridges] = await Promise.all([
    getAccounts({ baseUrl, token, timeoutMs }),
    getBridges({ baseUrl, token, timeoutMs }),
  ]);
  return joinAccountsWithBridges(accounts, bridges);
}
