import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getBeeperStatus: vi.fn(),
  checkBeeperConnection: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const BeeperSettingsPanel = (await import('./BeeperSettingsPanel')).default;

const BASE_SETTINGS = { beeper: { enabled: false, intervalMinutes: 5, baseUrl: 'http://127.0.0.1:23373', attachmentBudgetGb: 5 } };

beforeEach(() => {
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue(BASE_SETTINGS);
});

// The three states decided at fork issue #11 and carried into #30's
// Acceptance criteria, plus the defensive fourth (absent-vs-empty sentinel).
describe('BeeperSettingsPanel — status card states', () => {
  it('renders the Connect action and nothing else when no token is configured', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: false, reachable: null, lastProbeError: null, accounts: [],
    });
    render(<BeeperSettingsPanel />);

    expect(await screen.findByRole('heading', { name: 'Connect Beeper' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Beeper' })).toBeDisabled();
    expect(screen.queryByText('Beeper Desktop unreachable')).toBeNull();
    expect(screen.queryByText('Beeper Desktop connected')).toBeNull();
    expect(screen.queryByText('Checking Beeper Desktop…')).toBeNull();
  });

  it('renders the actionable-fault card with a Retry when a token is present but unreachable', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: false, lastProbeError: 'Beeper request failed: connection refused', baseUrl: 'http://127.0.0.1:23373', accounts: [],
    });
    render(<BeeperSettingsPanel />);

    expect(await screen.findByText('Beeper Desktop unreachable')).toBeInTheDocument();
    expect(screen.getByText('Beeper request failed: connection refused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('renders the connected state with "No accounts synced yet" when the mirror is empty', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, lastProbeError: null, appVersion: '4.3.73', accounts: [],
    });
    render(<BeeperSettingsPanel />);

    expect(await screen.findByText('Beeper Desktop connected')).toBeInTheDocument();
    expect(screen.getByText('No accounts synced yet.')).toBeInTheDocument();
  });

  it('renders the connected state with the account roster when accounts are mirrored', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, lastProbeError: null, accounts: [
        { accountId: 'acc1', displayName: 'Example WhatsApp', network: 'whatsapp' },
      ],
    });
    render(<BeeperSettingsPanel />);

    expect(await screen.findByText('Example WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('whatsapp')).toBeInTheDocument();
  });

  // The absent-vs-empty sentinel (#30 Acceptance): reachable:null must never
  // render as offline, even in the (normally unreachable) case where a token
  // is configured but the probe never ran.
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
    render(<BeeperSettingsPanel />);

    await screen.findByText('Beeper Desktop connected');
    expect(screen.getByTestId('connection-status-dot')).toHaveAttribute('data-status', 'reconnecting');
    expect(screen.getByText('Beeper Desktop needs you to sign in again.')).toBeInTheDocument();
  });

  it('renders no liveness row at all when the transport has never reported', async () => {
    // `realtime` absent is not-yet-known, never "offline" — the same
    // absent-vs-empty rule the `reachable` tri-state follows.
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: true, lastProbeError: null, accounts: [],
    });
    render(<BeeperSettingsPanel />);

    await screen.findByText('Beeper Desktop connected');
    expect(screen.queryByTestId('connection-status-dot')).toBeNull();
  });

  it('never renders reachable:null as offline', async () => {
    api.getBeeperStatus.mockResolvedValue({
      tokenConfigured: true, reachable: null, lastProbeError: null, accounts: [],
    });
    render(<BeeperSettingsPanel />);

    expect(await screen.findByText('Checking Beeper Desktop…')).toBeInTheDocument();
    expect(screen.queryByText('Beeper Desktop unreachable')).toBeNull();
  });

  // The absent-vs-empty rule (root AGENTS.md line 233): a status fetch that
  // itself fails must never collapse into "no token configured" — an
  // install with a working token whose status request errors would
  // otherwise be silently told to connect.
  it('never renders "Connect Beeper" when the status fetch itself rejects', async () => {
    api.getBeeperStatus.mockRejectedValue(new Error('network down'));
    render(<BeeperSettingsPanel />);

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
    render(<BeeperSettingsPanel />);

    const saveButton = await screen.findByRole('button', { name: /Save/ });
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
    render(<BeeperSettingsPanel />);

    await screen.findByText('Beeper Desktop unreachable');
    const retryButton = screen.getByRole('button', { name: /Retry/ });
    expect(retryButton).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText('Enable scheduled Beeper sync'));
    expect(retryButton).toBeDisabled();
  });
});
