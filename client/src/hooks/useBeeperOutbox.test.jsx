import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

/**
 * The composer's send lifecycle (#36). What matters here is the SHAPE of the
 * two-step flow, not the HTTP: create then send, one send per row ever, and a
 * first-contact refusal surfacing as an inline question rather than an error.
 */

const listOutboxEntries = vi.fn();
const createOutboxEntry = vi.fn();
const sendOutboxEntry = vi.fn();

vi.mock('../services/apiBeeper', () => ({
  listOutboxEntries: (...args) => listOutboxEntries(...args),
  createOutboxEntry: (...args) => createOutboxEntry(...args),
  sendOutboxEntry: (...args) => sendOutboxEntry(...args),
}));

const invalidateHandlers = new Set();
vi.mock('./useBeeperRealtime', () => ({
  default: ({ onInvalidate } = {}) => {
    invalidateHandlers.add(onInvalidate);
    return { realtime: null };
  },
}));

const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  default: { error: (...args) => toastError(...args), success: vi.fn() },
}));

const useBeeperOutbox = (await import('./useBeeperOutbox.js')).default;

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY = { id: 'outbox-1', state: 'approved', body: 'hello there' };

class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

describe('useBeeperOutbox', () => {
  beforeEach(() => {
    listOutboxEntries.mockReset().mockResolvedValue({ entries: [] });
    createOutboxEntry.mockReset().mockResolvedValue(ENTRY);
    sendOutboxEntry.mockReset().mockResolvedValue({ ...ENTRY, state: 'awaiting-confirmation' });
    toastError.mockReset();
    invalidateHandlers.clear();
  });
  afterEach(cleanup);

  it('creates the durable row first, then sends it exactly once', async () => {
    const onSent = vi.fn();
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID, { onSent }));

    await act(async () => { await result.current.submit('hello there'); });

    expect(createOutboxEntry).toHaveBeenCalledWith(CONVERSATION_ID, 'hello there', { silent: true });
    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
    expect(sendOutboxEntry).toHaveBeenCalledWith('outbox-1', { confirmFirstContact: false }, { silent: true });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(result.current.entries[0].state).toBe('awaiting-confirmation');
  });

  // `sending` is React state and does not update until a re-render, so it
  // cannot stop two calls made inside one render — a double-fired Send button,
  // or Enter racing the click. Beeper has no idempotency key, so the second row
  // would be a second unrecallable message.
  it('latches submit so two calls in one render create and send exactly one row', async () => {
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    let outcomes;
    await act(async () => {
      outcomes = await Promise.all([
        result.current.submit('hello there'),
        result.current.submit('hello there'),
      ]);
    });

    expect(createOutboxEntry).toHaveBeenCalledTimes(1);
    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
    // The loser is refused, not queued behind the winner.
    expect(outcomes).toEqual([true, false]);
    expect(result.current.entries).toHaveLength(1);

    // And the latch releases: a later, deliberate send still goes through.
    await act(async () => { await result.current.submit('hello again'); });
    expect(createOutboxEntry).toHaveBeenCalledTimes(2);
  });

  it('surfaces a first-contact refusal as an inline confirmation, then re-sends the SAME row', async () => {
    sendOutboxEntry.mockRejectedValueOnce(new ApiError(
      'This is the first message PortOS has ever sent to this conversation',
      'FIRST_CONTACT_CONFIRMATION_REQUIRED',
    ));
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    await act(async () => { await result.current.submit('hello there'); });
    // A question, not an error: nothing toasts, and the row is still there.
    expect(result.current.confirmation?.entry.id).toBe('outbox-1');
    expect(toastError).not.toHaveBeenCalled();

    await act(async () => { await result.current.confirmAndSend(); });
    expect(createOutboxEntry).toHaveBeenCalledTimes(1);
    expect(sendOutboxEntry).toHaveBeenLastCalledWith('outbox-1', { confirmFirstContact: true }, { silent: true });
    expect(result.current.confirmation).toBeNull();
  });

  it('never re-sends after a transport failure — it reports it and refetches the failed row', async () => {
    sendOutboxEntry.mockRejectedValue(new ApiError('Beeper request failed', 'NETWORK_ERROR'));
    listOutboxEntries.mockResolvedValue({ entries: [{ ...ENTRY, state: 'failed', errorCode: 'NETWORK_ERROR' }] });
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));

    await act(async () => { await result.current.submit('hello there'); });

    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalled();
    await waitFor(() => expect(result.current.entries[0].state).toBe('failed'));
    expect(sendOutboxEntry).toHaveBeenCalledTimes(1);
  });

  it('refetches when a message.upserted invalidation lands on a send awaiting confirmation', async () => {
    const { result } = renderHook(() => useBeeperOutbox(CONVERSATION_ID));
    await act(async () => { await result.current.submit('hello there'); });
    const before = listOutboxEntries.mock.calls.length;

    listOutboxEntries.mockResolvedValue({ entries: [{ ...ENTRY, state: 'sent', messageId: 'msg-final-1' }] });
    await act(async () => {
      for (const handler of invalidateHandlers) handler?.({ kind: 'message.upserted', chatID: 'example-chat-1' });
    });

    expect(listOutboxEntries.mock.calls.length).toBeGreaterThan(before);
    await waitFor(() => expect(result.current.entries[0].state).toBe('sent'));
  });
});
