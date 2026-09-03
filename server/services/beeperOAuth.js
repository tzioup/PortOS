/**
 * Beeper connect flow (fork issue #31; decisions 2-4, 6 and 10 on #11).
 *
 * PortOS runs the OAuth flow ITSELF rather than asking the user for a token it
 * cannot mint. Beeper Desktop's `/.well-known/oauth-authorization-server`
 * advertises a `registration_endpoint`, `token_endpoint_auth_methods_supported:
 * ["none"]` and `code_challenge_methods_supported: ["S256"]`, so PortOS
 * registers as a PUBLIC client (no pre-shared secret) and runs
 * authorization_code + PKCE S256 with a `state` parameter. Both scopes are
 * requested in one authorization (`read write`): sending is in scope for the
 * product, and a second consent round-trip in the middle of composing a message
 * is worse than one prompt at setup.
 *
 * Pasting a token stays a FIRST-CLASS alternative, not a fallback. Nothing in
 * the OAuth surface accepts a lifetime — `/oauth/authorize`, `/oauth/token` and
 * `/oauth/register` take no expiry parameter and `expires_in` appears only as a
 * response field — while Beeper's own UI can mint a NO-EXPIRY token. There is
 * no `refresh_token` grant anywhere in the metadata, so an expired token is
 * re-connected, never refreshed. Both paths terminate in the same vaulted
 * credential (`beeperCredentials.js`).
 *
 * The token value never leaves this module except into the vault: it is never
 * logged, never put into an error message, and never returned to a route.
 */

import { createHash, randomBytes } from 'crypto';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { describeFetchError } from '../lib/fetchErrorChain.js';
import { isPlainObject } from '../lib/objects.js';
import {
  BeeperApiError, getAccounts, probeBeeperInfo, resolveBeeperBaseUrl,
} from './beeperClient.js';
import { deleteBeeperCredential, readBeeperCredential, saveBeeperCredential } from './beeperCredentials.js';

const METADATA_PATH = '/.well-known/oauth-authorization-server';
export const BEEPER_OAUTH_SCOPES = ['read', 'write'];
// Generous next to a live Beeper Desktop's 11-21 ms, and still short enough
// that a base URL pointing at a host that blackholes packets fails the connect
// action rather than hanging it. The 1 s liveness cap (#11 decision 5) is for
// the passive status probe, not for a user-initiated connect.
const OAUTH_TIMEOUT_MS = 10_000;
// An authorization the user never completes is garbage after this. Beeper's
// consent screen is local and takes seconds; ten minutes is slack, not a budget.
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * In-flight authorizations, keyed by the `state` parameter: the PKCE verifier
 * that must never leave the server, plus the endpoints discovered when the flow
 * started (so the callback cannot be steered at a different token endpoint by a
 * base-URL change mid-flow). Module-level and in-memory on purpose — one server
 * process, one user, and a pending authorization that does not survive a
 * restart is correct: the user simply clicks Connect again.
 */
const pendingAuthorizations = new Map();

function prunePending(now = Date.now()) {
  for (const [state, pending] of pendingAuthorizations) {
    if (now - pending.createdAt >= PENDING_TTL_MS) pendingAuthorizations.delete(state);
  }
}

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RFC 7636 S256: `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))`. */
export function createPkcePair() {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function oauthError(message, code, { status = 502 } = {}) {
  return new BeeperApiError(message, { status, code, retryable: false });
}

// `localhost` and the loopback literals are the same host wearing different
// spellings — #11 decision 5 defaults the base URL to `127.0.0.1` precisely
// because a dual-stack box may resolve `localhost` to `::1` first, so treating
// them as different origins here would reject Beeper's own metadata.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const sameHost = (a, b) => a === b || (LOOPBACK_HOSTS.has(a) && LOOPBACK_HOSTS.has(b));

/**
 * Resolve one advertised endpoint against the configured base URL, and refuse
 * one that points somewhere else. The metadata document is fetched from a
 * user-editable base URL (#30 makes it editable); without this check, whatever
 * answers on that URL could name any host as the token endpoint and PortOS
 * would POST the authorization code — and receive a token — off-box.
 */
function resolveEndpoint(value, baseUrl, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw oauthError(`Beeper authorization-server metadata is missing ${field}`, 'OAUTH_DISCOVERY_INVALID');
  }
  const base = new URL(baseUrl);
  const url = new URL(value.trim(), base);
  if (!['http:', 'https:'].includes(url.protocol) || !sameHost(url.hostname, base.hostname) || url.port !== base.port) {
    throw oauthError(`Beeper authorization-server metadata points ${field} at a different host`, 'OAUTH_DISCOVERY_INVALID');
  }
  return url.toString();
}

async function fetchJson(url, init, { timeoutMs = OAUTH_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs);
  } catch (err) {
    throw new BeeperApiError(`Beeper request failed: ${describeFetchError(err)}`, {
      status: 0, code: 'NETWORK_ERROR', retryable: false,
    });
  }
  const body = await readResponseJson(response, { fallback: (text) => ({ message: text }) });
  return { ok: response.ok, status: response.status, body };
}

/**
 * `GET /.well-known/oauth-authorization-server` on the configured base URL,
 * validated rather than trusted: every endpoint this flow uses must be present
 * and on the same host, and the server must advertise S256 when it advertises
 * anything at all (a server offering only `plain` would silently downgrade PKCE
 * to no protection).
 */
export async function discoverAuthorizationServer({ baseUrl } = {}) {
  const resolvedBase = baseUrl || await resolveBeeperBaseUrl();
  const { ok, status, body } = await fetchJson(`${resolvedBase}${METADATA_PATH}`, { method: 'GET' });
  if (!ok || !isPlainObject(body)) {
    throw oauthError(`Beeper authorization-server metadata unavailable (${status})`, 'OAUTH_DISCOVERY_FAILED');
  }
  const methods = body.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw oauthError('Beeper authorization server does not support PKCE S256', 'OAUTH_DISCOVERY_INVALID');
  }
  return {
    baseUrl: resolvedBase,
    authorizationEndpoint: resolveEndpoint(body.authorization_endpoint, resolvedBase, 'authorization_endpoint'),
    tokenEndpoint: resolveEndpoint(body.token_endpoint, resolvedBase, 'token_endpoint'),
    registrationEndpoint: resolveEndpoint(body.registration_endpoint, resolvedBase, 'registration_endpoint'),
    // Optional: "Disconnect" revokes when the server offers it, and merely
    // forgets when it does not.
    revocationEndpoint: body.revocation_endpoint
      ? resolveEndpoint(body.revocation_endpoint, resolvedBase, 'revocation_endpoint')
      : null,
    // Optional: RFC 7662 introspection, which is how the paste path proves a
    // pasted token is real (see `connectWithPastedToken`).
    introspectionEndpoint: body.introspection_endpoint
      ? resolveEndpoint(body.introspection_endpoint, resolvedBase, 'introspection_endpoint')
      : null,
  };
}

/**
 * RFC 7662 token introspection. Returns `{ active, expiresAt, scopes }` — the
 * only three fields this flow reads. `exp` is seconds since the epoch; absent
 * means the token does not expire, which is exactly the no-expiry credential
 * Beeper's own UI can mint, so it becomes `null` rather than a guessed default.
 *
 * `sub` is deliberately ignored: on this API it is an account identity, and
 * PortOS never stores or displays one.
 */
export async function introspectToken(token, { introspectionEndpoint, clientId } = {}) {
  const params = new URLSearchParams({ token });
  if (clientId) params.set('client_id', clientId);
  const { ok, status, body } = await fetchJson(introspectionEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Some deployments gate introspection on the token itself; sending it as
      // a bearer as well is harmless when they do not.
      Authorization: `Bearer ${token}`,
    },
    body: params.toString(),
  });
  if (!ok) {
    throw oauthError(`Beeper token introspection failed (HTTP ${status})`, 'OAUTH_INTROSPECTION_FAILED');
  }
  const exp = Number(body?.exp);
  return {
    active: body?.active === true,
    expiresAt: Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : null,
    scopes: typeof body?.scope === 'string' && body.scope.trim() ? body.scope.trim().split(/\s+/) : [],
  };
}

/**
 * RFC 7591 dynamic client registration as a PUBLIC client
 * (`token_endpoint_auth_method: 'none'`), which is what lets PortOS run this
 * flow with no pre-shared secret. Registration is per connect attempt: the
 * returned `client_id` is not a secret, costs one local round trip, and
 * re-registering keeps the redirect URI correct when the user reaches PortOS
 * over a different origin than last time.
 */
export async function registerOAuthClient({ registrationEndpoint, redirectUri, clientUri }) {
  const { ok, status, body } = await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'PortOS',
      ...(clientUri ? { client_uri: clientUri } : {}),
      grant_types: ['authorization_code'],
      response_types: ['code'],
      redirect_uris: [redirectUri],
      scope: BEEPER_OAUTH_SCOPES.join(' '),
      token_endpoint_auth_method: 'none',
    }),
  });
  const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : '';
  if (!ok || !clientId) {
    throw oauthError(`Beeper dynamic client registration failed (${status})`, 'OAUTH_REGISTRATION_FAILED');
  }
  return { clientId };
}

/**
 * Start a connect: discover, register, mint a PKCE pair plus `state`, and hand
 * back the authorization URL for the browser to open. The verifier stays here.
 */
export async function startBeeperOAuth({ redirectUri, clientUri } = {}) {
  if (typeof redirectUri !== 'string' || !redirectUri) {
    throw oauthError('A redirect URI is required to start the Beeper OAuth flow', 'OAUTH_REDIRECT_URI_MISSING', { status: 400 });
  }
  prunePending();
  const discovery = await discoverAuthorizationServer();
  const { clientId } = await registerOAuthClient({
    registrationEndpoint: discovery.registrationEndpoint, redirectUri, clientUri,
  });
  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = base64url(randomBytes(24));
  pendingAuthorizations.set(state, {
    codeVerifier, clientId, redirectUri, createdAt: Date.now(),
    tokenEndpoint: discovery.tokenEndpoint, baseUrl: discovery.baseUrl,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    scope: BEEPER_OAUTH_SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  const separator = discovery.authorizationEndpoint.includes('?') ? '&' : '?';
  console.log(`🔗 Beeper OAuth authorization started (scopes=${BEEPER_OAUTH_SCOPES.join(' ')})`);
  return {
    authorizationUrl: `${discovery.authorizationEndpoint}${separator}${params.toString()}`,
    redirectUri,
    state,
  };
}

/** `expires_in` (seconds from now) → an absolute ISO instant, or null. */
export function expiryFromTokenResponse(body, now = Date.now()) {
  const seconds = Number(body?.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now + seconds * 1000).toISOString();
}

/**
 * Complete a connect: match `state` to its pending authorization, exchange the
 * code with the PKCE verifier, store the token + expiry in the vault, then
 * probe `/v1/info` so the caller learns whether Beeper Desktop is actually
 * answering. `state` is single-use — consumed before the exchange, so a replayed
 * callback cannot re-run it.
 *
 * `redirect_uri` is deliberately NOT sent on the exchange: the live
 * `/oauth/token` surface takes `grant_type, code, code_verifier, client_id`
 * (plus an optional `resource`) and nothing else.
 */
export async function completeBeeperOAuth({ code, state } = {}) {
  prunePending();
  const pending = state ? pendingAuthorizations.get(state) : null;
  if (!pending) {
    throw oauthError('This Beeper authorization has expired or was already used — start the connect again', 'OAUTH_STATE_UNKNOWN', { status: 400 });
  }
  pendingAuthorizations.delete(state);

  const { ok, status, body } = await fetchJson(pending.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: pending.codeVerifier,
      client_id: pending.clientId,
    }).toString(),
  });
  const token = typeof body?.access_token === 'string' ? body.access_token.trim() : '';
  if (!ok || !token) {
    // `body.error` is the RFC 6749 error CODE (`invalid_grant`, …), never the
    // token — safe to surface. `error_description` is deliberately not
    // interpolated: it is free text from the authorization server.
    const reason = typeof body?.error === 'string' ? body.error : `HTTP ${status}`;
    throw oauthError(`Beeper token exchange failed (${reason})`, 'OAUTH_EXCHANGE_FAILED');
  }

  const scopes = typeof body.scope === 'string' && body.scope.trim()
    ? body.scope.trim().split(/\s+/)
    : BEEPER_OAUTH_SCOPES;
  const saved = await saveBeeperCredential({
    token,
    expiresAt: expiryFromTokenResponse(body),
    scopes,
    source: 'oauth',
    clientId: pending.clientId,
  });

  // Never throws (see beeperClient) — a token that stored fine while Beeper
  // Desktop happens to be closed is connected, not failed, and the status card
  // renders the unreachable state on its own.
  const probe = await probeBeeperInfo({ baseUrl: pending.baseUrl });
  return { ...saved, reachable: probe.reachable, lastProbeError: probe.error };
}

/**
 * The paste path (#11 decision 3). Beeper's own UI can mint a NO-EXPIRY token
 * and no OAuth parameter can request one, so this is a first-class alternative
 * rather than a fallback — and it terminates in the same vaulted credential.
 *
 * Validation must actually exercise the credential. `/v1/info` is Beeper's one
 * endpoint that ALSO answers unauthenticated, so probing it would happily
 * store a bogus token as connected. Instead:
 *
 *   1. RFC 7662 introspection when the authorization server advertises an
 *      `introspection_endpoint` — an inactive token is refused, and `exp`
 *      (absent for a no-expiry token) plus the returned scopes are stored.
 *   2. Otherwise `GET /v1/accounts`, which REQUIRES the bearer, so a rejected
 *      token surfaces here as a 401 instead of at first use. Nothing is known
 *      about its lifetime on this path, so the expiry is stored as `null`.
 *
 * Either way a token the server refuses is never written to the vault.
 */
export async function connectWithPastedToken(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) {
    throw oauthError('A Beeper access token is required', 'TOKEN_REQUIRED', { status: 400 });
  }
  const discovery = await discoverAuthorizationServer();
  const verified = discovery.introspectionEndpoint
    ? await verifyByIntrospection(value, discovery)
    : await verifyByAuthenticatedCall(value, discovery.baseUrl);

  const saved = await saveBeeperCredential({
    token: value, expiresAt: verified.expiresAt, scopes: verified.scopes, source: 'pasted',
  });
  return { ...saved, reachable: true, lastProbeError: null };
}

async function verifyByIntrospection(token, { introspectionEndpoint }) {
  const result = await introspectToken(token, { introspectionEndpoint });
  if (!result.active) {
    // Nothing about the token itself goes into the message — only the verdict.
    throw oauthError('Beeper rejected that access token (introspection reports it is not active)', 'TOKEN_REJECTED', { status: 401 });
  }
  return { expiresAt: result.expiresAt, scopes: result.scopes };
}

async function verifyByAuthenticatedCall(token, baseUrl) {
  // Throws UNAUTHORIZED on a rejected token and MALFORMED_RESPONSE when the
  // base URL points at something that answers 200 but isn't Beeper.
  await getAccounts({ baseUrl, token });
  return { expiresAt: null, scopes: [] };
}

/**
 * Disconnect. Best-effort revocation first (#11 decision 2: "Disconnect calls
 * `/oauth/revoke` rather than merely deleting the local copy"), then the local
 * delete — which runs whether or not revocation worked, because a user asking
 * to disconnect must always end up disconnected. A pasted token has no
 * registered client to revoke against, so it is only forgotten.
 */
export async function disconnectBeeper() {
  const credential = await readBeeperCredential().catch(() => null);
  if (credential?.tokenSource === 'oauth' && credential.clientId) {
    const revoked = await revokeToken(credential).catch((err) => ({ revoked: false, error: err?.message }));
    console.log(revoked?.revoked
      ? '🔓 Beeper token revoked at the authorization server'
      : '⚠️ Beeper token revocation was not accepted; deleting the local copy anyway');
  }
  return deleteBeeperCredential();
}

async function revokeToken({ token, clientId }) {
  const discovery = await discoverAuthorizationServer();
  if (!discovery.revocationEndpoint) return { revoked: false };
  const { ok } = await fetchJson(discovery.revocationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, client_id: clientId }).toString(),
  });
  return { revoked: ok };
}

/** Test seam: forget every pending authorization between cases. */
export function __resetPendingAuthorizationsForTests() {
  pendingAuthorizations.clear();
}
