import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getBeeperStatus: vi.fn(),
  checkBeeperConnection: vi.fn(),
  startBeeperOAuth: vi.fn(),
  saveBeeperToken: vi.fn(),
  disconnectBeeper: vi.fn(),
  getBeeperAttachmentSummary: vi.fn(),
  backfillBeeperAttachments: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const BeeperSettingsPanel = (await import('./BeeperSettingsPanel')).default;

const BASE_SETTINGS = { beeper: { enabled: false, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 } };

// No router: the panel takes `realtime` as a prop and reads nothing off the
// URL — the OAuth outcome flag is the page shell's job, covered by the page's
// own suite.
const renderPanel = (props = {}) => render(<BeeperSettingsPanel {...props} />);

const BASE_ATTACHMENT_SUMMARY = {
  budgetBytes: 5 * 1024 * 1024 * 1024,
  usedBytes: 1024 * 1024,
  storedFiles: 2,
  pendingCount: 0,
  pendingBytes: 0,
  pendingUnknownCount: 0,
  overCapCount: 0,
  unavailableCount: 0,
  keptCount: 0,
  totalCount: 2,
  maxBytes: 32 * 1024 * 1024,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue(BASE_SETTINGS);
  api.getBeeperAttachmentSummary.mockResolvedValue(BASE_ATTACHMENT_SUMMARY);
});

// The three states decided at fork issue #11 and carried into #30's
// Acceptance criteria, plus the defensive fourth (absent-vs-empty sentinel).
describe('BeeperSettingsPanel — status card states', () => {
  it('offers both connect paths and nothing else when no token is configured', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: false, reachable: null, lastProbeError: null, accounts: [],
    });
    renderPanel();

    expect(await screen.findByRole('heading', { name: 'Connect Beeper' })).toBeInTheDocument();
    // Both paths are first-class (#11 decision 3), so both are on screen at once.
    expect(screen.getByRole('button', { name: 'Connect Beeper' })).not.toBeDisabled();
    expect(screen.getByLabelText('Or paste an access token')).toBeInTheDocument();
    expect(screen.queryByText('Beeper Desktop unreachable')).toBeNull();
    expect(screen.queryByText('Beeper Desktop connected')).toBeNull();
    expect(screen.queryByText('Checking Beeper Desktop…')).toBeNull();
  });

  it('renders the actionable-fault card with a Retry when a token is present but unreachable', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: false, lastProbeError: 'Beeper request failed: connection refused', baseUrl: 'http://127.0.0.1:23373', accounts: [],
    });
    renderPanel();

    expect(await screen.findByText('Beeper Desktop unreachable')).toBeInTheDocument();
    expect(screen.getByText('Beeper request failed: connection refused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('renders the connected state with "No accounts synced yet" when the mirror is empty', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, lastProbeError: null, appVersion: '4.3.73', accounts: [],
    });
    renderPanel();

    expect(await screen.findByText('Beeper Desktop connected')).toBeInTheDocument();
    expect(screen.getByText('No accounts synced yet.')).toBeInTheDocument();
  });

  it('renders the connected state with the account roster when accounts are mirrored', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, lastProbeError: null, accounts: [
        { accountId: 'acc1', displayName: 'Example WhatsApp', network: 'whatsapp' },
      ],
    });
    renderPanel();

    expect(await screen.findByText('Example WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('whatsapp')).toBeInTheDocument();
  });

  it('renders the transport liveness dot from the status payload, with its actionable app.state remedy (#33)', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true,
      reachable: true,
      lastProbeError: null,
      accounts: [],
      realtime: {
        state: 'reconnecting', lastEventAt: null, lastPingAt: null, appState: 'needs-login', appStateActionable: true,
      },
    });
    renderPanel();

    await screen.findByText('Beeper Desktop connected');
    expect(screen.getByTestId('connection-status-dot')).toHaveAttribute('data-status', 'reconnecting');
    expect(screen.getByText('Beeper Desktop needs you to sign in again.')).toBeInTheDocument();
  });

  it('renders the liveness row while Beeper Desktop is unreachable — the probe failing is when it matters', async () => {
    // The HTTP probe and the WebSocket are different transports: hiding the dot
    // and its remedy inside the reachable branch hid them exactly when a human
    // needed them.
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true,
      reachable: false,
      lastProbeError: 'Beeper request failed: connection refused',
      baseUrl: 'http://127.0.0.1:23373',
      accounts: [],
      realtime: {
        state: 'connecting', lastEventAt: null, lastPingAt: null, appState: 'needs-login', appStateActionable: true,
      },
    });
    renderPanel();

    await screen.findByText('Beeper Desktop unreachable');
    expect(screen.getByTestId('connection-status-dot')).toHaveAttribute('data-status', 'connecting');
    expect(screen.getByText('Beeper Desktop needs you to sign in again.')).toBeInTheDocument();
  });

  it('names the remedy when Beeper rejected the stored token (#33)', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true,
      reachable: null,
      lastProbeError: null,
      accounts: [],
      realtime: {
        state: 'down', lastEventAt: null, lastPingAt: null, appState: null, appStateActionable: false, authRejected: true,
      },
    });
    renderPanel();

    await screen.findByText('Checking Beeper Desktop…');
    expect(screen.getByTestId('connection-status-dot')).toHaveAttribute('data-status', 'down');
    expect(screen.getByText('Beeper Desktop rejected the stored token — reconnect Beeper.')).toBeInTheDocument();
  });

  // #31's expired-token card and #33's 401 stand-down describe the same
  // credential from two transports, so they have to read as one story: the dot
  // corroborates that the socket is down for that reason (and not looping),
  // while the "reconnect Beeper" instruction is said once, by the card.
  it('shows the transport down on the expired-token card without repeating its remedy', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true,
      reachable: null,
      lastProbeError: null,
      accounts: [],
      tokenExpired: true,
      tokenExpiresAt: '2020-01-01T00:00:00.000Z',
      realtime: {
        state: 'down', lastEventAt: null, lastPingAt: null, appState: null, appStateActionable: false, authRejected: true,
      },
    });
    renderPanel();

    await screen.findByText('Beeper token expired');
    expect(screen.getByTestId('connection-status-dot')).toHaveAttribute('data-status', 'down');
    expect(screen.getByRole('button', { name: 'Reconnect Beeper' })).toBeInTheDocument();
    expect(screen.queryByText('Beeper Desktop rejected the stored token — reconnect Beeper.')).toBeNull();
  });

  it('renders no liveness row at all when the transport has never reported', async () => {
    // `realtime` absent is not-yet-known, never "offline" — the same
    // absent-vs-empty rule the `reachable` tri-state follows.
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, lastProbeError: null, accounts: [],
    });
    renderPanel();

    await screen.findByText('Beeper Desktop connected');
    expect(screen.queryByTestId('connection-status-dot')).toBeNull();
  });

  // The absent-vs-empty sentinel (#30 Acceptance): reachable:null must never
  // render as offline, even in the (normally unreachable) case where a token
  // is configured but the probe never ran.
  it('never renders reachable:null as offline', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: null, lastProbeError: null, accounts: [],
    });
    renderPanel();

    expect(await screen.findByText('Checking Beeper Desktop…')).toBeInTheDocument();
    expect(screen.queryByText('Beeper Desktop unreachable')).toBeNull();
  });

  // The absent-vs-empty rule (root AGENTS.md line 233): a status fetch that
  // itself fails must never collapse into "no token configured" — an
  // install with a working token whose status request errors would
  // otherwise be silently told to connect.
  it('never renders "Connect Beeper" when the status fetch itself rejects', async () => {
    api.getBeeperStatus.mockRejectedValue(new Error('network down'));
    renderPanel();

    expect(await screen.findByText('Could not read Beeper status')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Connect Beeper' })).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });
});

describe('BeeperSettingsPanel — settings', () => {
  it('saves the complete settings slice and disables Save until dirty', async () => {
    api.getBeeperStatus.mockResolvedValue({ tokenConfigured: false, reachable: null, accounts: [] });
    api.updateSettings.mockResolvedValue({
      beeper: { enabled: true, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 },
    });
    renderPanel();

    // Exact, not /Save/: the connect card's "Save token" is on screen too.
    const saveButton = await screen.findByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText('Enable scheduled Beeper sync'));
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({
      beeper: { enabled: true, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 },
    }));
    expect(toast.success).toHaveBeenCalled();
  });

  it('disables Retry while the form has unsaved edits, per the save-gating convention', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: false, lastProbeError: 'refused', baseUrl: 'http://127.0.0.1:23373', accounts: [],
    });
    renderPanel();

    await screen.findByText('Beeper Desktop unreachable');
    const retryButton = screen.getByRole('button', { name: /Retry/ });
    expect(retryButton).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText('Enable scheduled Beeper sync'));
    expect(retryButton).toBeDisabled();
  });
});

describe('BeeperSettingsPanel — the connect flow (#31)', () => {
  beforeEach(() => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: false, reachable: null, lastProbeError: null, accounts: [],
    });
  });

  it('opens the authorization URL the server minted, rather than building one client-side', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    api.startBeeperOAuth.mockResolvedValue({ authorizationUrl: 'http://127.0.0.1:23373/oauth/authorize?state=s' });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Beeper' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('http://127.0.0.1:23373/oauth/authorize?state=s', '_blank', 'noopener'));
    expect(api.startBeeperOAuth).toHaveBeenCalledWith({ silent: true });
    open.mockRestore();
  });

  // Write paths never auto-retry (the connect exchange burns a single-use
  // code): one call, one toast, and no second attempt.
  it('reports a failed connect once and does not retry', async () => {
    api.startBeeperOAuth.mockRejectedValue(new Error('Beeper authorization-server metadata unavailable (404)'));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Beeper' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper authorization-server metadata unavailable (404)'));
    expect(api.startBeeperOAuth).toHaveBeenCalledTimes(1);
  });

  it('posts a pasted token, clears the field, and refreshes status', async () => {
    api.saveBeeperToken.mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted' });
    renderPanel();

    const input = await screen.findByLabelText('Or paste an access token');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'example-beeper-token' } });
    fireEvent.click(screen.getByRole('button', { name: /Save token/ }));

    await waitFor(() => expect(api.saveBeeperToken).toHaveBeenCalledWith('example-beeper-token', { silent: true }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(api.getBeeperStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps Save token disabled until something is typed', async () => {
    renderPanel();
    const save = await screen.findByRole('button', { name: /Save token/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Or paste an access token'), { target: { value: 'example-beeper-token' } });
    expect(save).not.toBeDisabled();
  });

});

// An expired credential is its own state: Beeper issues no refresh grant, so
// the only action that helps is connecting again — never a generic error.
describe('BeeperSettingsPanel — expired token', () => {
  it('renders the reconnect path rather than the unreachable or connected card', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, tokenSource: 'oauth', tokenExpired: true, tokenExpiringSoon: true,
      tokenExpiresAt: '2026-01-01T00:00:00.000Z', tokenExpiresInDays: -3,
      reachable: false, lastProbeError: 'connection refused', accounts: [],
    });
    renderPanel();

    expect(await screen.findByText('Beeper token expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Beeper' })).toBeInTheDocument();
    expect(screen.queryByText('Beeper Desktop unreachable')).toBeNull();
  });
});

describe('BeeperSettingsPanel — disconnect', () => {
  beforeEach(() => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, tokenSource: 'pasted', reachable: true, lastProbeError: null, accounts: [],
    });
  });

  // No window.confirm anywhere in the client — the confirmation is inline.
  it('confirms inline before disconnecting', async () => {
    api.disconnectBeeper.mockResolvedValue({ deleted: true, tokenConfigured: false });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Disconnect/ }));
    expect(screen.getByText('Forget this Beeper credential?')).toBeInTheDocument();
    expect(api.disconnectBeeper).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Yes, disconnect/ }));
    await waitFor(() => expect(api.disconnectBeeper).toHaveBeenCalledWith({ silent: true }));
    await waitFor(() => expect(api.getBeeperStatus).toHaveBeenCalledTimes(2));
  });

  it('cancels without calling the API', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Disconnect/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Forget this Beeper credential?')).toBeNull();
    expect(api.disconnectBeeper).not.toHaveBeenCalled();
  });
});

// The attachment mirror card (#37). The bulk backfill is the one path here
// that moves gigabytes, so what is pinned is that it cannot start without a
// consent step that states the cost.
describe('BeeperSettingsPanel — attachment mirror', () => {
  beforeEach(() => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, tokenSource: 'pasted', reachable: true, lastProbeError: null, accounts: [],
    });
  });

  it('renders the disk picture without starting anything', async () => {
    renderPanel();
    expect(await screen.findByText('Attachment mirror')).toBeInTheDocument();
    expect(screen.getByText(/of 5 GB/)).toBeInTheDocument();
    expect(api.backfillBeeperAttachments).not.toHaveBeenCalled();
  });

  it('names the count and the byte size before the backfill runs, and only then runs it', async () => {
    api.getBeeperAttachmentSummary.mockResolvedValue({
      ...BASE_ATTACHMENT_SUMMARY, pendingCount: 12, pendingBytes: 4 * 1024 * 1024, pendingUnknownCount: 3,
    });
    api.backfillBeeperAttachments.mockResolvedValue({ fetched: 12, failed: 0, bytes: 4194304, stoppedForBudget: false });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Mirror all attachments/i }));
    // The modal states BOTH numbers, and the unknown-size tail separately
    // rather than folding it into the total as zero.
    expect(await screen.findByText('Mirror all attachments?')).toBeInTheDocument();
    expect(screen.getAllByText(/12 attachment\(s\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/4 MB/)).toBeInTheDocument();
    expect(screen.getByText(/3 whose size Beeper did not report/)).toBeInTheDocument();
    expect(api.backfillBeeperAttachments).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Mirror 12 attachment/i }));
    await waitFor(() => expect(api.backfillBeeperAttachments).toHaveBeenCalledTimes(1));
  });

  it('cancels the consent modal without transferring anything', async () => {
    api.getBeeperAttachmentSummary.mockResolvedValue({ ...BASE_ATTACHMENT_SUMMARY, pendingCount: 4, pendingBytes: 2048 });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Mirror all attachments/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Cancel$/ }));
    await waitFor(() => expect(screen.queryByText(/Mirror all attachments\?/)).not.toBeInTheDocument());
    expect(api.backfillBeeperAttachments).not.toHaveBeenCalled();
  });

  it('reports a failed summary read instead of rendering zeros as the truth', async () => {
    api.getBeeperAttachmentSummary.mockRejectedValue(new Error('Database unavailable'));
    renderPanel();
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mirror all attachments/i })).not.toBeInTheDocument();
  });
});
