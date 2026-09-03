import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/beeperStatus.js', () => ({
  getBeeperStatus: vi.fn(),
  checkBeeperConnection: vi.fn(),
}));
vi.mock('../services/beeperSync.js', () => ({ runBeeperSweep: vi.fn() }));

import beeperRoutes from './beeper.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';
import { runBeeperSweep } from '../services/beeperSync.js';
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
