import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import BeeperThread, { decodeHtmlEntities } from './BeeperThread';

/**
 * #35 real-browser pass: a message body containing an ampersand rendered as
 * the five-character HTML entity `&amp;` in the thread bubble. Beeper Desktop
 * delivers entity-encoded text for some bridged networks; PortOS itself never
 * escapes on the way in (`beeperSync.js` `normalizeMessageRow` passes
 * `message.text` through unchanged), so decoding belongs here, on the way out
 * to the DOM — as a plain text node, never `dangerouslySetInnerHTML`.
 */
describe('decodeHtmlEntities', () => {
  it('decodes the five predefined named entities', () => {
    expect(decodeHtmlEntities('&amp;')).toBe('&');
    expect(decodeHtmlEntities('&lt;')).toBe('<');
    expect(decodeHtmlEntities('&gt;')).toBe('>');
    expect(decodeHtmlEntities('&quot;')).toBe('"');
    expect(decodeHtmlEntities('&#39;')).toBe("'");
  });

  it('decodes a realistic sentence with an ampersand', () => {
    expect(decodeHtmlEntities('salt &amp; pepper')).toBe('salt & pepper');
  });

  it('leaves a plain string with no entities untouched', () => {
    expect(decodeHtmlEntities('no entities here')).toBe('no entities here');
  });

  it('is double-decode-safe: &amp;lt; decodes to &lt;, never <', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });

  it('leaves an unknown named entity and an out-of-range numeric ref untouched', () => {
    expect(decodeHtmlEntities('&zzz;')).toBe('&zzz;');
    expect(decodeHtmlEntities('&#99999999;')).toBe('&#99999999;');
  });

  it('does not resolve inherited Object.prototype properties as entities', () => {
    // Untrusted remote chat text can contain literally anything. A lookup of
    // `NAMED_ENTITIES[code]` walks the prototype chain, so `&constructor;` and
    // `&toString;` used to render as the stringified built-in functions
    // instead of being left as unknown entities.
    expect(decodeHtmlEntities('&constructor;')).toBe('&constructor;');
    expect(decodeHtmlEntities('&toString;')).toBe('&toString;');
    expect(decodeHtmlEntities('&hasOwnProperty;')).toBe('&hasOwnProperty;');
  });

  it('passes through non-string and empty input unchanged', () => {
    expect(decodeHtmlEntities(undefined)).toBe(undefined);
    expect(decodeHtmlEntities(null)).toBe(null);
    expect(decodeHtmlEntities('')).toBe('');
  });
});

/**
 * PR #60 blocker 1: `OutboxRow` had no branch for the `approved` state — only
 * `failed` and `awaiting-confirmation`/`sent` — so a row left `approved` by a
 * refused send (most often `OUTBOX_BREAKER_OPEN`, #36) rendered as a
 * permanent spinner-plus-"Sending…" bubble with no Retry and no dismiss.
 * These tests exercise `OutboxRow` through the real component rather than in
 * isolation, since the "stalled vs. actively sending" distinction is read
 * off sibling props (`sending`, `confirmation`) it does not own itself.
 */

const CONVERSATION = {
  id: 'convo-1',
  title: 'Example Contact',
  network: 'whatsapp',
  participants: [],
};

const BASE_PROPS = {
  conversation: CONVERSATION,
  messages: [],
  loading: false,
  error: null,
  hasMore: false,
  loadingMore: false,
  onLoadMore: vi.fn(),
  draft: '',
  onDraftChange: vi.fn(),
  outboxEntries: [],
  sending: false,
  confirmation: null,
  onSend: vi.fn(),
  confirmAndSend: vi.fn(),
  cancelConfirmation: vi.fn(),
  retryOutboxEntry: vi.fn(),
  dismissOutboxEntry: vi.fn(),
  breaker: null,
  people: [],
  linkingId: null,
  onLinkParticipant: vi.fn(),
  onCreateAndLinkParticipant: vi.fn(),
  onBack: vi.fn(),
  onRetry: null,
  onArchive: vi.fn(),
  onLowPriority: vi.fn(),
  onPurge: null,
  purging: false,
  onAttachmentUpdated: vi.fn(),
  writePending: false,
};

const OUTBOX_ENTRY = { id: 'outbox-1', state: 'approved', body: 'hello there' };

const renderThread = (overrides = {}) => render(<BeeperThread {...BASE_PROPS} {...overrides} />);

afterEach(cleanup);

describe('BeeperThread — outbox row states', () => {
  it('offers Retry and Dismiss on a stalled approved row instead of a permanent spinner', () => {
    renderThread({ outboxEntries: [OUTBOX_ENTRY], sending: false });

    const row = screen.getByTestId('beeper-outbox-row');
    expect(row).toHaveAttribute('data-state', 'approved');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.queryByText('Sending…')).not.toBeInTheDocument();
  });

  it('still shows the sending spinner, not Retry/Dismiss, while an approved row is actually in flight', () => {
    renderThread({ outboxEntries: [OUTBOX_ENTRY], sending: true });

    expect(screen.getByText('Sending…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('still shows the sending spinner while the same row is the subject of a pending first-contact confirmation', () => {
    renderThread({
      outboxEntries: [OUTBOX_ENTRY],
      sending: false,
      confirmation: { entry: OUTBOX_ENTRY, message: 'first contact' },
    });

    expect(screen.getByText('Sending…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  // Retrying a stalled row must re-dispatch the SAME row (via the hook's
  // `retry`), never compose a new one through `onSend` — that would
  // manufacture a fresh phantom on every click while the breaker stays
  // tripped, the failure mode the reviewer flagged.
  it('retries a stalled row in place, never composing a new one via onSend', () => {
    const retryOutboxEntry = vi.fn();
    const onSend = vi.fn();
    renderThread({
      outboxEntries: [OUTBOX_ENTRY], sending: false, retryOutboxEntry, onSend,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(retryOutboxEntry).toHaveBeenCalledWith(OUTBOX_ENTRY);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('dismisses a stalled row on request', () => {
    const dismissOutboxEntry = vi.fn();
    renderThread({ outboxEntries: [OUTBOX_ENTRY], sending: false, dismissOutboxEntry });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(dismissOutboxEntry).toHaveBeenCalledWith(OUTBOX_ENTRY);
  });

  it('still composes a new entry via onSend when retrying a failed row (unchanged behaviour)', () => {
    const onSend = vi.fn();
    const retryOutboxEntry = vi.fn();
    renderThread({
      outboxEntries: [{ id: 'outbox-2', state: 'failed', body: 'hello there', errorMessage: 'Network error' }],
      onSend,
      retryOutboxEntry,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onSend).toHaveBeenCalledWith('hello there');
    expect(retryOutboxEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });
});
