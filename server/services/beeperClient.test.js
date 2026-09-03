import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSettings } from './settings.js';
import {
  BeeperApiError,
  DEFAULT_BASE_URL,
  resolveBeeperConfig,
  mapBeeperResponseError,
  paginateBeeperCursor,
  listChatsPage,
  listChats,
  listMessages,
  searchMessagesPage,
  getInfo,
  probeBeeperInfo,
  getAccounts,
  getBridges,
  joinAccountsWithBridges,
  getJoinedAccounts,
  sendMessage,
  editMessage,
  deleteMessage,
  downloadAsset,
} from './beeperClient.js';

// resolveBeeperConfig only touches settings.js when EITHER baseUrl or token is
// omitted; every other test in this file passes both explicitly and never
// exercises this mock, so it's safe to hoist for the whole file.
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));

// A fixture-shaped fake Response, matching what readResponseJson consumes
// (only `.text()` is read; `.ok`/`.status` drive the beeperRequest branch).
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe('beeperClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Config resolution
  // -------------------------------------------------------------------------

  describe('resolveBeeperConfig', () => {
    it('defaults the base URL and reports no token when neither is configured', async () => {
      vi.mocked(getSettings).mockResolvedValue({});
      const config = await resolveBeeperConfig();
      expect(config).toEqual({ baseUrl: DEFAULT_BASE_URL, token: null });
    });

    it('reads settings.beeper.{baseUrl,token} when the caller supplies neither', async () => {
      vi.mocked(getSettings).mockResolvedValue({ beeper: { baseUrl: 'http://127.0.0.1:23373/', token: '  secret-token  ' } });
      const config = await resolveBeeperConfig();
      expect(config).toEqual({ baseUrl: 'http://127.0.0.1:23373', token: 'secret-token' });
    });

    it('an explicit baseUrl + token bypasses settings entirely', async () => {
      const config = await resolveBeeperConfig({ baseUrl: 'http://127.0.0.1:9999/', token: 'abc123' });
      expect(config).toEqual({ baseUrl: 'http://127.0.0.1:9999', token: 'abc123' });
    });

    it('an explicit token of null is honored as "deliberately unauthenticated", not "unset"', async () => {
      const config = await resolveBeeperConfig({ baseUrl: DEFAULT_BASE_URL, token: null });
      expect(config.token).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 502-is-terminal mapping
  // -------------------------------------------------------------------------

  describe('mapBeeperResponseError', () => {
    it('maps a 502 from an asset endpoint to the terminal ASSET_UNAVAILABLE', () => {
      const err = mapBeeperResponseError(502, { message: 'Failed to download asset: Transfer failed for mxc://abc', code: 'BRIDGE_ERROR' }, { isAssetEndpoint: true });
      expect(err).toBeInstanceOf(BeeperApiError);
      expect(err.code).toBe('ASSET_UNAVAILABLE');
      expect(err.retryable).toBe(false);
    });

    it('maps a 502 from a non-asset endpoint to the ordinarily-retryable UPSTREAM_ERROR', () => {
      const err = mapBeeperResponseError(502, { message: 'bridge unavailable' }, { isAssetEndpoint: false });
      expect(err.code).toBe('UPSTREAM_ERROR');
      expect(err.retryable).toBe(true);
    });

    it('maps 401 to a non-retryable UNAUTHORIZED', () => {
      const err = mapBeeperResponseError(401, { message: 'Unauthorized: Invalid or missing token', code: 'unauthorized' });
      expect(err.code).toBe('UNAUTHORIZED');
      expect(err.retryable).toBe(false);
    });

    it('downloadAsset end-to-end surfaces ASSET_UNAVAILABLE on a live 502', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        jsonResponse(502, { message: 'Failed to download asset: Transfer failed for mxc://gone', code: 'BRIDGE_ERROR' }),
      ));
      await expect(downloadAsset('mxc://gone', { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE', retryable: false });
    });
  });

  // -------------------------------------------------------------------------
  // Cursor pagination / exhaustion
  // -------------------------------------------------------------------------

  describe('paginateBeeperCursor', () => {
    it('walks every page until hasMore is false', async () => {
      const pages = [
        { items: ['a', 'b'], hasMore: true, oldestCursor: 'c1', newestCursor: null },
        { items: ['c'], hasMore: true, oldestCursor: 'c2', newestCursor: null },
        { items: ['d'], hasMore: false, oldestCursor: null, newestCursor: null },
      ];
      const fetchPage = vi.fn(async ({ cursor }) => {
        if (!cursor) return pages[0];
        if (cursor === 'c1') return pages[1];
        if (cursor === 'c2') return pages[2];
        throw new Error(`unexpected cursor ${cursor}`);
      });

      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);

      expect(collected).toEqual(['a', 'b', 'c', 'd']);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it('stops (does not loop forever) when hasMore is true but the walked cursor is null', async () => {
      const fetchPage = vi.fn(async () => ({ items: ['only'], hasMore: true, oldestCursor: null, newestCursor: null }));
      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);
      expect(collected).toEqual(['only']);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('stops (does not loop forever) when a server echoes back the same cursor it was just called with', async () => {
      // hasMore stays true and oldestCursor never advances past 'stuck' — a
      // naive loop would walk in place forever.
      const fetchPage = vi.fn(async () => ({ items: ['x'], hasMore: true, oldestCursor: 'stuck', newestCursor: null }));
      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);
      expect(collected).toEqual(['x', 'x']);
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it('yields nothing and makes one call for a single empty page', async () => {
      const fetchPage = vi.fn(async () => ({ items: [], hasMore: false }));
      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage)) collected.push(item);
      expect(collected).toEqual([]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('walks newestCursor when direction is "after"', async () => {
      const fetchPage = vi.fn(async ({ cursor }) => (!cursor
        ? { items: [1], hasMore: true, oldestCursor: null, newestCursor: 'n1' }
        : { items: [2], hasMore: false }));
      const collected = [];
      for await (const item of paginateBeeperCursor(fetchPage, { direction: 'after' })) collected.push(item);
      expect(collected).toEqual([1, 2]);
      expect(fetchPage).toHaveBeenNthCalledWith(2, { cursor: 'n1', direction: 'after' });
    });

    it('listChats/listMessages iterators drive listChatsPage/listMessagesPage across real HTTP pages', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'chat1' }], hasMore: true, oldestCursor: 'cur1' }))
        .mockResolvedValueOnce(jsonResponse(200, { items: [{ id: 'chat2' }], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      const chats = [];
      for await (const chat of listChats({ baseUrl: DEFAULT_BASE_URL, token: 't' })) chats.push(chat);
      expect(chats.map((c) => c.id)).toEqual(['chat1', 'chat2']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain('cursor=cur1');
    });
  });

  // -------------------------------------------------------------------------
  // Timeout behaviour with injected time (no real sleeps)
  // -------------------------------------------------------------------------

  describe('timeout behavior (fake timers)', () => {
    it('probeBeeperInfo caps at 1s and resolves reachable:false without throwing, and without a real sleep', async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })));

        const probePromise = probeBeeperInfo({ baseUrl: DEFAULT_BASE_URL });
        // Advance virtual time only — a real 1s sleep here would fail CI timing
        // budgets and defeats the point of injected time.
        await vi.advanceTimersByTimeAsync(1000);
        const result = await probePromise;

        expect(result.reachable).toBe(false);
        expect(result.error).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a read call (allowRetry) retries a replayable connection error using injected delay, not a real sleep', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi.fn()
          .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
          .mockResolvedValueOnce(jsonResponse(200, { items: [], hasMore: false }));
        vi.stubGlobal('fetch', fetchMock);

        const promise = listChatsPage({ baseUrl: DEFAULT_BASE_URL, token: 't' });
        // Let the first attempt's rejection settle, then advance past the
        // retry delay entirely in virtual time.
        await vi.advanceTimersByTimeAsync(400);
        const result = await promise;

        expect(result).toEqual({ items: [], hasMore: false });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('getInfo does not retry (unauthenticated probe, no allowRetry) — a connection error surfaces immediately', async () => {
      const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(getInfo({ baseUrl: DEFAULT_BASE_URL })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Send-safe retries
  // -------------------------------------------------------------------------

  describe('send-safe retries', () => {
    it('sendMessage does NOT retry a replayable connection error — a retry would duplicate a real message', async () => {
      const fetchMock = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(sendMessage('chat1', { text: 'hi' }, { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sendMessage rejects with retryable: false on a 429 too — a write\'s thrown error must never advertise retry-safety, regardless of status', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, { message: 'Too Many Requests' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(sendMessage('chat1', { text: 'hi' }, { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('editMessage rejects with retryable: false on a 502 — same write send-safety posture as sendMessage', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(502, { message: 'Bad Gateway' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(editMessage('chat1', 'msg1', 'edited text', { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a read call (allowRetry) still surfaces retryable: true on a 500 — the write clamp above must not leak into reads', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { message: 'Internal Server Error' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(listChatsPage({ baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
    });

    it('deleteMessage requires an explicit boolean forEveryone and never calls fetch without one', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(deleteMessage('chat1', 'msg1', undefined, { baseUrl: DEFAULT_BASE_URL, token: 't' }))
        .rejects.toMatchObject({ code: 'FOR_EVERYONE_REQUIRED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('deleteMessage passes forEveryone=false explicitly in the query string', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
      vi.stubGlobal('fetch', fetchMock);

      await deleteMessage('chat1', 'msg1', false, { baseUrl: DEFAULT_BASE_URL, token: 't' });
      expect(fetchMock.mock.calls[0][0]).toContain('forEveryone=false');
    });
  });

  // -------------------------------------------------------------------------
  // Accounts / bridges join on a fixture where the `network` join is zero rows
  // -------------------------------------------------------------------------

  describe('joinAccountsWithBridges', () => {
    // Deliberately fake identifiers per repo privacy rules — no real handles,
    // phone numbers, hostnames, or message bodies. `user` is shaped like the
    // live `Account.user` (a `User`, per `GET /v1/spec`) — carrying its own
    // `phoneNumber`/`email`/`fullName` — so a test against this fixture would
    // actually catch a leak of those fields, not just of the flat `id` the
    // old `{ id: 'user-1' }` fixture had no way to catch.
    const accounts = [
      {
        accountID: 'discordgo',
        network: 'Discord', // display name
        status: 'connected',
        loginID: '+15550000001', // must never survive into the joined output
        user: {
          id: 'user-1',
          username: 'example-user-1',
          isSelf: true,
          phoneNumber: '+15550000001', // deliberately SURVIVES — fork issue #10 needs it
          email: 'alice@example.com', // deliberately SURVIVES
          fullName: 'Alice Example', // deliberately SURVIVES
        },
      },
      {
        accountID: 'local-whatsapp_ba_example',
        network: 'WhatsApp', // display name
        status: 'connection_required',
        loginID: '+15550000002',
        user: {
          id: 'user-2',
          username: 'example-user-2',
          isSelf: true,
          phoneNumber: '+15550000002',
          email: 'bob@example.com',
          fullName: 'Bob Example',
        },
      },
      {
        accountID: 'orphan-account',
        network: 'Mystery Network',
        status: 'connected',
        // no matching bridge below — must be tolerated, not dropped
      },
    ];

    const bridgesResponse = {
      items: [
        {
          id: 'bridge-discord',
          network: 'discord', // lowercase slug — differs from account.network 'Discord'
          status: 'connected',
          statusText: 'Connected',
          supportsMultipleAccounts: false,
          activeAccountCount: 3, // must never survive — documented to over-report
          accounts: [{ accountID: 'discordgo', loginID: '+15550000001', user: { id: 'user-1', phoneNumber: '+15550000001' } }],
        },
        {
          id: 'bridge-whatsapp',
          network: 'whatsapp', // lowercase slug — differs from account.network 'WhatsApp'
          status: 'connection_required',
          statusText: null,
          activeAccountCount: 1,
          accounts: [{ accountID: 'local-whatsapp_ba_example', loginID: '+15550000002', user: { id: 'user-2', phoneNumber: '+15550000002' } }],
        },
      ],
    };

    it('joins on accountID even though every account.network differs from its bridge.network (the network join is zero rows)', () => {
      // Prove the trap: naive equality on network would match nothing.
      const naiveMatches = accounts.filter((a) => bridgesResponse.items.some((b) => b.network === a.network));
      expect(naiveMatches).toHaveLength(0);

      const joined = joinAccountsWithBridges(accounts, bridgesResponse);
      const discord = joined.find((a) => a.accountID === 'discordgo');
      const whatsapp = joined.find((a) => a.accountID === 'local-whatsapp_ba_example');

      expect(discord.bridgeId).toBe('bridge-discord');
      expect(discord.statusText).toBe('Connected');
      expect(whatsapp.bridgeId).toBe('bridge-whatsapp');
      expect(whatsapp.statusText).toBeNull();
    });

    it('tolerates an account with no matching bridge', () => {
      const joined = joinAccountsWithBridges(accounts, bridgesResponse);
      const orphan = joined.find((a) => a.accountID === 'orphan-account');
      expect(orphan).toMatchObject({ bridgeId: null, bridgeStatus: null, statusText: null });
    });

    it('never surfaces loginID in the joined output', () => {
      const joined = joinAccountsWithBridges(accounts, bridgesResponse);
      for (const account of joined) expect(account).not.toHaveProperty('loginID');
    });

    it('strips ONLY loginID — nested user.phoneNumber/email/fullName deliberately survive the join (fork issue #10 needs user.phoneNumber for Tribe identity)', () => {
      const joined = joinAccountsWithBridges(accounts, bridgesResponse);
      const discord = joined.find((a) => a.accountID === 'discordgo');
      expect(discord).not.toHaveProperty('loginID');
      expect(discord.user).toMatchObject({
        phoneNumber: '+15550000001',
        email: 'alice@example.com',
        fullName: 'Alice Example',
      });
    });

    it('getAccounts / getBridges strip loginID and activeAccountCount at the client boundary too, before any join — but deliberately leave nested user PII (phoneNumber/email/fullName) intact', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, accounts))
        .mockResolvedValueOnce(jsonResponse(200, bridgesResponse));
      vi.stubGlobal('fetch', fetchMock);

      const [gotAccounts, gotBridges] = await Promise.all([
        getAccounts({ baseUrl: DEFAULT_BASE_URL, token: 't' }),
        getBridges({ baseUrl: DEFAULT_BASE_URL, token: 't' }),
      ]);

      for (const account of gotAccounts) expect(account).not.toHaveProperty('loginID');
      expect(gotAccounts.find((a) => a.accountID === 'discordgo').user).toMatchObject({ phoneNumber: '+15550000001' });

      for (const bridge of gotBridges.items) {
        expect(bridge).not.toHaveProperty('activeAccountCount');
        for (const account of bridge.accounts) expect(account).not.toHaveProperty('loginID');
      }
      expect(gotBridges.items[0].accounts[0].user).toMatchObject({ phoneNumber: '+15550000001' });
    });

    it('getJoinedAccounts wires getAccounts + getBridges through the fetch layer end-to-end', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse(200, accounts))
        .mockResolvedValueOnce(jsonResponse(200, bridgesResponse));
      vi.stubGlobal('fetch', fetchMock);

      const joined = await getJoinedAccounts({ baseUrl: DEFAULT_BASE_URL, token: 't' });
      expect(joined.find((a) => a.accountID === 'discordgo').bridgeId).toBe('bridge-discord');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Search endpoint limit clamping (limit max 20 on /v1/messages/search)
  // -------------------------------------------------------------------------

  describe('searchMessagesPage limit clamping', () => {
    it('clamps an over-cap limit to 20 rather than passing it through unbounded', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false, chats: {} }));
      vi.stubGlobal('fetch', fetchMock);

      await searchMessagesPage({ query: 'hello', limit: 500, baseUrl: DEFAULT_BASE_URL, token: 't' });
      expect(fetchMock.mock.calls[0][0]).toContain('limit=20');
    });

    it('defaults limit to 20 when omitted', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], hasMore: false }));
      vi.stubGlobal('fetch', fetchMock);

      await searchMessagesPage({ query: 'hello', baseUrl: DEFAULT_BASE_URL, token: 't' });
      expect(fetchMock.mock.calls[0][0]).toContain('limit=20');
    });
  });

  // -------------------------------------------------------------------------
  // Auth requirement
  // -------------------------------------------------------------------------

  describe('auth requirement', () => {
    it('an authenticated call with no token configured fails fast with NOT_CONFIGURED, without calling fetch', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(getAccounts({ baseUrl: DEFAULT_BASE_URL, token: null }))
        .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('getInfo requires no token (the one unauthenticated endpoint) and sends no Authorization header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { app: { name: 'Beeper' } }));
      vi.stubGlobal('fetch', fetchMock);

      await getInfo({ baseUrl: DEFAULT_BASE_URL });
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers.Authorization).toBeUndefined();
    });

    it('an authenticated call sends the configured token as an Authorization: Bearer header', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, []));
      vi.stubGlobal('fetch', fetchMock);

      await getAccounts({ baseUrl: DEFAULT_BASE_URL, token: 'secret-token' });
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer secret-token');
    });
  });
});
