import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('./beeperCredentials.js', () => ({
  saveBeeperCredential: vi.fn(),
  readBeeperCredential: vi.fn(),
  deleteBeeperCredential: vi.fn(),
  // beeperClient imports this; nothing here should ever reach it, since every
  // call in this flow passes an explicit token (or an explicit null).
  resolveBeeperToken: vi.fn(),
}));

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { mockJsonResponse } from '../lib/testHelper.js';
import { getSettings } from './settings.js';
import { deleteBeeperCredential, readBeeperCredential, saveBeeperCredential } from './beeperCredentials.js';
import {
  __resetPendingAuthorizationsForTests, completeBeeperOAuth, connectWithPastedToken,
  createPkcePair, disconnectBeeper, discoverAuthorizationServer, expiryFromTokenResponse,
  introspectToken, startBeeperOAuth,
} from './beeperOAuth.js';

// Metadata WITHOUT introspection — the fallback branch of the paste path.
const { introspection_endpoint: _omitted, ...METADATA_NO_INTROSPECTION } = {
  authorization_endpoint: '/oauth/authorize',
  token_endpoint: '/oauth/token',
  registration_endpoint: '/oauth/register',
  introspection_endpoint: '/oauth/introspect',
};

const BASE_URL = 'http://127.0.0.1:23373';
const REDIRECT_URI = 'https://example.com/api/beeper/oauth/callback';
// Placeholders — never a value observed on a real install.
const TOKEN = 'example-beeper-token';

const METADATA = {
  authorization_endpoint: '/oauth/authorize',
  token_endpoint: '/oauth/token',
  registration_endpoint: '/oauth/register',
  revocation_endpoint: '/oauth/revoke',
  introspection_endpoint: '/oauth/introspect',
  grant_types_supported: ['authorization_code'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['read', 'write'],
};

const INFO = { app: { name: 'Beeper', version: '4.3.73' }, server: { status: 'running' } };

const urlOf = (call) => String(call[0]);
const bodyOf = (call) => String(call[1]?.body ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  __resetPendingAuthorizationsForTests();
  vi.mocked(getSettings).mockResolvedValue({ beeper: { baseUrl: BASE_URL } });
  vi.mocked(saveBeeperCredential).mockImplementation(async ({ expiresAt = null, source }) => ({
    tokenConfigured: true, tokenExpiresAt: expiresAt, tokenSource: source,
  }));
});

// Discovery + registration + authorize, in the order the real flow runs them.
const mockConnectStart = ({ clientId = 'client-1' } = {}) => {
  vi.mocked(fetchWithTimeout)
    .mockResolvedValueOnce(mockJsonResponse(METADATA))
    .mockResolvedValueOnce(mockJsonResponse({ client_id: clientId }));
};

describe('createPkcePair', () => {
  it('produces a base64url S256 challenge derived from the verifier', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const expected = createHash('sha256').update(codeVerifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(codeChallenge).toBe(expected);
    expect(codeChallenge).not.toMatch(/[+/=]/);
    expect(codeVerifier).not.toBe(codeChallenge);
  });
});

describe('discoverAuthorizationServer', () => {
  it('resolves relative endpoints against the configured base URL', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(mockJsonResponse(METADATA));
    const discovery = await discoverAuthorizationServer();
    expect(urlOf(vi.mocked(fetchWithTimeout).mock.calls[0])).toBe(`${BASE_URL}/.well-known/oauth-authorization-server`);
    expect(discovery.tokenEndpoint).toBe(`${BASE_URL}/oauth/token`);
    expect(discovery.registrationEndpoint).toBe(`${BASE_URL}/oauth/register`);
    expect(discovery.revocationEndpoint).toBe(`${BASE_URL}/oauth/revoke`);
    expect(discovery.introspectionEndpoint).toBe(`${BASE_URL}/oauth/introspect`);
  });

  it('reports a null introspection endpoint when the server advertises none', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(mockJsonResponse(METADATA_NO_INTROSPECTION));
    await expect(discoverAuthorizationServer()).resolves.toMatchObject({ introspectionEndpoint: null });
  });

  // The base URL is user-editable (#30). Whatever answers on it must not be
  // able to name a different host as the token endpoint and collect the
  // authorization code.
  it('refuses metadata that points the token endpoint at another host', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(mockJsonResponse({
      ...METADATA, token_endpoint: 'https://example.com/oauth/token',
    }));
    await expect(discoverAuthorizationServer()).rejects.toMatchObject({ code: 'OAUTH_DISCOVERY_INVALID' });
  });

  it('accepts loopback spelled either way, since the default base URL is 127.0.0.1', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(mockJsonResponse({
      ...METADATA, token_endpoint: 'http://localhost:23373/oauth/token',
    }));
    await expect(discoverAuthorizationServer()).resolves.toMatchObject({
      tokenEndpoint: 'http://localhost:23373/oauth/token',
    });
  });

  it('refuses a server that advertises PKCE without S256', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(mockJsonResponse({
      ...METADATA, code_challenge_methods_supported: ['plain'],
    }));
    await expect(discoverAuthorizationServer()).rejects.toMatchObject({ code: 'OAUTH_DISCOVERY_INVALID' });
  });

  it('maps an unreachable Beeper Desktop to NETWORK_ERROR rather than a discovery fault', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    await expect(discoverAuthorizationServer()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });
});

describe('startBeeperOAuth', () => {
  it('registers as a public client and returns an S256 authorization URL carrying both scopes', async () => {
    mockConnectStart();
    const { authorizationUrl, state } = await startBeeperOAuth({ redirectUri: REDIRECT_URI, clientUri: 'https://example.com' });

    const registration = JSON.parse(bodyOf(vi.mocked(fetchWithTimeout).mock.calls[1]));
    expect(registration).toMatchObject({
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      redirect_uris: [REDIRECT_URI],
      scope: 'read write',
    });
    expect(registration.client_secret).toBeUndefined();

    const url = new URL(authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${BASE_URL}/oauth/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('state')).toBe(state);
    // The verifier is the half that must never leave the server.
    expect(url.searchParams.get('code_verifier')).toBeNull();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('reports a failed registration as OAUTH_REGISTRATION_FAILED', async () => {
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse(METADATA))
      .mockResolvedValueOnce(mockJsonResponse({ error: 'invalid_client_metadata' }, { ok: false, status: 400 }));
    await expect(startBeeperOAuth({ redirectUri: REDIRECT_URI })).rejects.toMatchObject({ code: 'OAUTH_REGISTRATION_FAILED' });
  });

  it('refuses to start without a redirect URI rather than inventing a localhost one', async () => {
    await expect(startBeeperOAuth({})).rejects.toMatchObject({ code: 'OAUTH_REDIRECT_URI_MISSING' });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe('completeBeeperOAuth', () => {
  it('exchanges the code with the PKCE verifier, vaults token + expiry, then probes /v1/info', async () => {
    mockConnectStart();
    const { authorizationUrl, state } = await startBeeperOAuth({ redirectUri: REDIRECT_URI });
    const challenge = new URL(authorizationUrl).searchParams.get('code_challenge');

    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse({ access_token: TOKEN, expires_in: 3600, scope: 'read write' }))
      .mockResolvedValueOnce(mockJsonResponse(INFO));

    const result = await completeBeeperOAuth({ code: 'auth-code', state });

    const exchange = vi.mocked(fetchWithTimeout).mock.calls[2];
    expect(urlOf(exchange)).toBe(`${BASE_URL}/oauth/token`);
    const form = new URLSearchParams(bodyOf(exchange));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code');
    expect(form.get('client_id')).toBe('client-1');
    // The verifier sent must be the pre-image of the challenge the browser saw.
    const verifier = form.get('code_verifier');
    expect(createHash('sha256').update(verifier).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).toBe(challenge);

    expect(saveBeeperCredential).toHaveBeenCalledWith(expect.objectContaining({
      token: TOKEN, source: 'oauth', scopes: ['read', 'write'], clientId: 'client-1',
    }));
    expect(vi.mocked(saveBeeperCredential).mock.calls[0][0].expiresAt).toMatch(/^\d{4}-/);
    expect(result).toMatchObject({ tokenConfigured: true, tokenSource: 'oauth', reachable: true });
    // Presence and provenance only — never the value.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('reports connected with reachable:false when Beeper Desktop is closed after a successful exchange', async () => {
    mockConnectStart();
    const { state } = await startBeeperOAuth({ redirectUri: REDIRECT_URI });
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse({ access_token: TOKEN }))
      .mockRejectedValueOnce(new Error('fetch failed'));

    const result = await completeBeeperOAuth({ code: 'auth-code', state });
    expect(saveBeeperCredential).toHaveBeenCalled();
    expect(result.reachable).toBe(false);
    expect(result.lastProbeError).toBeTruthy();
  });

  // No `expires_in` in the response means no expiry to store — not "expired",
  // and not a guessed default.
  it('stores a null expiry when the token response carries no expires_in', async () => {
    mockConnectStart();
    const { state } = await startBeeperOAuth({ redirectUri: REDIRECT_URI });
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse({ access_token: TOKEN }))
      .mockResolvedValueOnce(mockJsonResponse(INFO));
    await completeBeeperOAuth({ code: 'auth-code', state });
    expect(vi.mocked(saveBeeperCredential).mock.calls[0][0].expiresAt).toBeNull();
  });

  it('rejects an unknown state and never exchanges the code', async () => {
    await expect(completeBeeperOAuth({ code: 'auth-code', state: 'not-a-real-state' }))
      .rejects.toMatchObject({ code: 'OAUTH_STATE_UNKNOWN', status: 400 });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  // The authorization code is single-use: a replayed callback must not re-run
  // the exchange (Beeper would reject it, and a retry is never safe).
  it('consumes the state so a replayed callback cannot re-exchange', async () => {
    mockConnectStart();
    const { state } = await startBeeperOAuth({ redirectUri: REDIRECT_URI });
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse({ access_token: TOKEN }))
      .mockResolvedValueOnce(mockJsonResponse(INFO));
    await completeBeeperOAuth({ code: 'auth-code', state });
    await expect(completeBeeperOAuth({ code: 'auth-code', state })).rejects.toMatchObject({ code: 'OAUTH_STATE_UNKNOWN' });
  });

  it('surfaces the RFC 6749 error code on a failed exchange and stores nothing', async () => {
    mockConnectStart();
    const { state } = await startBeeperOAuth({ redirectUri: REDIRECT_URI });
    vi.mocked(fetchWithTimeout).mockResolvedValueOnce(
      mockJsonResponse({ error: 'invalid_grant', error_description: 'code expired' }, { ok: false, status: 400 }),
    );
    await expect(completeBeeperOAuth({ code: 'auth-code', state }))
      .rejects.toMatchObject({ code: 'OAUTH_EXCHANGE_FAILED', message: expect.stringContaining('invalid_grant') });
    expect(saveBeeperCredential).not.toHaveBeenCalled();
  });
});

describe('expiryFromTokenResponse', () => {
  it('turns expires_in seconds into an absolute instant, and anything else into null', () => {
    const now = Date.parse('2026-09-03T00:00:00.000Z');
    expect(expiryFromTokenResponse({ expires_in: 3600 }, now)).toBe('2026-09-03T01:00:00.000Z');
    expect(expiryFromTokenResponse({}, now)).toBeNull();
    expect(expiryFromTokenResponse({ expires_in: 'soon' }, now)).toBeNull();
    expect(expiryFromTokenResponse({ expires_in: 0 }, now)).toBeNull();
  });
});

describe('introspectToken', () => {
  it('reads active, exp and scope, and treats an absent exp as no expiry', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(mockJsonResponse({
      active: true, scope: 'read write', exp: Math.floor(Date.parse('2026-12-01T00:00:00.000Z') / 1000),
    }));
    await expect(introspectToken(TOKEN, { introspectionEndpoint: `${BASE_URL}/oauth/introspect` })).resolves.toEqual({
      active: true, expiresAt: '2026-12-01T00:00:00.000Z', scopes: ['read', 'write'],
    });
    const call = vi.mocked(fetchWithTimeout).mock.calls[0];
    expect(new URLSearchParams(bodyOf(call)).get('token')).toBe(TOKEN);
  });

  it('reports inactive without inventing an expiry', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(mockJsonResponse({ active: false }));
    await expect(introspectToken(TOKEN, { introspectionEndpoint: `${BASE_URL}/oauth/introspect` }))
      .resolves.toEqual({ active: false, expiresAt: null, scopes: [] });
  });
});

// The paste path must EXERCISE the credential. /v1/info also answers
// unauthenticated, so probing it would store a bogus token as connected —
// introspection (or, failing that, a call that requires the bearer) is what
// makes "saved" mean "Beeper accepted this".
describe('connectWithPastedToken', () => {
  it('introspects the pasted token, then vaults it with the expiry and scopes introspection reported', async () => {
    const exp = Math.floor(Date.parse('2026-12-01T00:00:00.000Z') / 1000);
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse(METADATA))
      .mockResolvedValueOnce(mockJsonResponse({ active: true, scope: 'read write', exp }));

    const result = await connectWithPastedToken(`  ${TOKEN}  `);

    const introspect = vi.mocked(fetchWithTimeout).mock.calls[1];
    expect(urlOf(introspect)).toBe(`${BASE_URL}/oauth/introspect`);
    expect(new URLSearchParams(bodyOf(introspect)).get('token')).toBe(TOKEN);
    expect(saveBeeperCredential).toHaveBeenCalledWith({
      token: TOKEN, expiresAt: '2026-12-01T00:00:00.000Z', scopes: ['read', 'write'], source: 'pasted',
    });
    expect(result).toMatchObject({ tokenConfigured: true, tokenSource: 'pasted', reachable: true });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  // A no-expiry token — the credential this path exists for — introspects
  // active with no `exp` at all, which must stay `null`, never a guess.
  it('stores a null expiry for an active token introspection reports no exp for', async () => {
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse(METADATA))
      .mockResolvedValueOnce(mockJsonResponse({ active: true, scope: 'read write' }));
    const result = await connectWithPastedToken(TOKEN);
    expect(vi.mocked(saveBeeperCredential).mock.calls[0][0].expiresAt).toBeNull();
    expect(result.tokenExpiresAt).toBeNull();
  });

  it('refuses an inactive token and stores nothing', async () => {
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse(METADATA))
      .mockResolvedValueOnce(mockJsonResponse({ active: false }));
    await expect(connectWithPastedToken(TOKEN)).rejects.toMatchObject({ code: 'TOKEN_REJECTED', status: 401 });
    expect(saveBeeperCredential).not.toHaveBeenCalled();
  });

  it('surfaces a failed introspection call rather than storing the token anyway', async () => {
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse(METADATA))
      .mockResolvedValueOnce(mockJsonResponse({ error: 'server_error' }, { ok: false, status: 500 }));
    await expect(connectWithPastedToken(TOKEN)).rejects.toMatchObject({ code: 'OAUTH_INTROSPECTION_FAILED' });
    expect(saveBeeperCredential).not.toHaveBeenCalled();
  });

  describe('without an introspection endpoint', () => {
    it('falls back to an authenticated call (never /v1/info) and stores on success', async () => {
      vi.mocked(fetchWithTimeout)
        .mockResolvedValueOnce(mockJsonResponse(METADATA_NO_INTROSPECTION))
        .mockResolvedValueOnce(mockJsonResponse([{ accountID: 'acct-1', network: 'Example Network' }]));

      const result = await connectWithPastedToken(TOKEN);

      const probe = vi.mocked(fetchWithTimeout).mock.calls[1];
      expect(urlOf(probe)).toBe(`${BASE_URL}/v1/accounts`);
      expect(probe[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(saveBeeperCredential).toHaveBeenCalledWith({
        token: TOKEN, expiresAt: null, scopes: [], source: 'pasted',
      });
      expect(result).toMatchObject({ tokenConfigured: true, tokenSource: 'pasted' });
    });

    it('stores nothing when the authenticated call rejects the token', async () => {
      vi.mocked(fetchWithTimeout)
        .mockResolvedValueOnce(mockJsonResponse(METADATA_NO_INTROSPECTION))
        .mockResolvedValue(mockJsonResponse({ message: 'unauthorized' }, { ok: false, status: 401 }));
      await expect(connectWithPastedToken(TOKEN)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(saveBeeperCredential).not.toHaveBeenCalled();
    });

    it('stores nothing when the base URL answers 200 with something that is not Beeper', async () => {
      vi.mocked(fetchWithTimeout)
        .mockResolvedValueOnce(mockJsonResponse(METADATA_NO_INTROSPECTION))
        .mockResolvedValueOnce(mockJsonResponse({ hello: 'other service' }));
      await expect(connectWithPastedToken(TOKEN)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
      expect(saveBeeperCredential).not.toHaveBeenCalled();
    });
  });

  it('rejects an empty token without a network call', async () => {
    await expect(connectWithPastedToken('   ')).rejects.toMatchObject({ code: 'TOKEN_REQUIRED', status: 400 });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(saveBeeperCredential).not.toHaveBeenCalled();
  });
});

describe('disconnectBeeper', () => {
  it('revokes an OAuth credential at the authorization server, then deletes the local copy', async () => {
    vi.mocked(readBeeperCredential).mockResolvedValue({ token: TOKEN, tokenSource: 'oauth', clientId: 'client-1' });
    vi.mocked(deleteBeeperCredential).mockResolvedValue({ deleted: true, tokenConfigured: false });
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(mockJsonResponse(METADATA))
      .mockResolvedValueOnce(mockJsonResponse({}));

    await expect(disconnectBeeper()).resolves.toMatchObject({ deleted: true, tokenConfigured: false });
    const revoke = vi.mocked(fetchWithTimeout).mock.calls[1];
    expect(urlOf(revoke)).toBe(`${BASE_URL}/oauth/revoke`);
    expect(new URLSearchParams(bodyOf(revoke)).get('client_id')).toBe('client-1');
    expect(deleteBeeperCredential).toHaveBeenCalled();
  });

  // A user asking to disconnect must always end up disconnected, whatever the
  // authorization server does.
  it('still deletes the local copy when revocation fails', async () => {
    vi.mocked(readBeeperCredential).mockResolvedValue({ token: TOKEN, tokenSource: 'oauth', clientId: 'client-1' });
    vi.mocked(deleteBeeperCredential).mockResolvedValue({ deleted: true, tokenConfigured: false });
    vi.mocked(fetchWithTimeout).mockRejectedValue(new Error('fetch failed'));
    await expect(disconnectBeeper()).resolves.toMatchObject({ deleted: true });
    expect(deleteBeeperCredential).toHaveBeenCalled();
  });

  it('skips revocation for a pasted token, which has no registered client', async () => {
    vi.mocked(readBeeperCredential).mockResolvedValue({ token: TOKEN, tokenSource: 'pasted', clientId: '' });
    vi.mocked(deleteBeeperCredential).mockResolvedValue({ deleted: true, tokenConfigured: false });
    await expect(disconnectBeeper()).resolves.toMatchObject({ deleted: true });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});
