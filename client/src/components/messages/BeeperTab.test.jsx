import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getBeeperStatus: vi.fn(),
  checkBeeperConnection: vi.fn(),
  startBeeperOAuth: vi.fn(),
  saveBeeperToken: vi.fn(),
  disconnectBeeper: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

const BeeperTab = (await import('./BeeperTab')).default;

const BASE_SETTINGS = { beeper: { enabled: false, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 } };

// The tab reads the OAuth outcome off the URL (`?beeperConnected=1` /
// `?beeperOauthError=…`), so every case renders inside a router.
const renderTab = (entry = '/messages/beeper') => render(
  <MemoryRouter initialEntries={[entry]}>
    <BeeperTab />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue(BASE_SETTINGS);
});

// The three states decided at fork issue #11 and carried into #30's
// Acceptance criteria, plus the defensive fourth (absent-vs-empty sentinel).
describe('BeeperTab — status card states', () => {
  it('offers both connect paths and nothing else when no token is configured', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: false, reachable: null, lastProbeError: null, accounts: [],
    });
    renderTab();

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
    renderTab();

    expect(await screen.findByText('Beeper Desktop unreachable')).toBeInTheDocument();
    expect(screen.getByText('Beeper request failed: connection refused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('renders the connected state with "No accounts synced yet" when the mirror is empty', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, lastProbeError: null, appVersion: '4.3.73', accounts: [],
    });
    renderTab();

    expect(await screen.findByText('Beeper Desktop connected')).toBeInTheDocument();
    expect(screen.getByText('No accounts synced yet.')).toBeInTheDocument();
  });

  it('renders the connected state with the account roster when accounts are mirrored', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, lastProbeError: null, accounts: [
        { accountId: 'acc1', displayName: 'Example WhatsApp', network: 'whatsapp' },
      ],
    });
    renderTab();

    expect(await screen.findByText('Example WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('whatsapp')).toBeInTheDocument();
  });

  // The absent-vs-empty sentinel (#30 Acceptance): reachable:null must never
  // render as offline, even in the (normally unreachable) case where a token
  // is configured but the probe never ran.
  it('never renders reachable:null as offline', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: null, lastProbeError: null, accounts: [],
    });
    renderTab();

    expect(await screen.findByText('Checking Beeper Desktop…')).toBeInTheDocument();
    expect(screen.queryByText('Beeper Desktop unreachable')).toBeNull();
  });

  // The absent-vs-empty rule (root AGENTS.md line 233): a status fetch that
  // itself fails must never collapse into "no token configured" — an
  // install with a working token whose status request errors would
  // otherwise be silently told to connect.
  it('never renders "Connect Beeper" when the status fetch itself rejects', async () => {
    api.getBeeperStatus.mockRejectedValue(new Error('network down'));
    renderTab();

    expect(await screen.findByText('Could not read Beeper status')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Connect Beeper' })).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });
});

describe('BeeperTab — settings', () => {
  it('saves the complete settings slice and disables Save until dirty', async () => {
    api.getBeeperStatus.mockResolvedValue({ tokenConfigured: false, reachable: null, accounts: [] });
    api.updateSettings.mockResolvedValue({
      beeper: { enabled: true, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 },
    });
    renderTab();

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
    renderTab();

    await screen.findByText('Beeper Desktop unreachable');
    const retryButton = screen.getByRole('button', { name: /Retry/ });
    expect(retryButton).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText('Enable scheduled Beeper sync'));
    expect(retryButton).toBeDisabled();
  });
});

describe('BeeperTab — the connect flow (#31)', () => {
  beforeEach(() => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: false, reachable: null, lastProbeError: null, accounts: [],
    });
  });

  it('opens the authorization URL the server minted, rather than building one client-side', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    api.startBeeperOAuth.mockResolvedValue({ authorizationUrl: 'http://127.0.0.1:23373/oauth/authorize?state=s' });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Beeper' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('http://127.0.0.1:23373/oauth/authorize?state=s', '_blank', 'noopener'));
    expect(api.startBeeperOAuth).toHaveBeenCalledWith({ silent: true });
    open.mockRestore();
  });

  // Write paths never auto-retry (the connect exchange burns a single-use
  // code): one call, one toast, and no second attempt.
  it('reports a failed connect once and does not retry', async () => {
    api.startBeeperOAuth.mockRejectedValue(new Error('Beeper authorization-server metadata unavailable (404)'));
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Beeper' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper authorization-server metadata unavailable (404)'));
    expect(api.startBeeperOAuth).toHaveBeenCalledTimes(1);
  });

  it('posts a pasted token, clears the field, and refreshes status', async () => {
    api.saveBeeperToken.mockResolvedValue({ tokenConfigured: true, tokenExpiresAt: null, tokenSource: 'pasted' });
    renderTab();

    const input = await screen.findByLabelText('Or paste an access token');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'example-beeper-token' } });
    fireEvent.click(screen.getByRole('button', { name: /Save token/ }));

    await waitFor(() => expect(api.saveBeeperToken).toHaveBeenCalledWith('example-beeper-token', { silent: true }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(api.getBeeperStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps Save token disabled until something is typed', async () => {
    renderTab();
    const save = await screen.findByRole('button', { name: /Save token/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Or paste an access token'), { target: { value: 'example-beeper-token' } });
    expect(save).not.toBeDisabled();
  });

  it('reports the OAuth outcome carried back on the URL', async () => {
    renderTab('/messages/beeper?beeperConnected=1');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Beeper connected'));
  });

  it('reports an OAuth failure carried back on the URL instead of a blank connect card', async () => {
    renderTab('/messages/beeper?beeperOauthError=access_denied');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Beeper connect failed: access_denied'));
  });
});

// An expired credential is its own state: Beeper issues no refresh grant, so
// the only action that helps is connecting again — never a generic error.
describe('BeeperTab — expired token', () => {
  it('renders the reconnect path rather than the unreachable or connected card', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, tokenSource: 'oauth', tokenExpired: true, tokenExpiringSoon: true,
      tokenExpiresAt: '2026-01-01T00:00:00.000Z', tokenExpiresInDays: -3,
      reachable: false, lastProbeError: 'connection refused', accounts: [],
    });
    renderTab();

    expect(await screen.findByText('Beeper token expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Beeper' })).toBeInTheDocument();
    expect(screen.queryByText('Beeper Desktop unreachable')).toBeNull();
  });
});

describe('BeeperTab — disconnect', () => {
  beforeEach(() => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, tokenSource: 'pasted', reachable: true, lastProbeError: null, accounts: [],
    });
  });

  // No window.confirm anywhere in the client — the confirmation is inline.
  it('confirms inline before disconnecting', async () => {
    api.disconnectBeeper.mockResolvedValue({ deleted: true, tokenConfigured: false });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: /Disconnect/ }));
    expect(screen.getByText('Forget this Beeper credential?')).toBeInTheDocument();
    expect(api.disconnectBeeper).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Yes, disconnect/ }));
    await waitFor(() => expect(api.disconnectBeeper).toHaveBeenCalledWith({ silent: true }));
    await waitFor(() => expect(api.getBeeperStatus).toHaveBeenCalledTimes(2));
  });

  it('cancels without calling the API', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: /Disconnect/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Forget this Beeper credential?')).toBeNull();
    expect(api.disconnectBeeper).not.toHaveBeenCalled();
  });
});
