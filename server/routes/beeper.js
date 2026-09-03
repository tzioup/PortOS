import { Router } from 'express';
import { asyncHandler, createServiceErrorMapper } from '../lib/errorHandler.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';

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

export default router;
