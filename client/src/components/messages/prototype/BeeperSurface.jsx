/* PROTOTYPE — issue #9. Throwaway.
 *
 * A faithful PortOS-native rendering of the REFERENCE INTERFACE (Beeper
 * Desktop), reproduced from the principal's screenshots rather than invented.
 * An earlier pass offered three speculative layouts; that was the wrong move —
 * the reference is already validated by daily use, so the job is to port it and
 * mark the deltas, not to redesign it.
 *
 * Reproduced, in the reference's own terms:
 *   · left rail of real network logos with per-scope unread counts, over a
 *     fixed group (Inbox / Archive / Requests / Low priority / Later)
 *   · pinned grid at the top of every scope: circular avatars, floating
 *     preview bubbles, unread counts on the avatar, muted bell
 *   · scope header: name + chevron, filter, search, compose
 *   · row anatomy: avatar · network badge · title · muted bell · timestamp ·
 *     preview with leading state chip · unread as a count pill OR a bare dot
 *   · thread: date-separator pills, sender avatars, deleted-message placeholders
 *   · composer naming network AND transport ("… on Google Messages (RCS)")
 *   · right-hand info sidebar: description, members, labels, notes
 *
 * THE ONE CONDITIONAL RULE, from the principal: network badges appear on rows
 * ONLY in the unified inbox. Inside a single-network scope the badge is noise,
 * because the rail already states the network — so it is dropped entirely.
 *
 * What is NOT reproduced, on purpose: saved custom scopes at mixed grain (a
 * Discord-DMs chip beside a single-server chip), labels, and custom groups.
 * Those are deferred by #9's MVP scoping, and the rail here is therefore
 * strictly one entry per connected account.
 */
import { useState } from 'react';
import {
  AlertTriangle, Archive, BellOff, Check, CheckCheck, ChevronDown, Clock, Download,
  Filter, Image as ImageIcon, Inbox, Mail, MoreHorizontal, PanelRightClose, PenSquare,
  Plus, Search, Send, Smile, Trash2, X as XIcon,
} from 'lucide-react';
import { networkLabel, sendTargetLabel, SYSTEM_SCOPES, threadFor } from './beeperFixtures';
import NetworkLogo from './beeperNetworkLogos';

const SYSTEM_ICONS = { inbox: Inbox, archive: Archive, mail: Mail, tray: Download, clock: Clock };

// Which conversations sit in the pinned grid. In the real thing this is stored
// per scope; here it is a fixture flag so the grid can be judged at all.
const PINNED_IDS = new Set(['c2', 'c3', 'c6', 'c7', 'c11', 'c13']);

const initials = (name) => name.replace(/^[#+]/, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const dayLabel = (iso) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const rowTime = (iso) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

function Avatar({ conv, size = 40 }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-port-border font-medium text-port-text-muted"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {initials(conv.title)}
    </div>
  );
}

function LeadChip({ conv }) {
  if (conv.direction === 'out') {
    const Icon = conv.delivery === 'sent' ? Check : CheckCheck;
    return <Icon size={12} className="shrink-0 text-port-text-subtle" />;
  }
  if (conv.lead === 'image') {
    return (
      <span className="flex shrink-0 items-center gap-0.5 rounded bg-port-border px-1 py-px text-[10px] text-port-text-muted">
        <ImageIcon size={9} /> Image
      </span>
    );
  }
  if (conv.lead === 'group' || conv.lead === 'bot') {
    return <span className="size-3 shrink-0 rounded-full bg-port-border" />;
  }
  return null;
}

/* ---------- rail ---------- */

function Rail({ accounts, conversations, scope, onScope, totalUnread }) {
  const item = 'relative flex size-11 items-center justify-center rounded-xl transition';
  return (
    <div className="hidden w-[68px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-port-border bg-port-bg/60 py-2 sm:flex">
      {SYSTEM_SCOPES.map((s) => {
        const Icon = SYSTEM_ICONS[s.icon] || Inbox;
        const active = s.live && scope === 'all';
        return (
          <button
            key={s.id}
            type="button"
            title={s.live ? s.label : `${s.label} — not in the MVP`}
            aria-label={s.label}
            onClick={s.live ? () => onScope('all') : undefined}
            className={`${item} ${active ? 'bg-port-card text-port-text' : 'text-port-text-subtle hover:text-port-text'} ${s.live ? '' : 'opacity-35'}`}
          >
            <Icon size={19} />
            {s.id === 'inbox' && totalUnread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 rounded-full bg-port-accent px-1 text-[9px] font-semibold text-port-on-accent">
                {totalUnread > 999 ? '999+' : totalUnread}
              </span>
            )}
            {s.dot && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-port-accent-2" />}
          </button>
        );
      })}

      <div className="my-1.5 h-px w-7 bg-port-border" />

      {accounts.map((a) => {
        const unread = conversations
          .filter((c) => c.network === a.network)
          .reduce((n, c) => n + c.unread, 0);
        return (
          <button
            key={a.id}
            type="button"
            title={a.label}
            aria-label={a.label}
            onClick={() => onScope(a.network)}
            className={`${item} ${scope === a.network ? 'bg-port-card ring-2 ring-port-accent' : 'opacity-80 hover:opacity-100'}`}
          >
            <NetworkLogo network={a.network} label={a.label} size={26} />
            {unread > 0 && (
              <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-port-accent px-1 text-[9px] font-semibold text-port-on-accent">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
            {a.state === 'disconnected' && (
              <AlertTriangle size={11} className="absolute -bottom-0.5 -right-0.5 text-port-warning" />
            )}
          </button>
        );
      })}

      <div className="my-1.5 h-px w-7 bg-port-border" />
      <button
        type="button"
        title="Saved scopes — deferred, not in the MVP"
        className={`${item} border border-dashed border-port-border text-port-text-subtle opacity-35`}
      >
        <Plus size={17} />
      </button>
      <button type="button" title="More" className={`${item} text-port-text-subtle opacity-35`}>
        <MoreHorizontal size={17} />
      </button>
    </div>
  );
}

/* ---------- pinned grid ---------- */

function PinnedGrid({ conversations, unified, onSelect }) {
  if (conversations.length === 0) return null;
  return (
    <div className="grid shrink-0 grid-cols-3 gap-x-2 gap-y-1 border-b border-port-border px-3 pb-3 pt-4">
      {conversations.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(c.id)}
          className="flex flex-col items-center gap-1"
        >
          <span className="relative">
            {/* floating preview bubble, as in the reference */}
            {c.unread > 0 && (
              <span className="absolute -top-3 left-6 z-10 max-w-[92px] truncate rounded-full bg-port-accent px-2 py-0.5 text-[9px] text-port-on-accent">
                {c.preview}
              </span>
            )}
            <Avatar conv={c} size={54} />
            {c.unread > 0 && (
              <span className="absolute -right-1 top-0 min-w-4 rounded-full bg-neutral-900 px-1 text-center text-[10px] font-semibold text-white ring-2 ring-port-bg">
                {c.unread}
              </span>
            )}
            {unified && (
              <span data-testid="network-badge" className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-port-bg">
                <NetworkLogo network={c.network} size={16} />
              </span>
            )}
          </span>
          <span className="flex w-full items-center justify-center gap-0.5">
            <span className="truncate text-[11px] text-port-text-muted">{c.title.split(' ')[0]}</span>
            {c.muted && <BellOff size={9} className="shrink-0 text-port-text-subtle" />}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------- conversation row ---------- */

function Row({ conv, unified, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(conv.id)}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-port-card ${selected ? 'bg-port-card' : ''}`}
    >
      <span className="relative shrink-0">
        <Avatar conv={conv} />
        {/* THE conditional: badge only when the list spans networks. */}
        {unified && (
          <span data-testid="network-badge" className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-port-bg">
            <NetworkLogo network={conv.network} size={15} />
          </span>
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className={`truncate text-[13px] ${conv.unread > 0 ? 'font-semibold text-port-text' : 'text-port-text'}`}>
            {conv.title}
          </span>
          {conv.space && <span className="shrink-0 truncate text-[11px] text-port-text-subtle">• {conv.space}</span>}
          {conv.muted && <BellOff size={11} className="shrink-0 text-port-text-subtle" />}
          <span className="ml-auto shrink-0 pl-1 text-[11px] text-port-text-subtle">{rowTime(conv.lastAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1">
          <LeadChip conv={conv} />
          <span className="min-w-0 flex-1 truncate text-xs text-port-text-muted">{conv.preview}</span>
          {conv.unread > 0 && (
            <span className="shrink-0 rounded-full bg-port-accent px-1.5 py-px text-[10px] font-semibold text-port-on-accent">
              {conv.unread}
            </span>
          )}
          {/* unread, count withheld — a third state, seen in the reference */}
          {conv.unread === 0 && conv.unreadDot && (
            <span className={`size-2.5 shrink-0 rounded-full ${conv.muted ? 'bg-port-border' : 'bg-port-accent-2'}`} />
          )}
        </span>
      </span>
    </button>
  );
}

/* ---------- thread ---------- */

function Thread({ conv, backfilling, sendBlocked, onInfo, infoOpen }) {
  const messages = threadFor(conv);
  let lastDay = null;
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-port-border px-3 py-2">
        <Avatar conv={conv} size={28} />
        <div className="min-w-0">
          <p className="truncate text-sm text-port-text">{conv.title}</p>
          <p className="truncate text-[11px] text-port-text-subtle">
            {conv.space ? `${conv.space} · ` : ''}{networkLabel(conv.network)}
          </p>
        </div>
        <button
          type="button"
          onClick={onInfo}
          aria-label="Conversation info"
          className={`ml-auto rounded p-1.5 ${infoOpen ? 'text-port-accent-text' : 'text-port-text-subtle hover:text-port-text'}`}
        >
          <PanelRightClose size={16} />
        </button>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
        {backfilling && (
          <p className="pb-1 text-center text-[11px] text-port-text-subtle">Earlier history still importing…</p>
        )}
        {messages.map((m) => {
          const day = dayLabel(m.at);
          const showDay = day !== lastDay;
          lastDay = day;
          const out = m.direction === 'out';
          return (
            <div key={m.id}>
              {showDay && (
                <p className="py-2 text-center">
                  <span className="rounded-full bg-port-card px-2.5 py-0.5 text-[11px] text-port-text-muted">{day}</span>
                </p>
              )}
              <div className={`flex items-end gap-2 ${out ? 'justify-end' : 'justify-start'}`}>
                {!out && <Avatar conv={{ title: m.sender || conv.title }} size={26} />}
                <div className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${out ? 'bg-port-accent/25 text-port-text' : 'bg-port-card text-port-text'}`}>
                  {m.sender && <p className="mb-0.5 text-[11px] font-medium text-port-accent-2-text">{m.sender}</p>}
                  {m.deleted ? (
                    <p className="flex items-center gap-1.5 italic text-port-text-subtle">
                      <Trash2 size={12} /> This message has been deleted
                    </p>
                  ) : (
                    <p className={`whitespace-pre-wrap break-words ${m.mono ? 'font-mono text-[12px]' : ''}`}>{m.text}</p>
                  )}
                  {m.attachment && (
                    <p className="mt-1 rounded border border-dashed border-port-border px-2 py-1 text-[11px] text-port-text-muted">
                      {m.attachment}
                    </p>
                  )}
                  <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-port-text-subtle">
                    {new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {out && (m.delivery === 'sent' ? <Check size={11} /> : <CheckCheck size={11} />)}
                  </span>
                </div>
                {m.reaction && <span className="pb-1 text-xs">{m.reaction}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer names the network AND its transport, exactly as the reference
          does. #2 makes this a requirement: sends are async with no idempotency
          key and the only undo is an unsend for everyone. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-port-border p-2.5">
        <button type="button" aria-label="Attach" className="shrink-0 rounded-full p-2 text-port-text-subtle hover:text-port-text">
          <Plus size={17} />
        </button>
        <div className="flex flex-1 items-center gap-2 rounded-full border border-port-border bg-port-card px-3 py-1.5">
          <NetworkLogo network={conv.network} size={15} />
          <input
            disabled={sendBlocked}
            aria-label={`Message ${conv.title} on ${sendTargetLabel(conv.network)}`}
            placeholder={sendBlocked
              ? `${networkLabel(conv.network)} bridge disconnected — can’t send`
              : `Message ${conv.title} on ${sendTargetLabel(conv.network)}`}
            className="min-w-0 flex-1 bg-transparent text-sm text-port-text placeholder:text-port-text-subtle focus:outline-none disabled:opacity-50"
          />
          <Smile size={15} className="shrink-0 text-port-text-subtle" />
        </div>
        <button
          type="button"
          disabled={sendBlocked}
          aria-label="Send"
          className="shrink-0 rounded-full bg-port-accent p-2 text-port-on-accent disabled:opacity-40"
        >
          <Send size={15} />
        </button>
      </div>
    </>
  );
}

/* ---------- info sidebar ---------- */

function InfoSidebar({ conv, onClose }) {
  return (
    <aside className="hidden w-72 shrink-0 flex-col overflow-y-auto border-l border-port-border p-4 lg:flex">
      <button type="button" onClick={onClose} aria-label="Close info" className="self-end text-port-text-subtle hover:text-port-text">
        <XIcon size={15} />
      </button>
      <div className="flex flex-col items-center gap-1 pb-4">
        <Avatar conv={conv} size={64} />
        <p className="mt-1 text-sm text-port-text">{conv.title}</p>
        <p className="text-[11px] text-port-text-subtle">{networkLabel(conv.network)}</p>
      </div>
      {conv.group && (
        <>
          <p className="pb-1 text-[11px] uppercase tracking-wide text-port-text-subtle">Description</p>
          <p className="mb-3 rounded bg-port-card p-2 text-xs text-port-text-muted">
            Placeholder group description from the bridged network.
          </p>
        </>
      )}
      <p className="pb-1 text-[11px] uppercase tracking-wide text-port-text-subtle">Members</p>
      <div className="mb-3 rounded bg-port-card p-2 text-xs text-port-text-muted">
        <p>You</p>
        <p>{conv.group ? 'Kira Example, Erik Example' : conv.title}</p>
      </div>
      {/* Labels and Notes exist in the reference. Rendered inert here so their
          deferral is visible rather than silently dropped. */}
      <p className="pb-1 text-[11px] uppercase tracking-wide text-port-text-subtle">Labels · Notes</p>
      <p className="rounded border border-dashed border-port-border p-2 text-[11px] text-port-text-subtle">
        In the reference, not in the MVP — deferred with saved scopes and custom groups.
      </p>
    </aside>
  );
}

/* ---------- the surface ---------- */

export default function BeeperSurface({ scenario, selected, onSelect, scope, onScope }) {
  const { accounts, conversations, backfilling } = scenario;
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  const known = scope === 'all' || accounts.some((a) => a.network === scope);
  const activeScope = known ? scope : 'all';
  const unified = activeScope === 'all';

  const inScope = conversations.filter((c) => unified || c.network === activeScope);
  const visible = inScope
    .filter((c) => !unreadOnly || c.unread > 0 || c.unreadDot)
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  const pinned = inScope.filter((c) => PINNED_IDS.has(c.id)).slice(0, 6);

  const conv = conversations.find((c) => c.id === selected) || null;
  const convAccount = accounts.find((a) => a.network === conv?.network);
  const sendBlocked = convAccount?.state === 'disconnected';
  const down = accounts.filter((a) => a.state === 'disconnected');
  const totalUnread = conversations.reduce((n, c) => n + c.unread, 0);
  const scopeLabel = unified ? 'Inbox' : networkLabel(activeScope);

  return (
    <div className="flex h-full min-h-0">
      <Rail
        accounts={accounts}
        conversations={conversations}
        scope={activeScope}
        onScope={onScope}
        totalUnread={totalUnread}
      />

      <div className={`flex min-h-0 w-full flex-col border-r border-port-border md:w-[272px] md:shrink-0 ${selected ? 'hidden md:flex' : 'flex'}`}>
        <div className="flex shrink-0 items-center gap-1 px-3 py-2.5">
          <button type="button" className="flex min-w-0 items-center gap-1 text-sm font-semibold text-port-text">
            <span className="truncate">{scopeLabel}</span>
            <ChevronDown size={13} className="shrink-0 text-port-text-subtle" />
          </button>
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            title="Unread only"
            aria-label="Unread only"
            className={`ml-auto rounded p-1.5 ${unreadOnly ? 'bg-port-accent text-port-on-accent' : 'text-port-text-subtle hover:text-port-text'}`}
          >
            <Filter size={15} />
          </button>
          <button type="button" aria-label="Search" className="rounded p-1.5 text-port-text-subtle hover:text-port-text">
            <Search size={15} />
          </button>
          <button type="button" aria-label="New message" className="rounded p-1.5 text-port-text-subtle hover:text-port-text">
            <PenSquare size={15} />
          </button>
        </div>

        {(down.length > 0 || backfilling) && (
          <div className="space-y-1.5 px-3 pb-2">
            {down.length > 0 && (
              <p className="flex items-center gap-1.5 rounded border border-port-warning/40 bg-port-warning/10 px-2 py-1.5 text-[11px] text-port-warning">
                <AlertTriangle size={11} className="shrink-0" />
                {down.map((a) => a.label).join(', ')} disconnected — sending disabled
              </p>
            )}
            {backfilling && (
              <p className="flex items-center gap-1.5 rounded border border-port-accent/40 bg-port-accent/10 px-2 py-1.5 text-[11px] text-port-accent-text">
                <Download size={11} className="shrink-0 animate-pulse" />
                Importing history — a short list is expected right now
              </p>
            )}
          </div>
        )}

        {!unreadOnly && <PinnedGrid conversations={pinned} unified={unified} onSelect={onSelect} />}

        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-sm text-port-text">Nothing here</p>
            <p className="text-[11px] text-port-text-subtle">
              {accounts.length} network{accounts.length === 1 ? '' : 's'} connected. History depth varies a lot per
              network, so an empty list is often correct rather than broken.
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 divide-y divide-port-border/50 overflow-y-auto">
            {visible.map((c) => (
              <Row key={c.id} conv={c} unified={unified} selected={selected === c.id} onSelect={onSelect} />
            ))}
          </div>
        )}
      </div>

      <div className={`flex min-h-0 flex-1 flex-col ${selected ? 'flex' : 'hidden md:flex'}`}>
        {conv ? (
          <Thread
            conv={conv}
            backfilling={backfilling}
            sendBlocked={sendBlocked}
            infoOpen={infoOpen}
            onInfo={() => setInfoOpen((v) => !v)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-port-text-subtle">
            Pick a conversation
          </div>
        )}
      </div>

      {conv && infoOpen && <InfoSidebar conv={conv} onClose={() => setInfoOpen(false)} />}
    </div>
  );
}
