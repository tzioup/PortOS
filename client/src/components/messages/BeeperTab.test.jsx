import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  act, cleanup, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

/**
 * The Beeper chat surface (#35), tested at the page boundary — the same seam a
 * user reaches it through, so the rail, the list, the thread, the URL contract
 * and the realtime wiring are exercised together rather than one prop at a time.
 *
 * EVERY fixture value below is invented: placeholder names, `example.com`
 * handles and 555-01xx numbers per root AGENTS.md Sensitive Data & Privacy. The
 * last test in this file is a guard that keeps it that way — no value from a
 * running instance may ever be pasted in here.
 */

const api = vi.hoisted(() => ({
  getBeeperStatus: vi.fn(),
  getBeeperNetworks: vi.fn(),
  getBeeperConversations: vi.fn(),
  getBeeperConversation: vi.fn(),
  getBeeperMessages: vi.fn(),
  setBeeperConversationArchived: vi.fn(),
  setBeeperConversationLowPriority: vi.fn(),
  linkBeeperParticipant: vi.fn(),
  createTribePersonFromBeeper: vi.fn(),
  getTribePeople: vi.fn(),
  // Reached through the settings drawer. Declared here because
  // `BeeperSettingsPanel` imports them at module load, whether or not a test
  // opens the drawer — a named import missing from the mock throws.
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  checkBeeperConnection: vi.fn(),
  startBeeperOAuth: vi.fn(),
  saveBeeperToken: vi.fn(),
  disconnectBeeper: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
const socketMock = vi.hoisted(() => {
  const handlers = new Map();
  const emitted = [];
  return {
    handlers,
    emitted,
    socket: {
      on: (event, fn) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add(fn);
      },
      off: (event, fn) => { handlers.get(event)?.delete(fn); },
      emit: (event, payload) => { emitted.push([event, payload]); },
    },
  };
});

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/socket', () => ({ default: socketMock.socket }));

const BeeperTab = (await import('./BeeperTab')).default;

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

// Nine networks, matching the outlier install #9 warns the design must not be
// tuned for. Ids only — the surface renders whatever the mirror reports.
const NINE_NETWORKS = [
  'whatsapp', 'telegram', 'discord', 'signal', 'instagram', 'slack', 'x', 'facebook', 'googlemessages',
].map((network, index) => ({ network, conversationCount: 1, unreadCount: index, unreadConversations: 1, accountIds: [`acct-example-${index}`], lastActivity: '2026-09-01T10:00:00.000Z' }));

const conversation = (overrides = {}) => ({
  id: CONV_A,
  accountId: 'acct-example-0',
  network: 'examplenet',
  sourceChatId: 'chat-example-1',
  title: 'Example Conversation',
  type: 'single',
  isGroup: false,
  isPinned: false,
  isArchived: false,
  isLowPriority: false,
  isMuted: false,
  lastActivity: '2026-09-01T10:00:00.000Z',
  unreadCount: 0,
  lastMessage: null,
  participants: [],
  hasMoreParticipants: false,
  ...overrides,
});

const renderTab = (initialPath = '/messages/beeper') => render(
  <MemoryRouter initialEntries={[initialPath]}>
    <Routes>
      <Route path="/messages/:tab" element={<BeeperTab />} />
      <Route path="/messages/:tab/:chatKey" element={<BeeperTab />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  socketMock.handlers.clear();
  socketMock.emitted.length = 0;
  api.getBeeperStatus.mockResolvedValue({ tokenConfigured: true, reachable: true, accounts: [], realtime: { state: 'connected' } });
  api.getBeeperNetworks.mockResolvedValue({ networks: [] });
  api.getBeeperConversations.mockResolvedValue({ conversations: [], nextCursor: null });
  api.getBeeperConversation.mockResolvedValue(conversation());
  api.getBeeperMessages.mockResolvedValue({ messages: [], nextCursor: null });
  api.getTribePeople.mockResolvedValue([]);
  api.getSettings.mockResolvedValue({ beeper: { enabled: false, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 } });
});

afterEach(cleanup);

describe('deep linking', () => {
  it('opens the conversation directly on a cold load of its URL', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [NINE_NETWORKS[0]] });
    api.getBeeperConversations.mockResolvedValue({ conversations: [conversation()], nextCursor: null });
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Deep Link' }));
    api.getBeeperMessages.mockResolvedValue({
      messages: [{ id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder message body', sentAt: '2026-09-01T10:00:00.000Z', attachments: [] }],
      nextCursor: null,
    });

    renderTab(`/messages/beeper/${CONV_A}`);

    expect(await screen.findByText('Placeholder message body')).toBeInTheDocument();
    expect(api.getBeeperConversation).toHaveBeenCalledWith(CONV_A, { silent: true });
    // The list is fetched for the same scope, so the surface is whole rather
    // than a bare thread with no way back.
    expect(api.getBeeperConversations).toHaveBeenCalled();
  });

  it('renders a not-found state for a stale conversation id instead of an empty thread', async () => {
    api.getBeeperConversation.mockRejectedValue(Object.assign(new Error('Conversation not found'), { status: 404 }));
    renderTab(`/messages/beeper/${CONV_B}`);
    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
  });

  // The regression the reviewer found: an `apiCore` failure with no `.status`
  // (503 unreachable, 500, offline) leaves the detail null and the error set,
  // and the thread's "Pick a conversation" early return used to sit AHEAD of
  // the error branch — so a URL that names a conversation rendered as if
  // nothing were selected. Every fetch behind it is `{ silent: true }`, so
  // there was no toast either: the failure was completely invisible.
  it('renders the thread error with a Retry when a deep link fails, never "Pick a conversation"', async () => {
    api.getBeeperConversation.mockRejectedValue(new Error('Beeper request failed: connection refused'));
    api.getBeeperMessages.mockRejectedValue(new Error('Beeper request failed: connection refused'));
    renderTab(`/messages/beeper/${CONV_B}`);

    expect(await screen.findByText('Could not open this conversation')).toBeInTheDocument();
    expect(screen.getByText('Beeper request failed: connection refused')).toBeInTheDocument();
    expect(screen.queryByText('Pick a conversation')).toBeNull();
    expect(screen.queryByText('Conversation not found')).toBeNull();

    // Retry re-reads the mirror rather than leaving the pane stuck.
    const calls = api.getBeeperConversation.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(api.getBeeperConversation.mock.calls.length).toBeGreaterThan(calls));
  });

  it('scopes the list from the URL, so a shared link reopens the same scope', async () => {
    renderTab('/messages/beeper?scope=net:whatsapp&unread=1');
    await waitFor(() => expect(api.getBeeperConversations).toHaveBeenCalledWith(
      { unreadOnly: true, network: 'whatsapp', archived: false },
      { silent: true },
    ));
  });
});

describe('rendering at every install size', () => {
  it('renders with zero conversations, and says an empty list is often correct', async () => {
    renderTab();
    expect(await screen.findByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText(/often correct rather than broken/)).toBeInTheDocument();
    expect(screen.queryByTestId('network-badge')).toBeNull();
  });

  it('drops the per-row network badge inside a single-network scope', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [NINE_NETWORKS[0]] });
    api.getBeeperConversations.mockResolvedValue({
      conversations: [conversation({ network: 'whatsapp' })],
      nextCursor: null,
    });

    renderTab('/messages/beeper?scope=net:whatsapp');

    expect(await screen.findByText('Example Conversation')).toBeInTheDocument();
    // The rail already states the network, so the badge would be noise — the
    // one conditional rule #9 says a from-scratch design would have got wrong.
    expect(screen.queryByTestId('network-badge')).toBeNull();
  });

  it('badges every row in the unified inbox, at nine networks', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: NINE_NETWORKS });
    api.getBeeperConversations.mockResolvedValue({
      conversations: NINE_NETWORKS.map((entry, index) => conversation({
        id: `4444444${index}-4444-4444-8444-444444444444`,
        network: entry.network,
        title: `Example Conversation ${index}`,
      })),
      nextCursor: null,
    });

    renderTab();

    expect(await screen.findByText('Example Conversation 0')).toBeInTheDocument();
    expect(screen.getAllByTestId('network-badge')).toHaveLength(9);
    // One rail entry per mirrored network, and no hardcoded roster anywhere.
    expect(screen.getByRole('button', { name: 'WhatsApp' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Google Messages' })).toBeInTheDocument();
  });

  it('renders a network the client has no logo for rather than dropping it', async () => {
    api.getBeeperNetworks.mockResolvedValue({ networks: [{ network: 'somenewbridge', unreadCount: 0, conversationCount: 1, accountIds: [] }] });
    renderTab();
    expect(await screen.findByRole('button', { name: 'somenewbridge' })).toBeInTheDocument();
  });
});

describe('message direction', () => {
  it('puts own messages on the other side of the thread, from the mirrored isSender', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({
      title: 'Example Contact',
      participants: [{ sourceUserId: 'user-1', displayName: 'Sam Example', handle: '', tribePersonId: null, tribePersonName: null, observedVia: 'participant-list' }],
    }));
    api.getBeeperMessages.mockResolvedValue({
      messages: [
        { id: 'm2', conversationId: CONV_A, senderId: 'user-me', body: 'Placeholder outbound', sentAt: '2026-09-01T10:00:00.000Z', isSender: true, attachments: [] },
        { id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder inbound', sentAt: '2026-09-01T09:00:00.000Z', isSender: false, attachments: [] },
      ],
      nextCursor: null,
    });

    renderTab(`/messages/beeper/${CONV_A}`);

    await screen.findByText('Placeholder outbound');
    const bubbles = screen.getAllByTestId('beeper-message');
    // Rendered oldest-first, so the inbound one comes first.
    expect(bubbles.map((node) => node.dataset.direction)).toEqual(['in', 'out']);
    // An own message carries no sender name — the reference's shape, and the
    // reason direction has to be mirrored rather than guessed from senderId.
    expect(within(bubbles[1]).queryByText('user-me')).toBeNull();
    expect(within(bubbles[0]).getByText('Sam Example')).toBeInTheDocument();
  });

  it('renders a message with no direction as inbound rather than as unknown', async () => {
    api.getBeeperMessages.mockResolvedValue({
      messages: [{ id: 'm1', conversationId: CONV_A, senderId: 'user-1', body: 'Placeholder body', sentAt: '2026-09-01T09:00:00.000Z', attachments: [] }],
      nextCursor: null,
    });
    renderTab(`/messages/beeper/${CONV_A}`);
    await screen.findByText('Placeholder body');
    expect(screen.getByTestId('beeper-message').dataset.direction).toBe('in');
  });
});

describe('the pinned grid is Beeper’s own isPinned, mirrored', () => {
  it('lifts pinned conversations into the grid without any local pin state', async () => {
    api.getBeeperConversations.mockResolvedValue({
      conversations: [
        conversation({ id: CONV_A, title: 'Example Pinned', isPinned: true }),
        conversation({ id: CONV_B, title: 'Example Unpinned' }),
      ],
      nextCursor: null,
    });
    renderTab();

    await screen.findByText('Example Unpinned');
    // The grid renders the first word of a pinned title; the row list still
    // holds both. Nothing in the client can pin — there is no such control.
    expect(screen.getAllByText('Example').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Pin/ })).toBeNull();
  });
});

describe('deferred controls render inert rather than absent', () => {
  it('disables Requests, Later, add-scope and the overflow menu, each saying it is not wired', async () => {
    renderTab();
    await screen.findByText('Nothing here');

    for (const label of ['Requests', 'Later', 'Add scope', 'More scope options']) {
      const control = screen.getByRole('button', { name: label });
      expect(control).toBeDisabled();
      expect(control).toHaveAttribute('title', `${label} — not wired yet`);
    }
  });

  it('keeps the two wired scopes live', async () => {
    renderTab();
    await screen.findByText('Nothing here');
    expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Low priority' })).toBeEnabled();
  });
});

describe('the composer', () => {
  it('names the network it would send on, keeps the draft, and cannot send', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({ network: 'whatsapp', title: 'Example Contact' }));
    renderTab(`/messages/beeper/${CONV_A}`);

    const composer = await screen.findByLabelText('Message Example Contact on WhatsApp');
    expect(composer).toHaveAttribute('placeholder', 'Message Example Contact on WhatsApp');

    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send.getAttribute('title')).toMatch(/not wired yet/);
  });
});

describe('realtime', () => {
  it('subscribes once and RE-SUBSCRIBES on every socket connect, so a reconnect is not silently dead', async () => {
    renderTab();
    await screen.findByText('Nothing here');
    expect(socketMock.emitted.filter(([event]) => event === 'beeper:subscribe')).toHaveLength(1);

    act(() => { for (const fn of socketMock.handlers.get('connect') || []) fn(); });
    expect(socketMock.emitted.filter(([event]) => event === 'beeper:subscribe')).toHaveLength(2);
  });

  it('refetches the list and the open thread after an invalidation frame', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderTab(`/messages/beeper/${CONV_A}`);
      // Settle every mount fetch inside act() before measuring — otherwise the
      // refetch assertion races the initial load rather than the frame.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => {});
      const listCalls = api.getBeeperConversations.mock.calls.length;
      const threadCalls = api.getBeeperMessages.mock.calls.length;

      act(() => {
        for (const fn of socketMock.handlers.get('beeper:invalidate') || []) {
          fn({ kind: 'message.upserted', chatID: 'chat-example-1', ids: ['m1'], seq: 4 });
        }
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      expect(api.getBeeperConversations.mock.calls.length).toBeGreaterThan(listCalls);
      expect(api.getBeeperMessages.mock.calls.length).toBeGreaterThan(threadCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the liveness dot from the transport state and never as offline before it reports', async () => {
    api.getBeeperStatus.mockResolvedValue({ tokenConfigured: true, reachable: true, accounts: [], realtime: null });
    renderTab();
    await screen.findByText('Nothing here');
    expect(screen.queryByTestId('connection-status-dot')).toBeNull();

    act(() => {
      for (const fn of socketMock.handlers.get('beeper:realtime') || []) fn({ state: 'connected' });
    });
    expect(await screen.findByTestId('connection-status-dot')).toHaveAttribute('data-status', 'connected');
  });
});

describe('the two wired rail controls', () => {
  it('archives through the API and reflects the value the server returned', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Contact' }));
    api.setBeeperConversationArchived.mockResolvedValue(conversation({ title: 'Example Contact', isArchived: true }));
    renderTab(`/messages/beeper/${CONV_A}`);

    const button = await screen.findByRole('button', { name: 'Archive', hidden: false });
    // Two controls carry the Archive name (the rail scope and the thread
    // action); the thread action is the one inside the header row.
    const threadArchive = screen.getAllByRole('button', { name: 'Archive' }).at(-1);
    expect(button).toBeTruthy();
    act(() => { threadArchive.click(); });

    await waitFor(() => expect(api.setBeeperConversationArchived).toHaveBeenCalledWith(CONV_A, true, { silent: true }));
    expect(await screen.findByRole('button', { name: 'Unarchive' })).toBeInTheDocument();
  });

  it('reports a failed write once and does not retry it', async () => {
    api.getBeeperConversation.mockResolvedValue(conversation({ title: 'Example Contact' }));
    api.setBeeperConversationLowPriority.mockRejectedValue(
      Object.assign(new Error('Beeper request failed: connection refused'), { status: 503, context: { retryable: false } }),
    );
    renderTab(`/messages/beeper/${CONV_A}`);

    const button = await screen.findByRole('button', { name: 'Low priority', hidden: false });
    const threadControl = screen.getAllByRole('button', { name: 'Low priority' }).at(-1);
    expect(button).toBeTruthy();
    act(() => { threadControl.click(); });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper request failed: connection refused'));
    expect(api.setBeeperConversationLowPriority).toHaveBeenCalledTimes(1);
  });
});

describe('the inline Tribe link action', () => {
  it('links a participant to an existing Tribe person', async () => {
    api.getTribePeople.mockResolvedValue([{ id: '55555555-5555-4555-8555-555555555555', name: 'Alex Example' }]);
    api.getBeeperConversation.mockResolvedValue(conversation({
      title: 'Example Contact',
      participants: [{ sourceUserId: 'user-1', displayName: 'Sam Example', handle: '+15550100', tribePersonId: null, tribePersonName: null, observedVia: 'participant-list' }],
    }));
    api.linkBeeperParticipant.mockResolvedValue({ participant: {}, displacedPersonId: null });

    renderTab(`/messages/beeper/${CONV_A}`);

    const peopleToggle = await screen.findByRole('button', { name: 'People' });
    act(() => { peopleToggle.click(); });
    const select = await screen.findByLabelText('Link Sam Example to a Tribe person');
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, '55555555-5555-4555-8555-555555555555');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const linkButton = within(select.closest('li')).getByRole('button', { name: 'Link' });
    act(() => { linkButton.click(); });

    await waitFor(() => expect(api.linkBeeperParticipant).toHaveBeenCalledWith(
      { conversationId: CONV_A, sourceUserId: 'user-1', personId: '55555555-5555-4555-8555-555555555555' },
      { silent: true },
    ));
  });
});

// Beeper's consent screen redirects the BROWSER back to this page, never to
// the settings drawer, so the page shell — not the panel inside the drawer —
// is what has to read the outcome off the URL (#31).
describe('the OAuth outcome carried back on the URL', () => {
  it('reports a successful connect', async () => {
    renderTab('/messages/beeper?beeperConnected=1');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Beeper connected'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a failure and opens the settings drawer, where the connect card that fixes it lives', async () => {
    renderTab('/messages/beeper?beeperOauthError=access_denied');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper connect failed: access_denied'));
    expect(await screen.findByRole('heading', { name: 'Beeper Settings' })).toBeInTheDocument();
  });
});

// A guard, not a formality: this file is the one place a real conversation,
// handle or contact name could slip into a PUBLIC repo while developing against
// a live install (root AGENTS.md, Sensitive Data & Privacy).
//
// It scans this file's own SOURCE rather than a hand-listed set of fixtures.
// Most fixtures here are written inline inside a single test — participants,
// messages, Tribe people, network rosters — so a guard that enumerates the two
// shared ones stops guarding the moment somebody pastes a third.
describe('fixture hygiene', () => {
  it('carries no value that could have come from a running instance', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    // Everything above this block. The patterns below necessarily spell out
    // the shapes they forbid, so scanning them would fail on the guard itself.
    const corpus = source.slice(0, source.indexOf("describe('fixture hygiene'"));
    // No e164-looking number outside the reserved 555-01xx block, no email
    // outside example.com, no bare hostname, no absolute home path.
    expect(corpus).not.toMatch(/\+(?!1555010)\d{7,}/);
    expect(corpus).not.toMatch(/@(?!example\.com)[\w.-]+\.[a-z]{2,}/i);
    expect(corpus).not.toMatch(/\.ts\.net|\.local\b/);
    expect(corpus).not.toMatch(/\/(?:home|Users)\/[a-z]/i);
    // Every human-readable label is explicitly a placeholder.
    expect(conversation().title).toMatch(/Example/);
  });
});
