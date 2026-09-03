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

import beeperRoutes from './beeper.js';
import { getBeeperStatus, checkBeeperConnection } from '../services/beeperStatus.js';
import {
  completeBeeperOAuth, connectWithPastedToken, disconnectBeeper, startBeeperOAuth,
} from '../services/beeperOAuth.js';
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
