import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/beeperStatus.js', () => ({
  getBeeperStatus: vi.fn(),
  checkBeeperConnection: vi.fn(),
}));
vi.mock('../services/beeperSync.js', () => ({ runBeeperSweep: vi.fn() }));
vi.mock('../services/beeperConversations.js', () => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  listMessages: vi.fn(),
  listNetworks: vi.fn(),
  setConversationArchived: vi.fn(),
  setConversationLowPriority: vi.fn(),
}));

import beeperRoutes from './beeper.js';
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
import { BeeperApiError } from '../services/beeperClient.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/beeper', beeperRoutes);
  return app;
};

describe('GET /api/beeper/status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the status payload as-is', async () => {
    vi.mocked(getBeeperStatus).mockResolvedValue({ tokenConfigured: false, reachable: null, accounts: [] });
    const res = await request(buildApp()).get('/api/beeper/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tokenConfigured: false, reachable: null, accounts: [] });
  });
});

// The wave-one reviewer contract this route exists to prove: every recognized
// BeeperApiError code maps to its own explicit HTTP status, and the mapper
// never lets a status:0 network-failure error reach res.status() raw (which
// would crash Express).
describe('POST /api/beeper/status/check — createServiceErrorMapper contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps NETWORK_ERROR (status:0 on the source error) to 503, not a raw 0', async () => {
    vi.mocked(checkBeeperConnection).mockRejectedValue(
      new BeeperApiError('Beeper request failed: connection refused', { status: 0, code: 'NETWORK_ERROR', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NETWORK_ERROR');
  });

  it('maps NOT_CONFIGURED to 412', async () => {
    vi.mocked(checkBeeperConnection).mockRejectedValue(
      new BeeperApiError('Beeper access token is not configured', { status: 401, code: 'NOT_CONFIGURED', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('NOT_CONFIGURED');
  });

  it('maps MALFORMED_RESPONSE to 502', async () => {
    vi.mocked(checkBeeperConnection).mockRejectedValue(
      new BeeperApiError('Beeper API returned an unexpected /v1/info response shape', { status: 502, code: 'MALFORMED_RESPONSE', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('MALFORMED_RESPONSE');
  });

  it('maps ASSET_UNAVAILABLE to 404', async () => {
    vi.mocked(checkBeeperConnection).mockRejectedValue(
      new BeeperApiError('Asset no longer available', { status: 502, code: 'ASSET_UNAVAILABLE', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ASSET_UNAVAILABLE');
  });

  it('resolves 200 with the connection result on success', async () => {
    vi.mocked(checkBeeperConnection).mockResolvedValue({ reachable: true, info: { app: { name: 'Beeper' } } });
    const res = await request(buildApp()).post('/api/beeper/status/check');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
  });
});

// The manual run-now sweep (#32). The scheduled sweep is the normal path; this
// is the same work on demand, and it inherits the coded-error contract above
// rather than leaking a status:0 through to res.status().
describe('POST /api/beeper/sync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs one sweep and returns its summary', async () => {
    vi.mocked(runBeeperSweep).mockResolvedValue({ skipped: false, accounts: 2, chats: 3, messages: 7, failedAccounts: 0, durationMs: 42 });
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ skipped: false, chats: 3, messages: 7 });
    expect(vi.mocked(runBeeperSweep)).toHaveBeenCalledWith({ reason: 'manual' });
  });

  it('reports an already-running sweep as skipped rather than starting a second one', async () => {
    vi.mocked(runBeeperSweep).mockResolvedValue({ skipped: true, reason: 'manual', accounts: 0, chats: 0, messages: 0 });
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
  });

  it('maps a missing token to 412 through the same mapper, never a raw status', async () => {
    vi.mocked(runBeeperSweep).mockRejectedValue(
      new BeeperApiError('Beeper access token is not configured', { status: 401, code: 'NOT_CONFIGURED', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('NOT_CONFIGURED');
  });

  it('maps an unreachable Beeper Desktop (status:0) to 503', async () => {
    vi.mocked(runBeeperSweep).mockRejectedValue(
      new BeeperApiError('Beeper request failed: connection refused', { status: 0, code: 'NETWORK_ERROR', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Chat surface (#35)
// ---------------------------------------------------------------------------

const CONV_ID = '11111111-1111-4111-8111-111111111111';

describe('GET /api/beeper/conversations — filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], nextCursor: null });
  });

  it('passes every supported filter through, with query-string booleans parsed as booleans', async () => {
    const res = await request(buildApp())
      .get('/api/beeper/conversations?network=examplenet&unreadOnly=true&archived=false&lowPriority=false&limit=25');
    expect(res.status).toBe(200);
    expect(listConversations).toHaveBeenCalledWith({
      network: 'examplenet', unreadOnly: true, archived: false, lowPriority: false, limit: 25,
    });
  });

  it('omits an absent filter entirely rather than defaulting it to false', async () => {
    await request(buildApp()).get('/api/beeper/conversations');
    expect(listConversations).toHaveBeenCalledWith({});
  });

  it('rejects a non-boolean filter value instead of coercing it', async () => {
    const res = await request(buildApp()).get('/api/beeper/conversations?archived=yes');
    expect(res.status).toBe(400);
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('forwards the pagination cursor untouched', async () => {
    vi.mocked(listConversations).mockResolvedValue({ conversations: [], nextCursor: 'next-page-token' });
    const res = await request(buildApp()).get('/api/beeper/conversations?cursor=abc123');
    expect(listConversations).toHaveBeenCalledWith({ cursor: 'abc123' });
    expect(res.body.nextCursor).toBe('next-page-token');
  });
});

describe('GET /api/beeper/conversations/:id and its messages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404s an unknown conversation so a stale deep link degrades to not-found', async () => {
    vi.mocked(getConversation).mockResolvedValue(null);
    const res = await request(buildApp()).get(`/api/beeper/conversations/${CONV_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('rejects a non-uuid conversation id before it reaches the store', async () => {
    const res = await request(buildApp()).get('/api/beeper/conversations/not-a-uuid');
    expect(res.status).toBe(400);
    expect(getConversation).not.toHaveBeenCalled();
  });

  it('paginates the thread and answers an empty page with 200, not an error', async () => {
    vi.mocked(listMessages).mockResolvedValue({ messages: [], nextCursor: null });
    const res = await request(buildApp()).get(`/api/beeper/conversations/${CONV_ID}/messages?limit=20&cursor=abc`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], nextCursor: null });
    expect(listMessages).toHaveBeenCalledWith(CONV_ID, { limit: 20, cursor: 'abc' });
  });
});

describe('GET /api/beeper/networks', () => {
  it('returns the rail scopes derived from the mirror', async () => {
    vi.mocked(listNetworks).mockResolvedValue([{ network: 'examplenet', unreadCount: 2 }]);
    const res = await request(buildApp()).get('/api/beeper/networks');
    expect(res.status).toBe(200);
    expect(res.body.networks).toEqual([{ network: 'examplenet', unreadCount: 2 }]);
  });
});

// The two rail controls #9 wired. The contract worth pinning is not that they
// succeed but how they FAIL: a Beeper write has no idempotency key, so the
// error a client sees must never advertise retry-safety.
describe('archive / low-priority write paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('archives through the service and returns the updated conversation', async () => {
    vi.mocked(setConversationArchived).mockResolvedValue({ id: CONV_ID, isArchived: true });
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(200);
    expect(setConversationArchived).toHaveBeenCalledWith(CONV_ID, true);
    expect(res.body.isArchived).toBe(true);
  });

  it('sets low priority through the service', async () => {
    vi.mocked(setConversationLowPriority).mockResolvedValue({ id: CONV_ID, isLowPriority: true });
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/low-priority`)
      .send({ lowPriority: true });
    expect(res.status).toBe(200);
    expect(setConversationLowPriority).toHaveBeenCalledWith(CONV_ID, true);
  });

  it('rejects a missing/again non-boolean flag before any upstream write', async () => {
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/archive`)
      .send({ archived: 'yes' });
    expect(res.status).toBe(400);
    expect(setConversationArchived).not.toHaveBeenCalled();
  });

  it('maps a NETWORK_ERROR to 503 and reports retryable: false — never a raw status 0, never a retry hint', async () => {
    vi.mocked(setConversationArchived).mockRejectedValue(
      new BeeperApiError('Beeper request failed: connection refused', { status: 0, code: 'NETWORK_ERROR', retryable: false }),
    );
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NETWORK_ERROR');
    expect(res.body.context).toMatchObject({ retryable: false });
  });

  it('clamps an ordinarily-retryable upstream failure to retryable: false on a write path', async () => {
    vi.mocked(setConversationLowPriority).mockRejectedValue(
      new BeeperApiError('Too Many Requests', { status: 429, code: 'RATE_LIMITED', retryable: false }),
    );
    const res = await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/low-priority`)
      .send({ lowPriority: true });
    expect(res.status).toBe(429);
    expect(res.body.context).toMatchObject({ retryable: false });
  });

  it('calls the upstream write exactly once — the route never retries', async () => {
    vi.mocked(setConversationArchived).mockRejectedValue(
      new BeeperApiError('Bad Gateway', { status: 502, code: 'UPSTREAM_ERROR', retryable: true }),
    );
    await request(buildApp())
      .post(`/api/beeper/conversations/${CONV_ID}/archive`)
      .send({ archived: false });
    expect(setConversationArchived).toHaveBeenCalledTimes(1);
  });
});
