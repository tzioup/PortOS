import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

/**
 * The outbound outbox (#36, decided on #8; confirmation transport on #12).
 *
 * Time is INJECTED — the confirmation fallback is a 30-second contract and the
 * breaker is a 60-second window, and proving either with a real sleep would put
 * a minute-plus of wall clock into CI for behaviour a fake clock pins exactly.
 *
 * `beeperClient` is mocked at the boundary: NOTHING in this suite reaches a
 * real Beeper Desktop, and the assertions that matter are about how many times
 * `sendMessage` is called (exactly once per entry, ever) rather than what the
 * network did with it.
 *
 * The DB is a small in-memory stand-in keyed on the same SQL this service
 * writes, so a state transition is asserted as a row state rather than as a
 * mock call. The real DDL is covered by `lib/db/schema/beeper.db.test.js`.
 */

class BeeperApiError extends Error {
  constructor(message, { status = 500, code, retryable = false, details } = {}) {
    super(message);
    this.name = 'BeeperApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

const sendMessage = vi.fn();
const getMessage = vi.fn();
const listMessagesPage = vi.fn();

vi.mock('./beeperClient.js', () => ({
  BeeperApiError,
  sendMessage: (...args) => sendMessage(...args),
  getMessage: (...args) => getMessage(...args),
  listMessagesPage: (...args) => listMessagesPage(...args),
}));

// The real normalizer is pure and covered by beeperSync's own suite; mocked
// here only to keep the ingestion stack (settings, Tribe, the pool) out of this
// module graph.
vi.mock('./beeperSync.js', () => ({
  normalizeMessageRow: (message, observedAt) => ({
    id: String(message?.id ?? ''),
    senderId: String(message?.senderID ?? ''),
    body: typeof message?.text === 'string' ? message.text : '',
    sentAt: message?.timestamp ?? null,
    editedAt: message?.editedTimestamp ?? null,
    unsentAt: message?.isDeleted === true ? observedAt : null,
    sortKey: String(message?.sortKey ?? ''),
  }),
}));

// --- in-memory stand-in for the two tables this service touches -------------
const outbox = new Map();
const conversations = new Map();
const mirrored = [];
const mirroredSql = [];
let nextId = 1;

const entryView = (row) => ({ ...row });

const query = vi.fn(async (sql, params = []) => {
  if (/SELECT id, source_chat_id/.test(sql)) {
    const conversation = conversations.get(params[0]);
    return { rows: conversation ? [{ id: params[0], sourceChatId: conversation }] : [], rowCount: conversation ? 1 : 0 };
  }
  if (/INSERT INTO beeper_outbox/.test(sql)) {
    const row = {
      id: `outbox-${nextId++}`,
      conversationId: params[0],
      chatId: params[1],
      body: params[2],
      state: 'approved',
      pendingMessageId: null,
      messageId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      approvedAt: '2026-09-01T00:00:00.000Z',
      sentAt: null,
    };
    outbox.set(row.id, row);
    return { rows: [entryView(row)], rowCount: 1 };
  }
  if (/SELECT 1 FROM beeper_outbox WHERE conversation_id = \$1 AND state = 'sent'/.test(sql)) {
    const sent = [...outbox.values()].filter((row) => row.conversationId === params[0] && row.state === 'sent');
    return { rows: sent.map(() => ({ '?column?': 1 })), rowCount: sent.length };
  }
  if (/FROM beeper_outbox\s+WHERE conversation_id = \$1 ORDER BY/.test(sql)) {
    return { rows: [...outbox.values()].filter((row) => row.conversationId === params[0]).map(entryView) };
  }
  if (/^SELECT[\s\S]*FROM beeper_outbox WHERE id = \$1/.test(sql)) {
    const row = outbox.get(params[0]);
    return { rows: row ? [entryView(row)] : [], rowCount: row ? 1 : 0 };
  }
  if (/UPDATE beeper_outbox SET state = 'sending'/.test(sql)) {
    const row = outbox.get(params[0]);
    if (!row || row.state !== 'approved') return { rows: [], rowCount: 0 };
    row.state = 'sending';
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/UPDATE beeper_outbox SET state = 'awaiting-confirmation'/.test(sql)) {
    const row = outbox.get(params[0]);
    row.state = 'awaiting-confirmation';
    row.pendingMessageId = params[1];
    return { rows: [entryView(row)], rowCount: 1 };
  }
  if (/UPDATE beeper_outbox SET state = 'failed'/.test(sql)) {
    const row = outbox.get(params[0]);
    row.state = 'failed';
    row.errorCode = params[1];
    row.errorMessage = params[2];
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE beeper_outbox SET state = 'sent'/.test(sql)) {
    const row = outbox.get(params[0]);
    if (!row || row.state !== 'awaiting-confirmation') return { rows: [], rowCount: 0 };
    row.state = 'sent';
    row.messageId = params[1];
    row.sentAt = params[2] ?? '2026-09-01T00:00:05.000Z';
    row.errorCode = null;
    row.errorMessage = null;
    return { rows: [entryView(row)], rowCount: 1 };
  }
  if (/UPDATE beeper_outbox SET error_code = 'CONFIRMATION_UNRESOLVED'/.test(sql)) {
    const row = outbox.get(params[0]);
    if (!row || row.state !== 'awaiting-confirmation') return { rows: [], rowCount: 0 };
    row.errorCode = 'CONFIRMATION_UNRESOLVED';
    row.errorMessage = params[1];
    return { rows: [], rowCount: 1 };
  }
  if (/DELETE FROM beeper_outbox WHERE id = \$1 AND state = 'approved'/.test(sql)) {
    const row = outbox.get(params[0]);
    if (!row || row.state !== 'approved') return { rows: [], rowCount: 0 };
    outbox.delete(params[0]);
    return { rows: [], rowCount: 1 };
  }
  if (/INSERT INTO beeper_messages/.test(sql)) {
    mirroredSql.push(sql);
    mirrored.push(params);
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`unexpected SQL in test: ${sql.slice(0, 60)}`);
});

vi.mock('../lib/db.js', () => ({ query: (...args) => query(...args) }));

const {
  BREAKER_MAX_CONSECUTIVE_FAILURES, BREAKER_MAX_SENDS_IN_WINDOW, CONFIRMATION_TIMEOUT_MS,
  cancelPendingConfirmations, clearOutboxBreaker, configureOutboxRuntime, createOutboxEntry,
  discardOutboxEntry, getOutboxBreakerState, getOutboxStatus, isFirstContact, listOutboxEntries,
  resetOutboxRuntime, sendOutboxEntry,
} = await import('./beeperOutbox.js');
const { beeperSocketEvents } = await import('./beeperSocketEvents.js');

// Timers are recorded rather than run, so a test fires exactly the one it cares
// about — the same controllable-clock shape `beeperSocket.test.js` uses.
function makeClock() {
  const timers = new Map();
  let nextTimerId = 1;
  let current = 0;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    runTimersWithDelay: (ms) => {
      const due = [...timers.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      return due.length;
    },
    pending: () => timers.size,
  };
}

let clock;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const CHAT_ID = 'example-chat-1';

const sentMessage = (overrides = {}) => ({
  id: 'msg-final-1',
  chatID: CHAT_ID,
  senderID: 'user-self',
  text: 'hello there',
  timestamp: '2026-09-01T00:00:05.000Z',
  sortKey: '900',
  isSender: true,
  ...overrides,
});

async function approvedEntry(body = 'hello there', conversationId = CONVERSATION_ID) {
  return createOutboxEntry({ conversationId, body });
}

/** A conversation PortOS has already sent to, so first contact is not in play. */
function markPriorSend(conversationId = CONVERSATION_ID) {
  const row = {
    id: `outbox-prior-${nextId++}`,
    conversationId,
    chatId: CHAT_ID,
    body: 'an earlier message',
    state: 'sent',
    pendingMessageId: null,
    messageId: 'msg-earlier',
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-31T00:00:00.000Z',
    approvedAt: '2026-08-31T00:00:00.000Z',
    sentAt: '2026-08-31T00:00:01.000Z',
  };
  outbox.set(row.id, row);
}

beforeEach(() => {
  outbox.clear();
  conversations.clear();
  mirrored.length = 0;
  mirroredSql.length = 0;
  nextId = 1;
  conversations.set(CONVERSATION_ID, CHAT_ID);
  conversations.set(OTHER_CONVERSATION_ID, 'example-chat-2');
  sendMessage.mockReset();
  getMessage.mockReset();
  listMessagesPage.mockReset();
  query.mockClear();
  sendMessage.mockResolvedValue({ chatID: CHAT_ID, pendingMessageID: 'pending-1' });
  getMessage.mockResolvedValue(sentMessage());
  listMessagesPage.mockResolvedValue({ items: [] });
  clock = makeClock();
  configureOutboxRuntime({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  clearOutboxBreaker();
});

afterEach(() => {
  cancelPendingConfirmations();
  clearOutboxBreaker();
  resetOutboxRuntime();
});

describe('createOutboxEntry — step one, the durable row', () => {
  it('writes an approved row carrying the source chat id, before anything is sent', async () => {
    const entry = await approvedEntry();
    expect(entry.state).toBe('approved');
    expect(entry.chatId).toBe(CHAT_ID);
    expect(entry.body).toBe('hello there');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses an empty body and an unknown conversation', async () => {
    await expect(createOutboxEntry({ conversationId: CONVERSATION_ID, body: '   ' }))
      .rejects.toMatchObject({ code: 'OUTBOX_EMPTY_BODY', status: 400 });
    await expect(createOutboxEntry({ conversationId: '33333333-3333-4333-8333-333333333333', body: 'hi' }))
      .rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND', status: 404 });
  });

  it('lists entries for one conversation, failed ones included', async () => {
    const first = await approvedEntry('one');
    await approvedEntry('two');
    await approvedEntry('other', OTHER_CONVERSATION_ID);
    outbox.get(first.id).state = 'failed';
    const entries = await listOutboxEntries({ conversationId: CONVERSATION_ID });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.state).sort()).toEqual(['approved', 'failed']);
  });
});

// The reviewer's blocker on #53: cancelling the first-contact confirmation
// left the row `approved` forever, with no way to remove it — a phantom
// pending send the client rendered as a permanent "Sending…" bubble. This is
// the discard the "Cancel" action now calls.
describe('discardOutboxEntry — the "Cancel" path', () => {
  it('removes an approved row that was never sent', async () => {
    const entry = await approvedEntry();
    await discardOutboxEntry(entry.id);
    expect(outbox.has(entry.id)).toBe(false);
    expect(await listOutboxEntries({ conversationId: CONVERSATION_ID })).toHaveLength(0);
  });

  it('404s an unknown entry', async () => {
    await expect(discardOutboxEntry('outbox-missing')).rejects.toMatchObject({
      code: 'OUTBOX_ENTRY_NOT_FOUND', status: 404,
    });
  });

  it('refuses to discard a row that already left "approved" — sent, failed, or in flight', async () => {
    const sending = await approvedEntry();
    outbox.get(sending.id).state = 'sending';
    await expect(discardOutboxEntry(sending.id)).rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });

    const sent = await approvedEntry();
    outbox.get(sent.id).state = 'sent';
    await expect(discardOutboxEntry(sent.id)).rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });

    const failed = await approvedEntry();
    outbox.get(failed.id).state = 'failed';
    await expect(discardOutboxEntry(failed.id)).rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });

    // None of those rows were touched.
    expect(outbox.has(sending.id)).toBe(true);
    expect(outbox.has(sent.id)).toBe(true);
    expect(outbox.has(failed.id)).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('sendOutboxEntry — the human gates', () => {
  it('refuses the first message to a conversation without an explicit confirmation, and sends nothing', async () => {
    const entry = await approvedEntry();
    expect(await isFirstContact(CONVERSATION_ID)).toBe(true);
    await expect(sendOutboxEntry(entry.id)).rejects.toMatchObject({
      code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED', status: 409,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(outbox.get(entry.id).state).toBe('approved');
  });

  it('sends once the first contact is confirmed, and asks no confirmation on the next message', async () => {
    const first = await approvedEntry();
    await sendOutboxEntry(first.id, { confirmFirstContact: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(CHAT_ID, { text: 'hello there' });
    expect(outbox.get(first.id).state).toBe('awaiting-confirmation');

    // Resolve it so the conversation has a completed send on record.
    beeperSocketEvents.emit('invalidate', { kind: 'message.upserted', chatID: CHAT_ID, ids: ['msg-final-1'] });
    await flush();
    expect(outbox.get(first.id).state).toBe('sent');

    const second = await approvedEntry('a reply');
    await expect(sendOutboxEntry(second.id)).resolves.toMatchObject({ state: 'awaiting-confirmation' });
  });

  it('refuses to send an entry that is not approved, and never re-sends a failed one', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    outbox.get(entry.id).state = 'failed';
    await expect(sendOutboxEntry(entry.id, { confirmFirstContact: true }))
      .rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('404s an unknown entry', async () => {
    await expect(sendOutboxEntry('outbox-missing')).rejects.toMatchObject({ code: 'OUTBOX_ENTRY_NOT_FOUND', status: 404 });
  });
});

describe('sendOutboxEntry — transport failure', () => {
  it('leaves exactly one failed row with the error, and posts nothing a second time', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    sendMessage.mockRejectedValueOnce(new BeeperApiError('Beeper request failed: connection refused', {
      status: 0, code: 'NETWORK_ERROR', retryable: false,
    }));

    await expect(sendOutboxEntry(entry.id)).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: false });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const rows = [...outbox.values()].filter((row) => row.state === 'failed');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entry.id);
    expect(rows[0].errorCode).toBe('NETWORK_ERROR');
    expect(rows[0].errorMessage).toContain('connection refused');
    // No confirmation was armed for a send that never left.
    expect(clock.pending()).toBe(0);
  });
});

describe('confirmation — socket first, 30s GET fallback', () => {
  it('confirms on a message.upserted invalidation, mirrors the message and re-broadcasts an id-only frame', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);

    const frames = [];
    const listener = (frame) => frames.push(frame);
    beeperSocketEvents.on('invalidate', listener);
    beeperSocketEvents.emit('invalidate', { kind: 'message.upserted', chatID: CHAT_ID, ids: ['msg-final-1'] });
    await flush();
    beeperSocketEvents.off('invalidate', listener);

    expect(outbox.get(entry.id).state).toBe('sent');
    expect(outbox.get(entry.id).messageId).toBe('msg-final-1');
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0][0]).toBe('msg-final-1');
    expect(mirrored[0][1]).toBe(CONVERSATION_ID);
    // The mirrored row is OUTBOUND. `is_sender` is written as a literal TRUE
    // rather than read off the confirming payload — the field is optional on
    // the API's own Message, and PortOS knows it sent this one — and the
    // conflict arm keeps the sweep's never-downgrade rule so a later inbound
    // page that omits the field cannot flip it back to the other side.
    expect(mirroredSql[0]).toMatch(/INSERT INTO beeper_messages \([^)]*, is_sender\)/);
    expect(mirroredSql[0]).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, TRUE\)/);
    expect(mirroredSql[0]).toMatch(/is_sender = beeper_messages\.is_sender OR EXCLUDED\.is_sender/);
    // The frame this service emits carries ids only — never the body.
    const emitted = frames.find((frame) => frame.ids?.includes('msg-final-1') && frame.ts);
    expect(emitted).toBeTruthy();
    expect(JSON.stringify(emitted)).not.toContain('hello there');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('resolves through the GET fallback when message.upserted never arrives, and does not send twice', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);

    // No socket frame at all. The fallback fires at exactly 30s.
    expect(outbox.get(entry.id).state).toBe('awaiting-confirmation');
    clock.advance(CONFIRMATION_TIMEOUT_MS);
    expect(clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS)).toBe(1);
    await flush();

    expect(getMessage).toHaveBeenCalledWith(CHAT_ID, 'pending-1');
    expect(outbox.get(entry.id).state).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to a chat + body + isSender match when the pending id no longer resolves', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);
    getMessage.mockRejectedValue(new BeeperApiError('not found', { status: 404, code: 'NOT_FOUND' }));
    listMessagesPage.mockResolvedValue({
      items: [
        { id: 'msg-someone-else', text: 'hello there', isSender: false, timestamp: '2026-09-01T00:00:06.000Z' },
        sentMessage({ id: 'msg-final-2' }),
      ],
    });

    clock.advance(CONFIRMATION_TIMEOUT_MS);
    clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS);
    await flush();

    expect(outbox.get(entry.id).messageId).toBe('msg-final-2');
    expect(outbox.get(entry.id).state).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves an unresolvable send in flight with a reason rather than marking it failed', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);
    getMessage.mockResolvedValue(null);
    listMessagesPage.mockResolvedValue({ items: [] });

    clock.advance(CONFIRMATION_TIMEOUT_MS);
    clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS);
    await flush();

    const row = outbox.get(entry.id);
    // Not `failed`: a failed row invites a re-send, and the message may well
    // have been delivered.
    expect(row.state).toBe('awaiting-confirmation');
    expect(row.errorCode).toBe('CONFIRMATION_UNRESOLVED');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('marks the row failed when Beeper reports a failed send status, and never retries it', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);
    getMessage.mockResolvedValue(sentMessage({
      sendStatus: { status: 'FAIL_PERMANENT', timestamp: '2026-09-01T00:00:06.000Z', message: 'Recipient unreachable' },
    }));

    clock.advance(CONFIRMATION_TIMEOUT_MS);
    clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS);
    await flush();

    expect(outbox.get(entry.id).state).toBe('failed');
    expect(outbox.get(entry.id).errorCode).toBe('SEND_FAIL_PERMANENT');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('runaway breaker', () => {
  it('trips on a synthetic send loop and blocks every further send until a human clears it', async () => {
    markPriorSend();
    const entries = [];
    for (let i = 0; i < BREAKER_MAX_SENDS_IN_WINDOW + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- the loop under test is sequential
      entries.push(await approvedEntry(`message ${i}`));
    }

    for (let i = 0; i < BREAKER_MAX_SENDS_IN_WINDOW; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered sends inside the same window
      await sendOutboxEntry(entries[i].id);
    }
    expect(getOutboxBreakerState().tripped).toBe(false);

    const overflow = entries[BREAKER_MAX_SENDS_IN_WINDOW];
    await expect(sendOutboxEntry(overflow.id)).rejects.toMatchObject({ code: 'OUTBOX_BREAKER_OPEN', status: 429 });
    expect(sendMessage).toHaveBeenCalledTimes(BREAKER_MAX_SENDS_IN_WINDOW);
    expect(getOutboxBreakerState().tripped).toBe(true);
    expect(getOutboxStatus().breaker.tripped).toBe(true);

    // Still blocked, and time alone does not reopen it.
    clock.advance(60 * 60 * 1000);
    await expect(sendOutboxEntry(overflow.id)).rejects.toMatchObject({ code: 'OUTBOX_BREAKER_OPEN' });
    expect(sendMessage).toHaveBeenCalledTimes(BREAKER_MAX_SENDS_IN_WINDOW);

    expect(clearOutboxBreaker().tripped).toBe(false);
    await expect(sendOutboxEntry(overflow.id)).resolves.toMatchObject({ state: 'awaiting-confirmation' });
  });

  it('trips on consecutive transport failures', async () => {
    markPriorSend();
    sendMessage.mockRejectedValue(new BeeperApiError('Beeper request failed', { status: 0, code: 'NETWORK_ERROR' }));
    for (let i = 0; i < BREAKER_MAX_CONSECUTIVE_FAILURES; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered failures
      const entry = await approvedEntry(`attempt ${i}`);
      // eslint-disable-next-line no-await-in-loop
      await expect(sendOutboxEntry(entry.id)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    }
    expect(getOutboxBreakerState()).toMatchObject({
      tripped: true, consecutiveFailures: BREAKER_MAX_CONSECUTIVE_FAILURES,
    });
    const next = await approvedEntry('one more');
    await expect(sendOutboxEntry(next.id)).rejects.toMatchObject({ code: 'OUTBOX_BREAKER_OPEN' });
    expect(sendMessage).toHaveBeenCalledTimes(BREAKER_MAX_CONSECUTIVE_FAILURES);
  });
});
