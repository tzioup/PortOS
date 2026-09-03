import { useCallback, useEffect, useState } from 'react';
import { Save, Loader2, MessageCircle, ShieldCheck, ShieldAlert, RefreshCw, Clock } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import { useBeeperSettings } from '../../../hooks/useBeeperSettings';
import useMounted from '../../../hooks/useMounted';
import ConnectionStatusDot from '../../ui/ConnectionStatusDot';
import { getBeeperStatus, checkBeeperConnection } from '../../../services/api';

// The Beeper connection story (#30, fork issue #1): ingestion settings, the
// tri-state status card, token expiry, and the read-only account roster #27's
// schema mirrors. #35 turned `/messages/beeper` into the chat surface itself,
// so this MOVED off the page body and into a settings drawer over it — the
// same treatment iMessage gives its own ingestion config (`?settings=1`).
// It is reachable, not removed: an actionable fault renders HERE and never as
// a global banner (#12 decision 4).
//
// `realtime` is a PROP rather than another `useBeeperRealtime()` call. The hook
// emits `beeper:unsubscribe` on unmount, so a second instance inside a drawer
// would tear the surface's subscription down every time the drawer closed.
// One subscriber per page; the page owns it.
export default function BeeperSettingsPanel({ realtime: realtimeProp = null, onRealtimeSeed }) {
  const {
    loading: settingsLoading, form, setForm, saving, dirty, save,
  } = useBeeperSettings();
  const [status, setStatus] = useState(null);
  // Distinguishes "the GET failed" from "the GET succeeded and says no token
  // is configured" — the absent-vs-empty rule (root AGENTS.md). Collapsing
  // both into `status = null` would tell a working-token install to
  // "Connect Beeper" just because the status request itself errored.
  const [statusError, setStatusError] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusRetrying, setStatusRetrying] = useState(false);
  const [checking, setChecking] = useState(false);
  const mountedRef = useMounted();

  const loadStatus = useCallback(async () => {
    const [result, error] = await getBeeperStatus({ silent: true })
      .then((value) => [value, null])
      .catch((err) => [null, err]);
    if (!mountedRef.current) return;
    setStatus(result);
    setStatusError(error ? (error?.message || 'Could not read Beeper status') : null);
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Transport liveness (#33). The socket is the live source; the status GET
  // carries the same snapshot, handed up so the dot is right before the first
  // socket frame lands.
  useEffect(() => {
    if (status?.realtime) onRealtimeSeed?.(status.realtime);
  }, [status?.realtime, onRealtimeSeed]);

  const retryStatus = async () => {
    setStatusRetrying(true);
    await loadStatus();
    if (mountedRef.current) setStatusRetrying(false);
  };

  const handleSave = async () => {
    if (!await save()) return;
    toast.success('Saved');
    loadStatus();
  };

  const handleCheck = async () => {
    setChecking(true);
    const result = await checkBeeperConnection({ silent: true }).catch((err) => ({ ok: false, error: err?.message || 'Could not reach Beeper Desktop' }));
    setChecking(false);
    if (result?.reachable) {
      toast.success(`Beeper Desktop reachable${result.info?.app?.version ? ` — v${result.info.app.version}` : ''}`);
    } else {
      toast.error(result?.error || 'Could not reach Beeper Desktop');
    }
    loadStatus();
  };

  if (settingsLoading) return <BrailleSpinner text="Loading Beeper settings" />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <MessageCircle size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Beeper ingestion</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Talks to the local Beeper Desktop API (default <code className="text-gray-300">{form.baseUrl}</code>) to
          mirror bridged-network conversations — WhatsApp, Discord, Telegram, Instagram, X, Slack, and more —
          into PortOS. Machine-local; nothing federates to peers. Connecting a token is handled separately from
          this settings card.
        </p>

        <div className="space-y-3">
          <label htmlFor="beeper-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="beeper-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
              className="w-4 h-4 accent-port-accent"
            />
            Enable scheduled Beeper sync
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="beeper-interval" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Sync interval (minutes)
              </label>
              <input
                id="beeper-interval"
                type="number"
                min={1}
                max={1440}
                value={form.intervalMinutes}
                onChange={(e) => setForm((prev) => ({ ...prev, intervalMinutes: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
            <div>
              <label htmlFor="beeper-budget" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Attachment budget (GB)
              </label>
              <input
                id="beeper-budget"
                type="number"
                min={0.1}
                step={0.1}
                max={1000}
                value={form.attachmentBudgetGb}
                onChange={(e) => setForm((prev) => ({ ...prev, attachmentBudgetGb: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
              />
            </div>
            <div className="sm:col-span-1">
              <label htmlFor="beeper-base-url" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
                Base URL
              </label>
              <input
                id="beeper-base-url"
                type="text"
                value={form.baseUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
              />
            </div>
          </div>

          <div className="pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {statusLoading ? (
        <BrailleSpinner text="Checking Beeper status" />
      ) : (
        <BeeperStatusCard
          status={status}
          realtime={realtimeProp || status?.realtime || null}
          error={statusError}
          checking={checking}
          onCheck={handleCheck}
          checkDisabled={dirty || saving}
          onRetryStatus={retryStatus}
          retryingStatus={statusRetrying}
        />
      )}
    </div>
  );
}

// Shown whenever a stored token is inside the expiry warning window,
// regardless of whether Beeper Desktop is currently reachable — an expired
// token is exactly as actionable on an unreachable install as on a
// connected one, so this renders in both the `reachable === false` and
// `reachable === true` branches below.
function TokenExpiryNotice({ status }) {
  if (!status?.tokenExpiringSoon) return null;
  const days = status.tokenExpiresInDays;
  const label = Number.isFinite(days) && days <= 0
    ? 'Token has expired — reconnect to keep syncing.'
    : `Token expires in ${days} day(s) — reconnect soon.`;
  return (
    <p className="text-xs text-port-warning flex items-center gap-1.5">
      <Clock size={12} />
      {label}
    </p>
  );
}

// The transport liveness row (#33 decision 4): a Moltworld-shape dot, and — on
// the same card, never in a global banner — the one `app.state` value a human
// has to act on. `initializing` is deliberately absent from the actionable set:
// it was measured lying for 105 continuous seconds on a fully working install,
// so surfacing it would train the user to ignore this line.
const APP_STATE_REMEDY = {
  'needs-login': 'Beeper Desktop needs you to sign in again.',
  'needs-verification': 'Beeper Desktop needs this device verified.',
  'needs-secrets': 'Beeper Desktop is missing its encryption secrets.',
  'needs-cross-signing-setup': 'Beeper Desktop needs cross-signing set up.',
};

function BeeperRealtimeRow({ realtime }) {
  // `null` = the transport has not reported yet. Never rendered as offline.
  if (!realtime?.state) return null;
  const remedy = realtime.appStateActionable ? APP_STATE_REMEDY[realtime.appState] : null;
  return (
    <div className="space-y-1">
      <ConnectionStatusDot status={realtime.state} label="Realtime:" />
      {remedy && (
        <p className="text-xs text-port-warning flex items-center gap-1.5">
          <ShieldAlert size={12} />
          {remedy}
        </p>
      )}
    </div>
  );
}

// Every state the status card can be in, decided at fork issue #11 and
// carried into #30's Acceptance criteria. `reachable` is read with strict
// equality throughout (`=== false` / `=== true` / `=== null`) — never
// truthiness — so the absent-vs-empty sentinel (`null` = not yet probed)
// can never fall through to the "offline" branch. A failed status fetch is
// handled by the `error` branch immediately below, before any of this ever
// runs, so a broken GET can never collapse into "no token configured".
function BeeperStatusCard({
  status, realtime, error, checking, onCheck, checkDisabled, onRetryStatus, retryingStatus,
}) {
  if (error) {
    return (
      <div className="bg-port-card border border-port-error/40 rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert size={16} className="text-port-error" />
          <h3 className="text-sm font-semibold text-white">Could not read Beeper status</h3>
        </div>
        <p className="text-sm text-port-error">{error}</p>
        <button
          type="button"
          onClick={onRetryStatus}
          disabled={retryingStatus}
          className="mt-3 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
        >
          {retryingStatus ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Retry
        </button>
      </div>
    );
  }

  if (!status?.tokenConfigured) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <MessageCircle size={16} className="text-gray-400" />
          <h3 className="text-sm font-semibold text-white">Connect Beeper</h3>
        </div>
        <p className="text-sm text-gray-400">
          Beeper is a local desktop app that bridges WhatsApp, Discord, Telegram, and other networks into one
          API on this machine — PortOS talks to it over loopback, never over the network.
        </p>
        <button
          type="button"
          disabled
          title="Connecting a Beeper token lands in a follow-up issue"
          className="mt-3 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border text-gray-500 rounded-lg text-sm cursor-not-allowed"
        >
          Connect Beeper
        </button>
      </div>
    );
  }

  if (status.reachable === false) {
    return (
      <div className="bg-port-card border border-port-error/40 rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldAlert size={16} className="text-port-error" />
          <h3 className="text-sm font-semibold text-white">Beeper Desktop unreachable</h3>
        </div>
        <p className="text-sm text-port-error">{status.lastProbeError || 'Could not reach Beeper Desktop.'}</p>
        <p className="text-xs text-gray-500 mt-1">Checked against {status.baseUrl}.</p>
        <TokenExpiryNotice status={status} />
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || checkDisabled}
          title={checkDisabled ? 'Save your changes before rechecking' : undefined}
          className="mt-3 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
        >
          {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Retry
        </button>
      </div>
    );
  }

  if (status.reachable === true) {
    const accounts = Array.isArray(status.accounts) ? status.accounts : [];
    return (
      <div className="bg-port-card border border-port-success/40 rounded-lg p-4 sm:p-6 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-port-success" />
          <h3 className="text-sm font-semibold text-white">Beeper Desktop connected</h3>
          {status.appVersion && <span className="text-xs text-gray-500">v{status.appVersion}</span>}
        </div>
        <TokenExpiryNotice status={status} />
        <BeeperRealtimeRow realtime={realtime} />
        {accounts.length === 0 ? (
          <p className="text-sm text-gray-500">No accounts synced yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {accounts.map((account) => (
              <li key={account.accountId} className="flex items-center justify-between text-sm text-gray-300 border-t border-port-border pt-1.5 first:border-t-0 first:pt-0">
                <span>{account.displayName || account.accountId}</span>
                <span className="text-xs text-gray-500 uppercase">{account.network || '—'}</span>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || checkDisabled}
          title={checkDisabled ? 'Save your changes before rechecking' : undefined}
          className="inline-flex items-center justify-center gap-2 min-h-[36px] px-3 py-1.5 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-xs transition-colors disabled:opacity-40"
        >
          {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Recheck
        </button>
      </div>
    );
  }

  // reachable === null: a token is configured but the probe never ran (a
  // transient gap between saving settings and the status refresh landing).
  // Neutral, never rendered as offline.
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <Loader2 size={16} className="text-gray-400 animate-spin" />
        <h3 className="text-sm font-semibold text-white">Checking Beeper Desktop…</h3>
      </div>
    </div>
  );
}
