/**
 * Boundary tests for the Beeper chat-surface read model and the two wired rail
 * controls (#35). Postgres is mocked at `query()` and inspected as SQL text +
 * bind parameters, because the behaviour under test IS the query shape: which
 * filter reaches the WHERE clause, whether a keyset cursor is applied, and
 * whether the PATCH to Beeper happens before the mirror is touched. The
 * behavioural acceptance path against a real database is
 * `beeperConversations.db.test.js` (`npm run test:db`).
 *
 * Every fixture value is invented (placeholder ids, `Example` names) per root
 * AGENTS.md Sensitive Data & Privacy — no value here came from a running
 * instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn() }));
vi.mock('./beeperClient.js', () => ({ updateChat: vi.fn() }));

import { query } from '../lib/db.js';
import { updateChat } from './beeperClient.js';
import {
  listConversations,
  getConversation,
  listMessages,
  listNetworks,
  setConversationArchived,
  setConversationLowPriority,
  encodeCursor,
  decodeCursor,
} from './beeperConversations.js';

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

const conversationRow = (overrides = {}) => ({
  id: CONV_A,
  account_id: 'acct-example-1',
  network: 'examplenet',
  source_chat_id: 'chat-example-1',
  title: 'Example Conversation',
  type: 'single',
  is_group: false,
  is_pinned: false,
  is_archived: false,
  is_low_priority: false,
  is_muted: false,
  last_activity: '2026-09-01T10:00:00.000Z',
  created_at: '2026-08-01T10:00:00.000Z',
  unread_count: 2,
  ordering_ts: '2026-09-01T10:00:00.000Z',
  preview_id: null,
  ...overrides,
});

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();
const callFor = (fragment) => vi.mocked(query).mock.calls.find(([sql]) => flat(sql).includes(fragment));

beforeEach(() => vi.clearAllMocks());

describe('listConversations — filters are tri-state by omission', () => {
  it('applies no archived/low-priority predicate when the caller omits them', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({});
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).not.toContain('is_archived =');
    expect(flat(sql)).not.toContain('is_low_priority =');
    // The only bind is the page-size probe (limit + 1).
    expect(params).toEqual([51]);
  });

  it('applies `archived: false` as a real predicate, not as "no filter"', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ archived: false, lowPriority: false });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('c.is_archived = $1');
    expect(flat(sql)).toContain('c.is_low_priority = $2');
    expect(params).toEqual([false, false, 51]);
  });

  it('scopes to one network and to unread rows', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ network: 'examplenet', unreadOnly: true });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('c.network = $1');
    expect(flat(sql)).toContain('c.unread_count > 0');
    expect(params).toEqual(['examplenet', 51]);
  });
});

describe('listConversations — keyset pagination', () => {
  it('returns a nextCursor only when a further page exists, and resumes from it', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => conversationRow({
      id: `3333333${i}-3333-4333-8333-333333333333`,
      last_activity: `2026-09-0${i + 1}T10:00:00.000Z`,
      ordering_ts: `2026-09-0${i + 1}T10:00:00.000Z`,
    }));
    vi.mocked(query).mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [] });

    const page = await listConversations({ limit: 2 });
    expect(page.conversations).toHaveLength(2);
    expect(page.nextCursor).toBe(encodeCursor(rows[1].ordering_ts, rows[1].id));

    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ limit: 2, cursor: page.nextCursor });
    const [sql, params] = vi.mocked(query).mock.calls[2];
    expect(flat(sql)).toContain('(COALESCE(c.last_activity, c.created_at), c.id) <');
    expect(params[0]).toBe(rows[1].ordering_ts);
    expect(params[1]).toBe(rows[1].id);
  });

  it('has no next page when the result is short', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [conversationRow()] }).mockResolvedValueOnce({ rows: [] });
    const page = await listConversations({ limit: 2 });
    expect(page.nextCursor).toBeNull();
  });

  it('restarts the page on an unparseable cursor instead of throwing', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ cursor: 'not-a-cursor' });
    const [sql] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).not.toContain('c.id) <');
    expect(decodeCursor('not-a-cursor')).toBeNull();
  });
});

describe('listConversations — row shaping', () => {
  it('caps the participant subset and says so, because a Beeper roster is always a possible subset', async () => {
    const participants = Array.from({ length: 10 }, (_, i) => ({
      conversation_id: CONV_A,
      source_user_id: `user-${i}`,
      display_name: `Example Person ${i}`,
      handle: `+15550100${i}`,
      tribe_person_id: null,
      observed_via: 'participant-list',
      tribe_person_name: null,
    }));
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] })
      .mockResolvedValueOnce({ rows: participants });

    const { conversations } = await listConversations({});
    expect(conversations[0].participants).toHaveLength(8);
    expect(conversations[0].hasMoreParticipants).toBe(true);
    expect(conversations[0].participants[0]).toMatchObject({ tribePersonId: null, observedVia: 'participant-list' });
  });

  it('withholds the body of a tombstoned preview while keeping the row', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [conversationRow({
          preview_id: 'msg-example-1',
          preview_body: 'placeholder body that must not ship',
          preview_sender_id: 'user-1',
          preview_sent_at: '2026-09-01T09:59:00.000Z',
          preview_unsent_at: '2026-09-01T10:00:00.000Z',
        })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { conversations } = await listConversations({});
    expect(conversations[0].lastMessage).toMatchObject({ id: 'msg-example-1', body: '', isUnsent: true });
  });

  it('reports a conversation with no mirrored message as lastMessage: null, not as an empty string', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const { conversations } = await listConversations({});
    expect(conversations[0].lastMessage).toBeNull();
  });
});

describe('getConversation', () => {
  it('returns null for an unknown id so a stale deep link degrades to not-found', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    expect(await getConversation(CONV_B)).toBeNull();
  });

  it('returns the full participant set with no cap', async () => {
    const participants = Array.from({ length: 12 }, (_, i) => ({
      conversation_id: CONV_A,
      source_user_id: `user-${i}`,
      display_name: `Example Person ${i}`,
      handle: '',
      tribe_person_id: null,
      observed_via: 'message-sender',
      tribe_person_name: null,
    }));
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] })
      .mockResolvedValueOnce({ rows: participants });
    const conversation = await getConversation(CONV_A);
    expect(conversation.participants).toHaveLength(12);
    expect(conversation.hasMoreParticipants).toBe(false);
  });
});

describe('listMessages', () => {
  it('pages newest-first with a keyset cursor and attaches attachment references', async () => {
    const rows = [
      { id: 'm2', conversation_id: CONV_A, sender_id: 'user-1', body: 'second', sent_at: '2026-09-01T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z', ordering_ts: '2026-09-01T10:00:00.000Z' },
      { id: 'm1', conversation_id: CONV_A, sender_id: 'user-2', body: 'first', sent_at: '2026-09-01T09:00:00.000Z', created_at: '2026-09-01T09:00:00.000Z', ordering_ts: '2026-09-01T09:00:00.000Z' },
    ];
    vi.mocked(query)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ message_id: 'm2', idx: 0, mxc_id: 'mxc://example/abc', mime_type: 'image/png', byte_length: '1024', file_name: 'example.png', width: 10, height: 10 }] });

    const page = await listMessages(CONV_A, { limit: 5 });
    const [sql] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC');
    expect(page.messages.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(page.messages[0].attachments).toEqual([
      { messageId: 'm2', idx: 0, mxcId: 'mxc://example/abc', mimeType: 'image/png', byteLength: 1024, fileName: 'example.png', width: 10, height: 10 },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('withholds a tombstoned body but keeps the message and its unsentAt', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: 'm9', conversation_id: CONV_A, sender_id: 'user-1', body: 'placeholder body', sent_at: '2026-09-01T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z', unsent_at: '2026-09-01T11:00:00.000Z', ordering_ts: '2026-09-01T10:00:00.000Z' }],
    }).mockResolvedValueOnce({ rows: [] });
    const page = await listMessages(CONV_A, {});
    expect(page.messages[0]).toMatchObject({ id: 'm9', body: '', unsentAt: '2026-09-01T11:00:00.000Z' });
  });

  it('answers an empty page rather than an error — an empty thread is often correct', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [] });
    await expect(listMessages(CONV_A, {})).resolves.toEqual({ messages: [], nextCursor: null });
  });
});

describe('listNetworks', () => {
  it('derives the rail scopes from the mirror and excludes archived rows from unread', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ network: 'examplenet', conversation_count: 3, unread_count: 4, unread_conversations: 2, account_ids: ['acct-example-1'], last_activity: '2026-09-01T10:00:00.000Z' }],
    });
    const networks = await listNetworks();
    const [sql] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('FILTER (WHERE c.is_archived = FALSE)');
    expect(networks).toEqual([{
      network: 'examplenet',
      conversationCount: 3,
      unreadCount: 4,
      unreadConversations: 2,
      accountIds: ['acct-example-1'],
      lastActivity: '2026-09-01T10:00:00.000Z',
    }]);
  });
});

describe('the two wired rail controls', () => {
  it('PATCHes Beeper BEFORE the mirror, and mirrors the value Beeper actually returned', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ id: CONV_A, source_chat_id: 'chat-example-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [conversationRow({ is_archived: true })] })
      .mockResolvedValueOnce({ rows: [] });
    vi.mocked(updateChat).mockResolvedValue({ id: 'chat-example-1', isArchived: true });

    const conversation = await setConversationArchived(CONV_A, true);
    expect(updateChat).toHaveBeenCalledWith('chat-example-1', { isArchived: true });
    const update = callFor('UPDATE beeper_conversations SET is_archived');
    expect(update[1]).toEqual([CONV_A, true]);
    expect(conversation.isArchived).toBe(true);
  });

  it('leaves the mirror untouched when the PATCH fails — no optimistic local state', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: CONV_A, source_chat_id: 'chat-example-1' }] });
    vi.mocked(updateChat).mockRejectedValue(Object.assign(new Error('Beeper request failed'), { code: 'NETWORK_ERROR' }));

    await expect(setConversationArchived(CONV_A, true)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(updateChat).toHaveBeenCalledTimes(1);
    expect(callFor('UPDATE beeper_conversations')).toBeUndefined();
  });

  it('falls back to the requested value when the bridge answers without the flag, rather than blanking it', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ id: CONV_A, source_chat_id: 'chat-example-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [conversationRow({ is_low_priority: true })] })
      .mockResolvedValueOnce({ rows: [] });
    vi.mocked(updateChat).mockResolvedValue({ id: 'chat-example-1' });

    await setConversationLowPriority(CONV_A, true);
    expect(callFor('UPDATE beeper_conversations SET is_low_priority')[1]).toEqual([CONV_A, true]);
  });

  it('404s on an unknown conversation without calling Beeper at all', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [] });
    await expect(setConversationArchived(CONV_B, true)).rejects.toMatchObject({ status: 404 });
    expect(updateChat).not.toHaveBeenCalled();
  });
});
