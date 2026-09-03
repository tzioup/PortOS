import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Save, Loader2, MessageCircle, ShieldCheck, ShieldAlert, RefreshCw, Clock, Link2, Unlink } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { useBeeperSettings } from '../../hooks/useBeeperSettings';
import useMounted from '../../hooks/useMounted';
import {
  getBeeperStatus, checkBeeperConnection, startBeeperOAuth, saveBeeperToken, disconnectBeeper,
} from '../../services/api';

// Comms → Messages → Beeper (#30 + #31, fork issue #1). Instance feature gate +
// nav entry + settings + status card + the connect flow. The chat surface
// itself (rail, pinned grid, thread, composer) is fork issue #35 — this page
// has nothing to browse yet, only the connection story: is a credential
// configured, is Beeper Desktop reachable, and the read-only account roster
// #27's schema mirrors (empty until #32's ingestion sweep lands).
//
// Two connect paths, both first-class (#11 decision 3): OAuth, which PortOS
// runs itself, and pasting a token, which is the only way to get one that never
// expires. Neither ever puts a token value into this component's state beyond
// the paste field the user typed it into, and no response here carries one.
export default function BeeperTab() {
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
  const [connecting, setConnecting] = useState(false);
  const [pastedToken, setPastedToken] = useState('');
  const [savingToken, setSavingToken] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
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

  // Beeper redirects the BROWSER back here after consent; the server callback
  // already exchanged the code and vaulted the token, so all that arrives is an
  // outcome flag. Report it once, then strip it so a reload doesn't repeat the
  // toast (same shape as the Google/Spotify callbacks elsewhere in Comms).
  const [searchParams, setSearchParams] = useSearchParams();
  const oauthConnected = searchParams.get('beeperConnected');
  const oauthError = searchParams.get('beeperOauthError');
  useEffect(() => {
    if (!oauthConnected && !oauthError) return;
    if (oauthError) toast.error(`Beeper connect failed: ${oauthError}`);
    else {
      toast.success('Beeper connected');
      loadStatus();
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('beeperConnected');
      next.delete('beeperOauthError');
      return next;
    }, { replace: true });
  }, [oauthConnected, oauthError, setSearchParams, loadStatus]);

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

  // Write paths never retry — a repeat exchange burns an already-used
  // authorization code — so each of these reports its failure once and stops.
  // `silent: true` because the catch owns the toast (client/src/AGENTS.md).
  const handleConnect = async () => {
    setConnecting(true);
    const result = await startBeeperOAuth({ silent: true })
      .catch((err) => ({ error: err?.message || 'Could not start the Beeper connect flow' }));
    if (!mountedRef.current) return;
    setConnecting(false);
    if (result?.error || !result?.authorizationUrl) {
      toast.error(result?.error || 'Could not start the Beeper connect flow');
      return;
    }
    window.open(result.authorizationUrl, '_blank', 'noopener');
    toast.success('Approve the request in the opened Beeper window');
  };

  const handleSaveToken = async (event) => {
    event.preventDefault();
    const token = pastedToken.trim();
    if (!token) return;
    setSavingToken(true);
    const result = await saveBeeperToken(token, { silent: true })
      .catch((err) => ({ error: err?.message || 'Could not save that Beeper token' }));
    if (!mountedRef.current) return;
    setSavingToken(false);
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    setPastedToken('');
    toast.success('Beeper token saved');
    loadStatus();
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    const result = await disconnectBeeper({ silent: true })
      .catch((err) => ({ error: err?.message || 'Could not disconnect Beeper' }));
    if (!mountedRef.current) return;
    setDisconnecting(false);
    setConfirmingDisconnect(false);
    if (result?.error) {
      toast.error(result.error);
      return;
    }
    toast.success('Beeper disconnected');
    loadStatus();
  };

  const connect = {
    onConnect: handleConnect,
    connecting,
    token: pastedToken,
    onTokenChange: setPastedToken,
    onSaveToken: handleSaveToken,
    savingToken,
    onDisconnect: handleDisconnect,
    disconnecting,
    confirmingDisconnect,
    onConfirmDisconnect: setConfirmingDisconnect,
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
          into PortOS. Machine-local; nothing federates to peers. Connecting is handled by the card below —
          the credential is encrypted at rest and never stored in settings.
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
          error={statusError}
          connect={connect}
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

// The two connect paths, side by side rather than one behind the other (#11
// decision 3): OAuth is the quick path, pasting is the durable one, because
// Beeper's own UI can mint a token that never expires and nothing in the OAuth
// surface accepts a lifetime. The pasted value goes straight to the vaulted
// write path — it is never echoed back, never stored in settings, and never
// read back into this field.
function BeeperConnectPanel({ connect, submitLabel = 'Connect Beeper' }) {
  return (
    <div className="space-y-4">
      <div>
        <button
          type="button"
          onClick={connect.onConnect}
          disabled={connect.connecting}
          className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {connect.connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
          {connect.connecting ? 'Opening Beeper…' : submitLabel}
        </button>
        <p className="text-xs text-gray-500 mt-1.5">
          Opens Beeper&apos;s approval screen and asks for read and send access. Tokens issued this way expire.
        </p>
      </div>

      <form onSubmit={connect.onSaveToken} className="space-y-2 border-t border-port-border pt-4">
        <label htmlFor="beeper-token" className="block text-xs uppercase tracking-wider text-gray-500">
          Or paste an access token
        </label>
        <p className="text-xs text-gray-500">
          Beeper&apos;s own settings can mint a token that never expires — the one credential the approval
          flow above cannot produce. PortOS stores it encrypted and never shows it again.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            id="beeper-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={connect.token}
            onChange={(e) => connect.onTokenChange(e.target.value)}
            placeholder="Access token"
            className="flex-1 min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
          />
          <button
            type="submit"
            disabled={!connect.token.trim() || connect.savingToken}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {connect.savingToken ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {connect.savingToken ? 'Saving…' : 'Save token'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Inline two-step confirmation — no window.confirm (client/src/AGENTS.md).
// Disconnecting revokes the credential where the authorization server supports
// it and always deletes the local copy, so it is worth a deliberate second
// click but not a modal.
function DisconnectButton({ connect }) {
  if (!connect.confirmingDisconnect) {
    return (
      <button
        type="button"
        onClick={() => connect.onConfirmDisconnect(true)}
        className="inline-flex items-center justify-center gap-2 min-h-[36px] px-3 py-1.5 bg-port-bg border border-port-border hover:border-port-error text-gray-300 rounded-lg text-xs transition-colors"
      >
        <Unlink size={12} />
        Disconnect
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-400">Forget this Beeper credential?</span>
      <button
        type="button"
        onClick={connect.onDisconnect}
        disabled={connect.disconnecting}
        className="inline-flex items-center justify-center gap-2 min-h-[36px] px-3 py-1.5 bg-port-error/20 hover:bg-port-error/30 text-port-error-text rounded-lg text-xs transition-colors disabled:opacity-40"
      >
        {connect.disconnecting ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />}
        {connect.disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
      </button>
      <button
        type="button"
        onClick={() => connect.onConfirmDisconnect(false)}
        disabled={connect.disconnecting}
        className="min-h-[36px] px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-40"
      >
        Cancel
      </button>
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

// Every state the status card can be in, decided at fork issue #11 and
// carried into #30's Acceptance criteria. `reachable` is read with strict
// equality throughout (`=== false` / `=== true` / `=== null`) — never
// truthiness — so the absent-vs-empty sentinel (`null` = not yet probed)
// can never fall through to the "offline" branch. A failed status fetch is
// handled by the `error` branch immediately below, before any of this ever
// runs, so a broken GET can never collapse into "no token configured".
function BeeperStatusCard({
  status, error, connect, checking, onCheck, checkDisabled, onRetryStatus, retryingStatus,
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
        <p className="text-sm text-gray-400 mb-4">
          Beeper is a local desktop app that bridges WhatsApp, Discord, Telegram, and other networks into one
          API on this machine — PortOS talks to it over loopback, never over the network.
        </p>
        <BeeperConnectPanel connect={connect} />
      </div>
    );
  }

  // An expired credential is its own state, not a generic API failure: there is
  // no refresh grant anywhere in Beeper's OAuth metadata, so the only way
  // forward is connecting again. Checked BEFORE reachability so a user whose
  // token lapsed while Beeper Desktop happens to be closed still gets the
  // action that fixes it rather than "unreachable".
  if (status.tokenExpired) {
    return (
      <div className="bg-port-card border border-port-warning/40 rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Clock size={16} className="text-port-warning" />
          <h3 className="text-sm font-semibold text-white">Beeper token expired</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Beeper issues no refresh grant, so an expired token is reconnected rather than renewed.
        </p>
        <BeeperConnectPanel connect={connect} submitLabel="Reconnect Beeper" />
        <div className="mt-4 border-t border-port-border pt-3">
          <DisconnectButton connect={connect} />
        </div>
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCheck}
            disabled={checking || checkDisabled}
            title={checkDisabled ? 'Save your changes before rechecking' : undefined}
            className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40"
          >
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Retry
          </button>
          <DisconnectButton connect={connect} />
        </div>
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
        <div className="flex flex-wrap items-center gap-2">
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
          <DisconnectButton connect={connect} />
        </div>
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
