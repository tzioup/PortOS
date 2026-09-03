import { Router } from 'express';
import { asyncHandler, createServiceErrorMapper } from '../lib/errorHandler.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';
import { runBeeperSweep } from '../services/beeperSync.js';

const router = Router();

// BeeperApiError#status can be 0 on a pure network failure (no HTTP response
// at all — see beeperClient.js's NETWORK_ERROR case), and `res.status(0)`
// crashes Express. This mapper NEVER passes the client's raw status through:
// every recognized code gets its own explicit HTTP status here, per the
// contract wave-one reviewers set for every Beeper route built on this client.
const mapBeeperError = createServiceErrorMapper({
  NETWORK_ERROR: 503,
  NOT_CONFIGURED: 412,
  MALFORMED_RESPONSE: 502,
  ASSET_UNAVAILABLE: 404,
});

// GET /api/beeper/status — the status card's read model (#30): whether a
// token is configured (never the token), a cached-cheap reachability probe,
// token-expiry info, and the read-only account roster mirrored from
// beeper_accounts. Never throws — see getBeeperStatus.
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

export default router;
