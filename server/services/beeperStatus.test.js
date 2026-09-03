import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  ensureSchema: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
vi.mock('./beeperCredentials.js', () => ({ resolveBeeperTokenMeta: vi.fn() }));
vi.mock('./beeperClient.js', async () => {
  const actual = await vi.importActual('./beeperClient.js');
  return { ...actual, probeBeeperInfo: vi.fn(), getInfo: vi.fn() };
});

import { query } from '../lib/db.js';
import { getSettings } from './settings.js';
import { resolveBeeperTokenMeta } from './beeperCredentials.js';
import { probeBeeperInfo, getInfo, BeeperApiError } from './beeperClient.js';
import { getBeeperStatus, checkBeeperConnection, listBeeperAccounts } from './beeperStatus.js';

// Credential presence now comes from the vaulted store (#31), never from
// settings — these helpers keep each case saying which of the two it means.
const noCredential = () => vi.mocked(resolveBeeperTokenMeta)
  .mockResolvedValue({ tokenConfigured: false, tokenExpiresAt: null, tokenSource: null });
const credential = (overrides = {}) => vi.mocked(resolveBeeperTokenMeta)
  .mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'oauth', ...overrides });

describe('listBeeperAccounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the mirrored account roster', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ accountId: 'acc1', network: 'whatsapp', displayName: 'Example', status: 'connected', bridgeId: 'b1', lastSeenAt: null }] });
    const accounts = await listBeeperAccounts();
    expect(accounts).toEqual([{ accountId: 'acc1', network: 'whatsapp', displayName: 'Example', status: 'connected', bridgeId: 'b1', lastSeenAt: null }]);
  });

  it('returns an empty array (a trustworthy "no accounts yet") rather than throwing on an unexpected result shape', async () => {
    vi.mocked(query).mockResolvedValue({});
    expect(await listBeeperAccounts()).toEqual([]);
  });
});

describe('getBeeperStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports reachable:null (never false) and skips the probe entirely when no token is configured', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    noCredential();
    vi.mocked(query).mockResolvedValue({ rows: [] });

    const status = await getBeeperStatus();

    expect(status.tokenConfigured).toBe(false);
    expect(status.reachable).toBeNull();
    expect(probeBeeperInfo).not.toHaveBeenCalled();
  });

  it('probes and reports reachable:true with account roster and app version when a token is configured and reachable', async () => {
    vi.mocked(getSettings).mockResolvedValue({ beeper: { baseUrl: 'http://127.0.0.1:23373' } });
    credential({ tokenSource: 'pasted' });
    vi.mocked(probeBeeperInfo).mockResolvedValue({ reachable: true, info: { app: { name: 'Beeper', version: '4.3.73' } }, error: null });
    vi.mocked(query).mockResolvedValue({ rows: [{ accountId: 'acc1' }] });

    const status = await getBeeperStatus();

    expect(status.tokenConfigured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.appVersion).toBe('4.3.73');
    expect(status.accounts).toEqual([{ accountId: 'acc1' }]);
    expect(probeBeeperInfo).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:23373' });
  });

  it('reports reachable:false with lastProbeError when a token is configured but unreachable', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    credential();
    vi.mocked(probeBeeperInfo).mockResolvedValue({ reachable: false, info: null, error: 'connection refused' });
    vi.mocked(query).mockResolvedValue({ rows: [] });

    const status = await getBeeperStatus();

    expect(status.reachable).toBe(false);
    expect(status.lastProbeError).toBe('connection refused');
  });

  it('never throws when the account-roster query fails — degrades to an empty roster', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    noCredential();
    vi.mocked(query).mockRejectedValue(new Error('db unavailable'));

    const status = await getBeeperStatus();
    expect(status.accounts).toEqual([]);
  });

  it('warns when the stored token expiry is within 7 days', async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(getSettings).mockResolvedValue({});
    credential({ tokenExpiresAt: soon });
    vi.mocked(probeBeeperInfo).mockResolvedValue({ reachable: true, info: {}, error: null });
    vi.mocked(query).mockResolvedValue({ rows: [] });

    const status = await getBeeperStatus();
    expect(status.tokenExpiringSoon).toBe(true);
  });

  it('does not warn when the stored token expiry is far away', async () => {
    const far = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(getSettings).mockResolvedValue({});
    credential({ tokenExpiresAt: far });
    vi.mocked(probeBeeperInfo).mockResolvedValue({ reachable: true, info: {}, error: null });
    vi.mocked(query).mockResolvedValue({ rows: [] });

    const status = await getBeeperStatus();
    expect(status.tokenExpiringSoon).toBe(false);
  });

  it('surfaces how the credential was obtained, and never anything else about it', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    credential({ tokenSource: 'pasted' });
    vi.mocked(probeBeeperInfo).mockResolvedValue({ reachable: true, info: {}, error: null });
    vi.mocked(query).mockResolvedValue({ rows: [] });

    const status = await getBeeperStatus();
    expect(status.tokenSource).toBe('pasted');
    expect(Object.keys(status)).not.toContain('token');
  });

  // There is no refresh grant, so an expired token is its own actionable
  // RE-CONNECT state, distinct from "expiring soon" and from any API failure.
  it('reports tokenExpired for a lapsed token, distinctly from tokenExpiringSoon', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    credential({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    vi.mocked(probeBeeperInfo).mockResolvedValue({ reachable: true, info: {}, error: null });
    vi.mocked(query).mockResolvedValue({ rows: [] });

    const status = await getBeeperStatus();
    expect(status.tokenExpired).toBe(true);
    expect(status.tokenExpiringSoon).toBe(true);
  });

  it('leaves both expiry flags false for a no-expiry pasted token', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    credential({ tokenExpiresAt: null, tokenSource: 'pasted' });
    vi.mocked(probeBeeperInfo).mockResolvedValue({ reachable: true, info: {}, error: null });
    vi.mocked(query).mockResolvedValue({ rows: [] });

    const status = await getBeeperStatus();
    expect(status.tokenExpired).toBe(false);
    expect(status.tokenExpiringSoon).toBe(false);
    expect(status.tokenExpiresAt).toBeNull();
  });

  // #11 decision 8: an unreadable credential store must NOT read as "no token
  // configured" — the card renders its error branch instead of telling a
  // connected install to connect again.
  it('propagates an unreadable credential store rather than reporting tokenConfigured:false', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    vi.mocked(resolveBeeperTokenMeta).mockRejectedValue(new Error('Malformed vault ciphertext'));
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await expect(getBeeperStatus()).rejects.toThrow(/vault ciphertext/);
  });
});

describe('checkBeeperConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws a typed NOT_CONFIGURED BeeperApiError when no token is configured', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    noCredential();
    await expect(checkBeeperConnection()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(getInfo).not.toHaveBeenCalled();
  });

  it('propagates a NETWORK_ERROR from a live probe', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    credential();
    vi.mocked(getInfo).mockRejectedValue(new BeeperApiError('Beeper request failed', { status: 0, code: 'NETWORK_ERROR', retryable: false }));
    await expect(checkBeeperConnection()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws MALFORMED_RESPONSE on an unexpected /v1/info shape', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    credential();
    vi.mocked(getInfo).mockResolvedValue({ unexpected: true });
    await expect(checkBeeperConnection()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('resolves reachable:true on a well-shaped live probe', async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    credential();
    vi.mocked(getInfo).mockResolvedValue({ app: { name: 'Beeper' }, server: { status: 'running' } });
    await expect(checkBeeperConnection()).resolves.toMatchObject({ reachable: true });
  });
});
