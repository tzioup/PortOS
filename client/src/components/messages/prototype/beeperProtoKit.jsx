/* PROTOTYPE — issue #9. Throwaway.
 *
 * Atoms shared by all three variants: an avatar, a network mark, delivery
 * ticks, and the banners for the degraded states. Deliberately NOT a layout —
 * each variant is free to throw the structure out, which is the whole point of
 * the exercise. Anything here that dictates arrangement belongs in a variant.
 */
import { AlertTriangle, BellOff, Check, CheckCheck, Download, Paperclip, PlugZap } from 'lucide-react';
import { NETWORKS, networkLabel } from './beeperFixtures';

const initials = (name) => name.replace(/^#/, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function Avatar({ conv, size = 40 }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-port-border font-medium text-port-text-muted"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials(conv.title)}
    </div>
  );
}

/** The network mark, at three levels of loudness. The variants disagree about
 *  which level is right, which is the question this prototype exists to answer. */
export function NetworkMark({ network, level = 'badge' }) {
  const net = NETWORKS[network];
  if (!net) return null;
  if (level === 'dot') {
    return <span className="inline-block size-2 rounded-full" style={{ background: net.tint }} title={net.label} />;
  }
  if (level === 'text') {
    return (
      <span
        className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
        style={{ background: `${net.tint}22`, color: net.tint }}
      >
        {net.label}
      </span>
    );
  }
  // badge: the Beeper Desktop idiom — a small square overlaid on the avatar
  return (
    <span
      className="flex size-4 items-center justify-center rounded-[4px] text-[7px] font-bold text-white ring-2 ring-port-card"
      style={{ background: net.tint }}
      title={net.label}
    >
      {net.glyph}
    </span>
  );
}

export function AvatarWithBadge({ conv, size = 40 }) {
  return (
    <div className="relative shrink-0">
      <Avatar conv={conv} size={size} />
      <span className="absolute -bottom-0.5 -right-0.5">
        <NetworkMark network={conv.network} level="badge" />
      </span>
    </div>
  );
}

export function DeliveryMark({ state }) {
  if (!state) return null;
  const Icon = state === 'sent' ? Check : CheckCheck;
  return <Icon size={12} className={state === 'read' ? 'text-port-accent-text' : 'text-port-text-subtle'} />;
}

export function RowMeta({ conv, timeLabel }) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <span className="text-[10px] text-port-text-subtle">{timeLabel}</span>
      <div className="flex items-center gap-1">
        {conv.muted && <BellOff size={11} className="text-port-text-subtle" />}
        {conv.unread > 0 && (
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${conv.muted ? 'bg-port-border text-port-text-muted' : 'bg-port-accent text-port-on-accent'}`}>
            {conv.unread}
          </span>
        )}
      </div>
    </div>
  );
}

export function Preview({ conv }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-port-text-muted">
      {conv.direction === 'out' && <DeliveryMark state={conv.delivery} />}
      {conv.attachment && <Paperclip size={11} className="shrink-0 text-port-text-subtle" />}
      <span className="truncate">{conv.preview}</span>
    </span>
  );
}

/* ---------- degraded states ---------- */

export function OfflinePanel({ onRetry }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <PlugZap size={28} className="text-port-warning" />
      <p className="text-sm font-medium text-port-text">Can’t reach Beeper</p>
      <p className="max-w-md text-xs text-port-text-muted">
        Nothing answered on the local Beeper API. Open Beeper Desktop, or point PortOS at a
        different base URL if you run the headless server.
      </p>
      <div className="flex gap-2">
        <button type="button" onClick={onRetry} className="rounded border border-port-border bg-port-card px-3 py-1.5 text-xs text-port-text hover:border-port-accent">
          Retry
        </button>
        <button type="button" className="rounded border border-port-border bg-port-card px-3 py-1.5 text-xs text-port-text-muted hover:border-port-accent">
          Beeper settings
        </button>
      </div>
    </div>
  );
}

export function BridgeWarning({ accounts }) {
  const down = accounts.filter((a) => a.state === 'disconnected');
  if (down.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 rounded border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
      <AlertTriangle size={13} className="shrink-0" />
      <span>
        {down.map((a) => a.label).join(', ')} disconnected — new messages won’t arrive and sending is disabled.
      </span>
    </div>
  );
}

export function BackfillBanner({ show }) {
  if (!show) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 rounded border border-port-accent/40 bg-port-accent/10 px-3 py-2 text-xs text-port-accent-text">
      <Download size={13} className="shrink-0 animate-pulse" />
      <span>Importing history. Threads will fill in as it runs; a short thread is expected right now, not a bug.</span>
    </div>
  );
}

export function EmptyState({ accounts }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm text-port-text">No conversations yet</p>
      <p className="max-w-md text-xs text-port-text-muted">
        {accounts.length} network{accounts.length === 1 ? '' : 's'} connected. History depth varies a lot
        per network, so an empty list here is often correct rather than broken.
      </p>
    </div>
  );
}

/** The composer NAMES the network it will send on. #9 records this as a
 *  requirement, not a nicety: sends are async with no idempotency key and the
 *  only undo is an unsend-for-everyone. */
export function Composer({ conv, disabled, prominent = false }) {
  if (!conv) return null;
  const label = `Send on ${networkLabel(conv.network)}`;
  return (
    <div className="shrink-0 border-t border-port-border p-3">
      {prominent && (
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-port-text-subtle">
          <NetworkMark network={conv.network} level="text" />
          <span>· to {conv.title}</span>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          rows={1}
          disabled={disabled}
          aria-label={label}
          placeholder={disabled ? 'Bridge disconnected — can’t send' : `Message ${conv.title} on ${networkLabel(conv.network)}…`}
          className="min-h-9 flex-1 resize-none rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text placeholder:text-port-text-subtle focus:border-port-accent focus:outline-none disabled:opacity-40"
        />
        <button
          type="button"
          disabled={disabled}
          className="shrink-0 rounded bg-port-accent px-3 py-2 text-xs font-medium text-port-on-accent disabled:opacity-40"
        >
          {prominent ? label : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** Message bubbles. Shared across variants on purpose: the question #9 asks is
 *  about the CONVERSATION LIST, so holding the thread body constant keeps the
 *  comparison honest. Each variant still owns its own thread header, pane
 *  arrangement, and composer loudness. */
export function MessageBubbles({ messages, backfilling }) {
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-3">
      {backfilling && (
        <p className="pb-1 text-center text-[11px] text-port-text-subtle">Earlier history still importing…</p>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[78%] rounded-lg px-3 py-2 text-sm ${m.direction === 'out' ? 'bg-port-accent/20 text-port-text' : 'bg-port-card text-port-text'}`}>
            {m.sender && <p className="mb-0.5 text-[11px] font-medium text-port-accent-text">{m.sender}</p>}
            {m.replyTo && (
              <p className="mb-1 border-l-2 border-port-border pl-2 text-[11px] italic text-port-text-subtle">
                replying to an earlier message
              </p>
            )}
            {m.attachment && (
              <div className="mb-1 flex items-center gap-1.5 rounded border border-dashed border-port-border px-2 py-1.5 text-[11px] text-port-text-muted">
                <Paperclip size={11} />
                {m.attachment}
              </div>
            )}
            <p className="whitespace-pre-wrap break-words">{m.text}</p>
            <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-port-text-subtle">
              {new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              {m.direction === 'out' && <DeliveryMark state={m.delivery} />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
