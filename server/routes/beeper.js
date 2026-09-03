import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, createServiceErrorMapper } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';
import { runBeeperSweep } from '../services/beeperSync.js';
import {
  listConversations,
  getConversation,
  listMessages,
  listNetworks,
  setConversationArchived,
  setConversationLowPriority,
} from '../services/beeperConversations.js';

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


// ---------------------------------------------------------------------------
// Chat surface read model (#35) — served from the MIRROR, never from Beeper.
// ---------------------------------------------------------------------------

// A query-string boolean is a STRING, so `z.coerce.boolean()` is wrong here:
// it maps the literal "false" to `true`. Omission stays `undefined`, which the
// service reads as "do not filter on this at all" — a different query from
// `false` (root AGENTS.md, absent-vs-empty).
const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true').optional();

const conversationListQuerySchema = z.object({
  network: z.string().min(1).max(100).optional(),
  unreadOnly: queryBoolean,
  archived: queryBoolean,
  lowPriority: queryBoolean,
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
}).strict();

const messageListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
}).strict();

const conversationParamsSchema = z.object({ id: z.string().guid() });

const archiveSchema = z.object({ archived: z.boolean() }).strict();
const lowPrioritySchema = z.object({ lowPriority: z.boolean() }).strict();

// GET /api/beeper/conversations — the rail's list for one scope. Filters are
// per-network and unread-only (#9's MVP scoping) plus the two system scopes
// the wired rail controls produce, archived and low-priority.
router.get('/conversations', asyncHandler(async (req, res) => {
  const filters = validateRequest(conversationListQuerySchema, req.query);
  res.json(await listConversations(filters));
}));

// GET /api/beeper/networks — the rail's scope list, derived from the mirror.
// Never a hardcoded network roster: #9 records that the development machine's
// account shape is an outlier, so the rail renders whatever data holds.
router.get('/networks', asyncHandler(async (_req, res) => {
  res.json({ networks: await listNetworks() });
}));

// GET /api/beeper/conversations/:id — one conversation with its full mirrored
// participant set. 404 when the id is unknown, so a stale deep link degrades to
// the surface's not-found state instead of an empty thread that looks live.
router.get('/conversations/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const conversation = await getConversation(id);
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found', code: 'NOT_FOUND' });
    return;
  }
  res.json(conversation);
}));

// GET /api/beeper/conversations/:id/messages — cursor-paginated, newest first.
// An empty page is a legitimate answer, not an error: history depth varies
// enormously per network (#3), so the surface says so rather than spinning.
router.get('/conversations/:id/messages', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const options = validateRequest(messageListQuerySchema, req.query);
  res.json(await listMessages(id, options));
}));

// The write mapper adds `retryable: false` to every coded failure. The plain
// mapper above drops the BeeperApiError's own `retryable` context, and a client
// that cannot see the flag is a client that may invent a retry — which, on an
// API with no idempotency key, is exactly what the send-safety discipline (#8)
// forbids. The PATCH itself never retries (beeperClient's default).
const mapBeeperWriteError = createServiceErrorMapper({
  NETWORK_ERROR: 503,
  NOT_CONFIGURED: 412,
  MALFORMED_RESPONSE: 502,
  ASSET_UNAVAILABLE: 404,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 502,
  UPSTREAM_ERROR: 502,
  UNKNOWN_ERROR: 502,
}, () => ({ retryable: false }));

// POST /api/beeper/conversations/:id/archive — one of the two rail controls #9
// wired. Beeper owns `isArchived`, so this PATCHes Beeper first and mirrors the
// answer second; a failure leaves the mirror untouched.
router.post('/conversations/:id/archive', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const { archived } = validateRequest(archiveSchema, req.body);
  const conversation = await setConversationArchived(id, archived)
    .catch((err) => { throw mapBeeperWriteError(err); });
  res.json(conversation);
}));

// POST /api/beeper/conversations/:id/low-priority — the other wired control.
// `isPinned` deliberately has no route: the pinned set is Beeper's own state,
// mirrored (#27), and a PortOS-local pin would be a second source of truth.
router.post('/conversations/:id/low-priority', asyncHandler(async (req, res) => {
  const { id } = validateRequest(conversationParamsSchema, req.params);
  const { lowPriority } = validateRequest(lowPrioritySchema, req.body);
  const conversation = await setConversationLowPriority(id, lowPriority)
    .catch((err) => { throw mapBeeperWriteError(err); });
  res.json(conversation);
}));

export default router;
