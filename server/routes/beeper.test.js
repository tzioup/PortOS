import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/beeperStatus.js', () => ({
  getBeeperStatus: vi.fn(),
  checkBeeperConnection: vi.fn(),
}));
vi.mock('../services/beeperOAuth.js', () => ({
  startBeeperOAuth: vi.fn(),
  completeBeeperOAuth: vi.fn(),
  connectWithPastedToken: vi.fn(),
  disconnectBeeper: vi.fn(),
}));
vi.mock('../services/beeperSync.js', () => ({ runBeeperSweep: vi.fn() }));
vi.mock('../services/beeperOutbox.js', () => ({
  createOutboxEntry: vi.fn(),
  sendOutboxEntry: vi.fn(),
  listOutboxEntries: vi.fn(),
  clearOutboxBreaker: vi.fn(),
}));

import beeperRoutes from './beeper.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';
import {
  completeBeeperOAuth, connectWithPastedToken, disconnectBeeper, startBeeperOAuth,
} from '../services/beeperOAuth.js';
import { runBeeperSweep } from '../services/beeperSync.js';
import {
  clearOutboxBreaker, createOutboxEntry, listOutboxEntries, sendOutboxEntry,
} from '../services/beeperOutbox.js';
import { BeeperApiError } from '../services/beeperClient.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/beeper', beeperRoutes);
  // The OAuth callback answers a BROWSER with a redirect to the Beeper tab, and
  // the test harness follows redirects, so stand in for the SPA route and
  // report where the browser actually landed — the user-visible outcome.
  app.get('/messages/beeper', (req, res) => res.json({ landedOn: req.originalUrl }));
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

  // A sweep in which every account failed throws SWEEP_FAILED rather than
  // resolving with a quietly non-zero `failedAccounts`, so this route reports
  // the failure instead of answering 200.
  it('maps an all-accounts-failed sweep to 502 rather than a 200 with a non-zero failedAccounts', async () => {
    vi.mocked(runBeeperSweep).mockRejectedValue(
      new BeeperApiError('Beeper sweep failed for all 3 accounts', { status: 502, code: 'SWEEP_FAILED', retryable: true }),
    );
    const res = await request(buildApp()).post('/api/beeper/sync');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SWEEP_FAILED');
  });
});

// The connect flow (#31): OAuth start → browser callback → paste alternative →
// disconnect, each asserted at the route boundary with the services mocked.
describe('POST /api/beeper/oauth/start', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds the redirect URI from the request origin, not a hardcoded localhost', async () => {
    vi.mocked(startBeeperOAuth).mockResolvedValue({ authorizationUrl: 'http://127.0.0.1:23373/oauth/authorize?x=1', redirectUri: 'x', state: 's' });
    const res = await request(buildApp())
      .post('/api/beeper/oauth/start')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'example.ts.net:5555');

    expect(res.status).toBe(200);
    expect(startBeeperOAuth).toHaveBeenCalledWith({
      redirectUri: 'https://example.ts.net:5555/api/beeper/oauth/callback',
      clientUri: 'https://example.ts.net:5555',
    });
  });

  it('maps a discovery failure to 502 and marks it non-retryable', async () => {
    vi.mocked(startBeeperOAuth).mockRejectedValue(
      new BeeperApiError('Beeper authorization-server metadata unavailable (404)', { status: 502, code: 'OAUTH_DISCOVERY_FAILED', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/oauth/start');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('OAUTH_DISCOVERY_FAILED');
    expect(res.body.context.retryable).toBe(false);
  });
});

describe('GET /api/beeper/oauth/callback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exchanges the code and redirects back to the Beeper tab', async () => {
    vi.mocked(completeBeeperOAuth).mockResolvedValue({ tokenConfigured: true, tokenSource: 'oauth', reachable: true });
    const res = await request(buildApp()).get('/api/beeper/oauth/callback?code=abc&state=xyz');
    expect(completeBeeperOAuth).toHaveBeenCalledWith({ code: 'abc', state: 'xyz' });
    expect(res.body.landedOn).toBe('/messages/beeper?beeperConnected=1');
  });

  // A browser lands here, so every outcome has to be a redirect the user can
  // read — never the JSON error envelope in the address bar.
  it('redirects with the reason when the exchange fails', async () => {
    vi.mocked(completeBeeperOAuth).mockRejectedValue(
      new BeeperApiError('Beeper token exchange failed (invalid_grant)', { status: 502, code: 'OAUTH_EXCHANGE_FAILED', retryable: false }),
    );
    const res = await request(buildApp()).get('/api/beeper/oauth/callback?code=abc&state=xyz');
    expect(res.body.landedOn).toContain('beeperOauthError=');
    expect(decodeURIComponent(res.body.landedOn)).toContain('invalid_grant');
  });

  it('redirects with the authorization server error when the user declines', async () => {
    const res = await request(buildApp()).get('/api/beeper/oauth/callback?error=access_denied');
    expect(decodeURIComponent(res.body.landedOn)).toContain('access_denied');
    expect(completeBeeperOAuth).not.toHaveBeenCalled();
  });

  it('redirects rather than 400s when code or state is missing', async () => {
    const res = await request(buildApp()).get('/api/beeper/oauth/callback?code=abc');
    expect(decodeURIComponent(res.body.landedOn)).toContain('Missing authorization code or state');
  });
});

describe('POST /api/beeper/token — the paste path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores a pasted token and answers with presence, expiry and provenance only', async () => {
    vi.mocked(connectWithPastedToken).mockResolvedValue({
      tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted', reachable: true, lastProbeError: null,
    });
    const res = await request(buildApp()).post('/api/beeper/token').send({ token: 'example-beeper-token' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted', reachable: true, lastProbeError: null,
    });
  });

  // Introspection says the token is not active: a 401 the client can act on,
  // marked non-retryable so nothing re-posts the same dead credential.
  it('maps a rejected token to 401 with retryable:false', async () => {
    vi.mocked(connectWithPastedToken).mockRejectedValue(
      new BeeperApiError('Beeper rejected that access token (introspection reports it is not active)', { status: 401, code: 'TOKEN_REJECTED', retryable: false }),
    );
    const res = await request(buildApp()).post('/api/beeper/token').send({ token: 'example-beeper-token' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_REJECTED');
    expect(res.body.context.retryable).toBe(false);
  });

  it('400s on an empty token instead of reaching the service', async () => {
    const res = await request(buildApp()).post('/api/beeper/token').send({ token: '   ' });
    expect(res.status).toBe(400);
    expect(connectWithPastedToken).not.toHaveBeenCalled();
  });

  it('rejects unknown fields, so nothing else can ride this write path', async () => {
    const res = await request(buildApp()).post('/api/beeper/token').send({ token: 'example-beeper-token', expiresAt: '2099-01-01' });
    expect(res.status).toBe(400);
    expect(connectWithPastedToken).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/beeper/token — disconnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the disconnected state', async () => {
    vi.mocked(disconnectBeeper).mockResolvedValue({ deleted: true, tokenConfigured: false, tokenExpiresAt: null, tokenSource: null });
    const res = await request(buildApp()).delete('/api/beeper/token');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, tokenConfigured: false });
  });

  it('is idempotent when nothing was stored', async () => {
    vi.mocked(disconnectBeeper).mockResolvedValue({ deleted: false, tokenConfigured: false, tokenExpiresAt: null, tokenSource: null });
    const res = await request(buildApp()).delete('/api/beeper/token');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
  });
});

// The #31 acceptance criterion, asserted rather than argued: "a grep of logs and
// of any client response for the token value returns nothing". This drives the
// whole connect → paste → status → disconnect surface with a known token value
// and greps every response body, every redirect Location, and everything the
// routes wrote to console.
describe('the token value never reaches a response or a log line', () => {
  const TOKEN = 'example-beeper-token-value-31';

  it('leaks nothing across connect, paste, status, check and disconnect', async () => {
    vi.clearAllMocks();
    const written = [];
    const capture = (...args) => written.push(args.map(String).join(' '));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(capture);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(capture);

    // Every mocked service behaves like the real one: it takes the token in and
    // hands back presence/expiry/provenance, never the value.
    vi.mocked(startBeeperOAuth).mockResolvedValue({ authorizationUrl: 'http://127.0.0.1:23373/oauth/authorize?state=s', redirectUri: 'r', state: 's' });
    vi.mocked(completeBeeperOAuth).mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'oauth', reachable: true });
    vi.mocked(connectWithPastedToken).mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted', reachable: true });
    vi.mocked(getBeeperStatus).mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted', reachable: true, accounts: [] });
    vi.mocked(checkBeeperConnection).mockResolvedValue({ reachable: true, info: { app: { name: 'Beeper' } } });
    vi.mocked(disconnectBeeper).mockResolvedValue({ deleted: true, tokenConfigured: false });

    const app = buildApp();
    const responses = [
      await request(app).post('/api/beeper/oauth/start'),
      await request(app).get('/api/beeper/oauth/callback?code=abc&state=s'),
      await request(app).post('/api/beeper/token').send({ token: TOKEN }),
      await request(app).get('/api/beeper/status'),
      await request(app).post('/api/beeper/status/check'),
      await request(app).delete('/api/beeper/token'),
    ];

    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();

    for (const res of responses) {
      // Covers the redirect's landing URL too — the callback app above reports
      // it as `landedOn`, so a token smuggled into a query param would show up.
      expect(JSON.stringify(res.body ?? null)).not.toContain(TOKEN);
      expect(res.text || '').not.toContain(TOKEN);
    }
    expect(written.join('\n')).not.toContain(TOKEN);
    // The service DID receive it — this is a leak test, not a plumbing bug.
    expect(connectWithPastedToken).toHaveBeenCalledWith(TOKEN);
  });
});

// The outbox routes (#36). The service's own gates are covered in
// `services/beeperOutbox.test.js`; this pins the HTTP contract the composer
// codes against — validation, the coded 4xx map, and `retryable: false` on
// every write path so a client can never turn one refusal into two messages.
describe('POST /api/beeper/outbox — step one, create the entry', () => {
  beforeEach(() => vi.clearAllMocks());
  const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

  it('creates an approved entry and answers 201', async () => {
    vi.mocked(createOutboxEntry).mockResolvedValue({ id: 'outbox-1', state: 'approved' });
    const res = await request(buildApp())
      .post('/api/beeper/outbox')
      .send({ conversationId: CONVERSATION_ID, body: 'hello there' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'outbox-1', state: 'approved' });
    expect(createOutboxEntry).toHaveBeenCalledWith({ conversationId: CONVERSATION_ID, body: 'hello there' });
  });

  it('400s a malformed body without touching the service', async () => {
    const res = await request(buildApp()).post('/api/beeper/outbox').send({ body: 'no conversation' });
    expect(res.status).toBe(400);
    expect(createOutboxEntry).not.toHaveBeenCalled();
  });
});

describe('POST /api/beeper/outbox/:id/send — step two, the send', () => {
  beforeEach(() => vi.clearAllMocks());
  const ENTRY_ID = '44444444-4444-4444-8444-444444444444';

  it('400s a malformed entry id before it reaches a query', async () => {
    const res = await request(buildApp()).post('/api/beeper/outbox/not-a-uuid/send').send({});
    expect(res.status).toBe(400);
    expect(sendOutboxEntry).not.toHaveBeenCalled();
  });

  it('passes the first-contact confirmation through explicitly', async () => {
    vi.mocked(sendOutboxEntry).mockResolvedValue({ id: 'outbox-1', state: 'awaiting-confirmation' });
    const res = await request(buildApp())
      .post(`/api/beeper/outbox/${ENTRY_ID}/send`)
      .send({ confirmFirstContact: true });
    expect(res.status).toBe(200);
    expect(sendOutboxEntry).toHaveBeenCalledWith(ENTRY_ID, { confirmFirstContact: true });
  });

  it('defaults the confirmation to false when the field is absent', async () => {
    vi.mocked(sendOutboxEntry).mockResolvedValue({ id: 'outbox-1', state: 'awaiting-confirmation' });
    await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/send`).send({});
    expect(sendOutboxEntry).toHaveBeenCalledWith(ENTRY_ID, { confirmFirstContact: false });
  });

  it('maps FIRST_CONTACT_CONFIRMATION_REQUIRED to a non-retryable 409', async () => {
    vi.mocked(sendOutboxEntry).mockRejectedValue(new BeeperApiError('confirm first contact', {
      status: 409, code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED', retryable: false,
    }));
    const res = await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/send`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FIRST_CONTACT_CONFIRMATION_REQUIRED');
    expect(res.body.context.retryable).toBe(false);
  });

  it('maps the open breaker to 429 and a transport failure to a non-retryable 503', async () => {
    vi.mocked(sendOutboxEntry).mockRejectedValue(new BeeperApiError('breaker open', {
      status: 429, code: 'OUTBOX_BREAKER_OPEN', retryable: false,
    }));
    const blocked = await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/send`).send({});
    expect(blocked.status).toBe(429);

    // status:0 on the source error — the mapper must never pass it through.
    vi.mocked(sendOutboxEntry).mockRejectedValue(new BeeperApiError('Beeper request failed', {
      status: 0, code: 'NETWORK_ERROR', retryable: false,
    }));
    const failed = await request(buildApp()).post(`/api/beeper/outbox/${ENTRY_ID}/send`).send({});
    expect(failed.status).toBe(503);
    expect(failed.body.context.retryable).toBe(false);
  });
});

describe('GET /api/beeper/outbox and the breaker reset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists one conversation\'s entries', async () => {
    vi.mocked(listOutboxEntries).mockResolvedValue([{ id: 'outbox-1', state: 'failed' }]);
    const res = await request(buildApp())
      .get('/api/beeper/outbox?conversationId=11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
  });

  it('clears the breaker on an explicit human POST', async () => {
    vi.mocked(clearOutboxBreaker).mockReturnValue({ tripped: false, reason: null });
    const res = await request(buildApp()).post('/api/beeper/outbox/breaker/clear');
    expect(res.status).toBe(200);
    expect(res.body.tripped).toBe(false);
    expect(clearOutboxBreaker).toHaveBeenCalledTimes(1);
  });
});
