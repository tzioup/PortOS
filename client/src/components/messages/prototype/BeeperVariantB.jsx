/* PROTOTYPE — issue #9. Throwaway.
 *
 * VARIANT B — "Network rail". Network is PROMOTED from a badge to the primary
 * navigation axis: its own column, always visible, carrying per-network unread
 * counts. The list itself then drops the badge almost entirely, because in a
 * filtered view the network is already established by the rail.
 *
 * The bet: on a 9-network install the badge is too quiet, and what you actually
 * want is to move between networks the way you move between mailboxes.
 *
 * Deliberately NOT a copy of the Beeper Desktop rail. That rail is a
 * user-curated set of SAVED SCOPES at mixed grain — "Discord DMs", "one Discord
 * server" — which #9's second correction rules out of the MVP. This rail is
 * strictly one entry per connected account, plus All.
 */
import { useState } from 'react';
import { AlertTriangle, Inbox } from 'lucide-react';
import { timeAgo } from '../../../utils/formatters';
import { NETWORKS, networkLabel, threadFor } from './beeperFixtures';
import {
  Avatar, BackfillBanner, BridgeWarning, Composer, EmptyState,
  MessageBubbles, NetworkMark, Preview, RowMeta,
} from './beeperProtoKit';

export const variantName = 'Network rail (network as axis)';

function RailButton({ active, tint, glyph, label, unread, warn, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative flex size-11 items-center justify-center rounded-xl text-[11px] font-bold transition ${active ? 'ring-2 ring-port-accent' : 'opacity-70 hover:opacity-100'}`}
      style={{ background: tint ? `${tint}26` : 'transparent', color: tint || undefined }}
    >
      {glyph}
      {unread > 0 && (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-port-accent px-1 text-[9px] font-semibold text-port-on-accent">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
      {warn && <AlertTriangle size={10} className="absolute -bottom-1 -right-1 text-port-warning" />}
    </button>
  );
}

export default function BeeperVariantB({ scenario, selected, onSelect }) {
  const { accounts, conversations, backfilling } = scenario;
  const [network, setNetwork] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const visible = conversations
    .filter((c) => (network === 'all' || c.network === network))
    .filter((c) => (!unreadOnly || c.unread > 0))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  const conv = conversations.find((c) => c.id === selected) || null;
  const convAccount = accounts.find((a) => a.network === conv?.network);
  const sendBlocked = convAccount?.state === 'disconnected';
  const totalUnread = conversations.reduce((n, c) => n + c.unread, 0);
  const scopeLabel = network === 'all' ? 'All networks' : networkLabel(network);

  return (
    <div className="flex h-full min-h-0">
      {/* rail — one entry per connected account, plus All. Hidden entirely on a
          single-network install, where an axis with one value is pure furniture. */}
      {accounts.length > 1 && (
        <div className="hidden shrink-0 flex-col items-center gap-2 border-r border-port-border bg-port-bg/40 px-2 py-3 sm:flex">
          <RailButton
            active={network === 'all'}
            glyph={<Inbox size={17} />}
            label="All networks"
            unread={totalUnread}
            onClick={() => setNetwork('all')}
          />
          <div className="my-1 h-px w-6 bg-port-border" />
          {accounts.map((a) => (
            <RailButton
              key={a.id}
              active={network === a.network}
              tint={NETWORKS[a.network]?.tint}
              glyph={NETWORKS[a.network]?.glyph}
              label={a.label}
              warn={a.state === 'disconnected'}
              unread={conversations.filter((c) => c.network === a.network).reduce((n, c) => n + c.unread, 0)}
              onClick={() => setNetwork(a.network)}
            />
          ))}
        </div>
      )}

      {/* list */}
      <div className={`flex min-h-0 w-full flex-col border-r border-port-border md:w-80 lg:w-96 ${selected ? 'hidden md:flex' : 'flex'}`}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-port-border px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {network !== 'all' && <NetworkMark network={network} level="dot" />}
            <span className="truncate text-sm font-medium text-port-text">{scopeLabel}</span>
            <span className="text-xs text-port-text-subtle">{visible.length}</span>
          </div>
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            className={`shrink-0 rounded px-2 py-1 text-[11px] ${unreadOnly ? 'bg-port-accent text-port-on-accent' : 'border border-port-border text-port-text-muted'}`}
          >
            Unread
          </button>
        </div>

        <div className="space-y-2 px-3 pt-2 empty:hidden">
          <BridgeWarning accounts={accounts} />
          <BackfillBanner show={backfilling} />
        </div>

        {visible.length === 0 ? (
          <EmptyState accounts={accounts} />
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {visible.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={`flex w-full items-center gap-2.5 border-b border-port-border/60 px-3 py-2.5 text-left hover:bg-port-card ${selected === c.id ? 'bg-port-card' : ''}`}
                >
                  <Avatar conv={c} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      {/* In "All" the network still needs to be legible, but only
                          as a dot: the rail is carrying the identification work. */}
                      {network === 'all' && <NetworkMark network={c.network} level="dot" />}
                      <span className={`truncate text-sm ${c.unread > 0 && !c.muted ? 'font-semibold text-port-text' : 'text-port-text-muted'}`}>
                        {c.title}
                      </span>
                    </span>
                    <Preview conv={c} />
                  </span>
                  <RowMeta conv={c} timeLabel={timeAgo(c.lastAt)} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* thread — network stated loudly in the header AND in the composer */}
      <div className={`flex min-h-0 flex-1 flex-col ${selected ? 'flex' : 'hidden md:flex'}`}>
        {!conv ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-port-text-subtle">
            Pick a conversation
          </div>
        ) : (
          <>
            <div
              className="flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5"
              style={{ borderColor: NETWORKS[conv.network]?.tint }}
            >
              <button type="button" onClick={() => onSelect(null)} className="text-xs text-port-accent-text md:hidden">
                Back
              </button>
              <Avatar conv={conv} size={30} />
              <div className="min-w-0">
                <p className="truncate text-sm text-port-text">{conv.title}</p>
                <p className="truncate text-[11px] text-port-text-subtle">{conv.handle}</p>
              </div>
              <span className="ml-auto"><NetworkMark network={conv.network} level="text" /></span>
            </div>
            <MessageBubbles messages={threadFor(conv)} backfilling={backfilling} />
            <Composer conv={conv} disabled={sendBlocked} prominent />
          </>
        )}
      </div>
    </div>
  );
}
