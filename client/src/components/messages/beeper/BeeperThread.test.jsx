import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup, fireEvent, render, screen, within,
} from '@testing-library/react';
import BeeperThread from './BeeperThread';

/**
 * PR #60 blocker 1: `OutboxRow` had no branch for the `approved` state — only
 * `failed` and `awaiting-confirmation`/`sent` — so a row left `approved` by a
 * refused send (most often `OUTBOX_BREAKER_OPEN`, #36) rendered as a
 * permanent spinner-plus-"Sending…" bubble with no Retry and no dismiss.
 * PR #60 blocker 2: with the breaker tripped, a `failed` row's Retry stayed
 * enabled and did nothing at all — that path composes a new entry through the
 * same send the breaker blocks.
 *
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
const FAILED_ENTRY = {
  id: 'outbox-2', state: 'failed', body: 'hello there', errorMessage: 'Network error',
};
const TRIPPED_BREAKER = { tripped: true, reason: 'too many sends' };

// The server's own copy for a send interrupted by a restart, repeated here on
// purpose: client and server cannot share a module, so this literal and
// `SEND_INTERRUPTED_MESSAGE` in `server/services/beeperOutbox.js` are pinned by
// a test on each side rather than by an import.
const SEND_INTERRUPTED_COPY = 'Delivery unconfirmed: PortOS restarted mid-send. Check the chat before retrying.';
const UNRESOLVED_REASON = 'Beeper reported no matching message within 30s — it may still have been delivered, so it was not re-sent.';

const UNRESOLVED_ENTRY = {
  id: 'outbox-4',
  state: 'awaiting-confirmation',
  body: 'hello there',
  errorCode: 'CONFIRMATION_UNRESOLVED',
  errorMessage: UNRESOLVED_REASON,
};
const INTERRUPTED_ENTRY = {
  id: 'outbox-5',
  state: 'failed',
  body: 'hello there',
  errorCode: 'SEND_INTERRUPTED',
  errorMessage: SEND_INTERRUPTED_COPY,
};

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

  // The failed row's text is NOT the composer's draft, so this send must not
  // clear the composer on success — a message typed while the failed row sat
  // above it would be discarded, and dropped from storage with it.
  it('composes a new entry via onSend when retrying a failed row, without clearing the draft', () => {
    const onSend = vi.fn();
    const retryOutboxEntry = vi.fn();
    renderThread({ outboxEntries: [FAILED_ENTRY], onSend, retryOutboxEntry });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onSend).toHaveBeenCalledWith('hello there', { clearsDraft: false });
    expect(retryOutboxEntry).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  // A failed row's Retry composes a new entry through the same send path the
  // breaker blocks, so with the breaker tripped it can only fail. It used to
  // stay enabled and silently do nothing (PR #60 blocker 2).
  it("disables a failed row's Retry while the breaker is tripped, with the Send button's reason", () => {
    const onSend = vi.fn();
    renderThread({ outboxEntries: [FAILED_ENTRY], breaker: TRIPPED_BREAKER, onSend });

    const retry = screen.getByRole('button', { name: 'Retry' });
    const sendTitle = screen.getByRole('button', { name: 'Send' }).getAttribute('title');
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('title', sendTitle);
    expect(sendTitle).toContain('too many sends');

    fireEvent.click(retry);
    expect(onSend).not.toHaveBeenCalled();
  });

  // The stalled row is the opposite case: nothing has reached Beeper for it,
  // the server decides whether to refuse it again, and its 429 toasts. So
  // that Retry stays live even with the breaker tripped.
  it("leaves a stalled row's Retry enabled while the breaker is tripped", () => {
    const retryOutboxEntry = vi.fn();
    renderThread({ outboxEntries: [OUTBOX_ENTRY], breaker: TRIPPED_BREAKER, retryOutboxEntry });

    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeEnabled();

    fireEvent.click(retry);
    expect(retryOutboxEntry).toHaveBeenCalledWith(OUTBOX_ENTRY);
  });
});

/**
 * A send the server could not confirm, and a send a restart interrupted, are
 * both finished: nothing will ever advance either one. So neither may spin, and
 * neither may lose that property on a remount, which is the shape a reload
 * takes.
 */
describe('BeeperThread — terminal outbox states never spin', () => {
  it('renders an unconfirmed send as terminal, carrying the reason the server recorded', () => {
    const { container } = renderThread({ outboxEntries: [UNRESOLVED_ENTRY] });

    const row = screen.getByTestId('beeper-outbox-row');
    expect(row).toHaveAttribute('data-outcome', 'unconfirmed');
    expect(within(row).getByText(`Sent, unconfirmed — ${UNRESOLVED_REASON}`)).toBeInTheDocument();
    expect(screen.queryByText('Confirming…')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    // No Retry: the message may well have been delivered, and a resend is the
    // one mistake that cannot be taken back.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('renders an interrupted send with the exact copy and the usual failed-row Retry', () => {
    const onSend = vi.fn();
    const { container } = renderThread({ outboxEntries: [INTERRUPTED_ENTRY], onSend });

    const row = screen.getByTestId('beeper-outbox-row');
    expect(row).toHaveAttribute('data-outcome', 'failed');
    expect(within(row).getByText(SEND_INTERRUPTED_COPY)).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    // Retry composes a NEW entry from that row's text, exactly like any other
    // failed row — never a resend of a POST whose outcome is unknown.
    expect(onSend).toHaveBeenCalledWith('hello there', { clearsDraft: false });
  });

  it('keeps both terminal states across a remount, the shape a reload takes', () => {
    const first = renderThread({ outboxEntries: [UNRESOLVED_ENTRY, INTERRUPTED_ENTRY] });
    expect(screen.getAllByTestId('beeper-outbox-row')).toHaveLength(2);
    first.unmount();

    const { container } = renderThread({ outboxEntries: [UNRESOLVED_ENTRY, INTERRUPTED_ENTRY] });

    // Rendered oldest-last: `entries` arrives newest-first and is reversed.
    expect(screen.getAllByTestId('beeper-outbox-row').map((row) => row.dataset.outcome))
      .toEqual(['failed', 'unconfirmed']);
    expect(within(screen.getAllByTestId('beeper-outbox-row')[0]).getByText(SEND_INTERRUPTED_COPY)).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});

/**
 * Final live pass: some networks (Discord, Matrix — 26% of messages on a real
 * install) deliver HTML bodies, and the mirror stores what the source sent, so
 * the bubble rendered the tags literally. The allowlisted subset is parsed and
 * rendered as elements; nothing reaches `dangerouslySetInnerHTML`.
 */
describe('BeeperThread — message bodies', () => {
  const message = (body) => ({
    id: 'msg-1', body, sentAt: '2026-09-01T10:00:00.000Z', isSender: false, senderId: 'user-1',
  });

  it('renders an HTML body as elements rather than showing the tags', () => {
    renderThread({ messages: [message('<p>hello <strong>there</strong></p><p>second line</p>')] });

    const bubble = screen.getByTestId('beeper-message');
    expect(bubble).toHaveTextContent('hello there');
    expect(bubble).toHaveTextContent('second line');
    expect(bubble.textContent).not.toContain('<p>');
    expect(bubble.textContent).not.toContain('<strong>');
    expect(bubble.querySelector('strong')).toBeInTheDocument();
  });

  it('renders a blockquote and a link, and refuses a non-http scheme', () => {
    renderThread({
      messages: [message('<blockquote>quoted</blockquote><p><a href="https://example.com">ok</a> <a href="javascript:alert(1)">no</a></p>')],
    });

    const bubble = screen.getByTestId('beeper-message');
    expect(bubble.querySelector('blockquote')).toHaveTextContent('quoted');
    const links = bubble.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com');
    expect(bubble).toHaveTextContent('no');
  });

  it('keeps a plain body on the text-node path with its entities decoded (#59)', () => {
    renderThread({ messages: [message('salt &amp; pepper — 5 < 6')] });

    expect(screen.getByTestId('beeper-message')).toHaveTextContent('salt & pepper — 5 < 6');
  });
});
