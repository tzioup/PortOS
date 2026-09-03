import { Router } from 'express';
import { asyncHandler, createServiceErrorMapper } from '../lib/errorHandler.js';
import { beeperOAuthCallbackSchema, beeperPastedTokenSchema, validateRequest } from '../lib/validation.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';
import { completeBeeperOAuth, connectWithPastedToken, disconnectBeeper, startBeeperOAuth } from '../services/beeperOAuth.js';
import { runBeeperSweep } from '../services/beeperSync.js';

const router = Router();

// BeeperApiError#status can be 0 on a pure network failure (no HTTP response
// at all — see beeperClient.js's NETWORK_ERROR case), and `res.status(0)`
// crashes Express. This mapper NEVER passes the client's raw status through:
// every recognized code gets its own explicit HTTP status here, per the
// contract wave-one reviewers set for every Beeper route built on this client.
// The OAUTH_* codes (#31) join the same table rather than inventing a second
// one, so a connect failure renders through the client's existing handling.
const BEEPER_ERROR_STATUS = {
  NETWORK_ERROR: 503,
  NOT_CONFIGURED: 412,
  MALFORMED_RESPONSE: 502,
  ASSET_UNAVAILABLE: 404,
  // Every account failed in one sweep (#32). An upstream failure, not the
  // caller's, and worth retrying — it must not answer 200 with a quietly
  // non-zero `failedAccounts`.
  SWEEP_FAILED: 502,
  UNAUTHORIZED: 401,
  TOKEN_REQUIRED: 400,
  TOKEN_REJECTED: 401,
  OAUTH_INTROSPECTION_FAILED: 502,
  OAUTH_REDIRECT_URI_MISSING: 400,
  OAUTH_STATE_UNKNOWN: 400,
  OAUTH_DISCOVERY_FAILED: 502,
  OAUTH_DISCOVERY_INVALID: 502,
  OAUTH_REGISTRATION_FAILED: 502,
  OAUTH_EXCHANGE_FAILED: 502,
};

const mapBeeperError = createServiceErrorMapper(BEEPER_ERROR_STATUS);

// Write paths (connect / paste / disconnect) carry `retryable: false` into the
// error envelope. Beeper sends are non-idempotent and the connect exchange
// burns a single-use code, so a client that auto-retried either would do real
// damage — the flag is the contract the client keys on rather than re-deriving
// "is a 502 transient" for itself.
const mapBeeperWriteError = createServiceErrorMapper(BEEPER_ERROR_STATUS, () => ({ retryable: false }));

// OAuth must use the same public origin the browser used to reach this request,
// so the flow works over HTTPS, on a Tailscale hostname, or behind a proxy —
// never a hardcoded localhost. Same derivation as routes/spotify.js.
function requestOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '')
    .toString().split(',')[0].trim();
  return ['http', 'https'].includes(proto) && host ? `${proto}://${host}` : null;
}

const redirectUriFor = (req) => {
  const origin = requestOrigin(req);
  return origin ? `${origin}/api/beeper/oauth/callback` : null;
};

// GET /api/beeper/status — the status card's read model (#30): whether a
// token is configured (never the token), how it was obtained, its expiry, a
// cached-cheap reachability probe, and the read-only account roster mirrored
// from beeper_accounts.
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getBeeperStatus());
}));

// POST /api/beeper/status/check — the status card's "Retry" action on the
// "token present, unreachable" state. Does a live, uncached probe and
// surfaces a real, coded error instead of GET /status's always-200 flattened
// `lastProbeError` string, so the client can render an actionable message
// per HTTP status (503 unreachable, 412 not configured, 502 malformed reply).
router.post('/status/check', asyncHandler(async (_req, res) => {
  const result = await checkBeeperConnection().catch((err) => { throw mapBeeperError(err); });
  res.json(result);
}));

// POST /api/beeper/sync — run one watermark-bounded ingestion sweep now
// (#32). The scheduled sweep is the normal path; this is the explicit
// user-triggered equivalent, for a user who has just connected a token or
// just changed a setting and does not want to wait out the interval. Deterministic
// ingestion only — no AI provider call — so it needs no consent step.
//
// A sweep already in flight is reported as `skipped: true` rather than queued
// or run concurrently; a missing token maps to 412 through the same coded
// mapper the status routes use, never a raw `status: 0`.
router.post('/sync', asyncHandler(async (_req, res) => {
  const result = await runBeeperSweep({ reason: 'manual' }).catch((err) => { throw mapBeeperError(err); });
  res.json(result);
}));

// POST /api/beeper/oauth/start — discover, dynamically register PortOS as a
// public client, and mint the PKCE authorization URL the browser opens (#31).
// A POST because it registers a client and stores a pending authorization; the
// PKCE verifier never leaves the server.
router.post('/oauth/start', asyncHandler(async (req, res) => {
  const origin = requestOrigin(req);
  const result = await startBeeperOAuth({ redirectUri: redirectUriFor(req), clientUri: origin })
    .catch((err) => { throw mapBeeperWriteError(err); });
  res.json(result);
}));

// GET /api/beeper/oauth/callback — hit by a BROWSER redirect from Beeper's
// consent screen, not by the SPA, so every outcome renders as a redirect back
// to the Beeper tab (which toasts the params) instead of the JSON envelope the
// error middleware would send. The `code` never reaches the client: it is
// exchanged here and only the outcome flag rides the redirect.
router.get('/oauth/callback', asyncHandler(async (req, res) => {
  const tabUrl = (error) => (error
    ? `/messages/beeper?beeperOauthError=${encodeURIComponent(error)}`
    : '/messages/beeper?beeperConnected=1');
  // safeParse rather than validateRequest: a browser landing here must always
  // end up back on the tab with a readable message, never on the JSON error
  // envelope validateRequest's throw would render in the address bar.
  const parsed = beeperOAuthCallbackSchema.safeParse(req.query);
  if (!parsed.success) return res.redirect(tabUrl('Malformed OAuth callback'));
  const params = parsed.data;
  if (params.error) return res.redirect(tabUrl(params.error));
  if (!params.code || !params.state) return res.redirect(tabUrl('Missing authorization code or state'));

  const outcome = await completeBeeperOAuth({ code: params.code, state: params.state })
    .then((result) => ({ result }))
    .catch((err) => {
      // The redirect swallows the throw, so asyncHandler never logs it — keep
      // the failure visible here. `err.message` is built from an RFC 6749 error
      // code or an HTTP status; it never carries a token or a code.
      console.error(`❌ Beeper OAuth callback failed: ${err.message}`);
      return { error: err.message || 'Beeper OAuth callback failed' };
    });
  if (outcome.error) return res.redirect(tabUrl(outcome.error));
  console.log('🔗 Beeper OAuth callback completed, credential stored');
  res.redirect(tabUrl());
}));

// POST /api/beeper/token — the paste path (#11 decision 3), a first-class
// alternative to OAuth rather than a fallback: Beeper's own UI can mint a
// no-expiry token and the OAuth surface accepts no lifetime at all. Validated
// by RFC 7662 introspection (or, failing that, a call that requires the
// bearer) so a token the server refuses is never stored, then vaulted with
// whatever expiry introspection reported. The response carries presence,
// expiry and provenance — never the value.
router.post('/token', asyncHandler(async (req, res) => {
  const { token } = validateRequest(beeperPastedTokenSchema, req.body);
  const result = await connectWithPastedToken(token).catch((err) => { throw mapBeeperWriteError(err); });
  res.json(result);
}));

// DELETE /api/beeper/token — disconnect. Revokes at the authorization server
// when the credential came from OAuth and the server advertises a revocation
// endpoint, then deletes the vaulted copy either way. Idempotent.
router.delete('/token', asyncHandler(async (_req, res) => {
  const result = await disconnectBeeper().catch((err) => { throw mapBeeperWriteError(err); });
  res.json(result);
}));

export default router;
