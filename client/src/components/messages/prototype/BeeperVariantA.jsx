/* PROTOTYPE — issue #9. Throwaway.
 *
 * VARIANT A — "Unified stream". Network is SUBORDINATE: a badge on the avatar,
 * the Beeper Desktop idiom. One flat list sorted by recency, filters as a chip
 * row above it. Closest to the existing iMessage tab, so it inherits PortOS
 * density for free.
 *
 * The bet: the person is what you scan for, and the network is a detail you
 * only need once you have found them.
 */
import { useState } from 'react';
import { Search } from 'lucide-react';
import { timeAgo } from '../../../utils/formatters';
import { NETWORKS, networkLabel, threadFor } from './beeperFixtures';
import {
  AvatarWithBadge, BackfillBanner, BridgeWarning, Composer, EmptyState,
  MessageBubbles, NetworkMark, Preview, RowMeta,
} from './beeperProtoKit';

export const variantName = 'Unified stream (network as badge)';

export default function BeeperVariantA({ scenario, selected, onSelect }) {
  const { accounts, conversations, backfilling } = scenario;
  const [network, setNetwork] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');

  const visible = conversations
    .filter((c) => (network === 'all' || c.network === network))
    .filter((c) => (!unreadOnly || c.unread > 0))
    .filter((c) => (!q || c.title.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  const conv = conversations.find((c) => c.id === selected) || null;
  const convAccount = accounts.find((a) => a.network === conv?.network);
  const sendBlocked = convAccount?.state === 'disconnected';
  const totalUnread = conversations.reduce((n, c) => n + c.unread, 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <BridgeWarning accounts={accounts} />
      <BackfillBanner show={backfilling} />

      {/* Filter chips. On a single-network install the per-network chips collapse
          to nothing, leaving just the unread toggle — the 1-network case the map
          warns about. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {accounts.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => setNetwork('all')}
              className={`rounded-full px-2.5 py-1 text-xs ${network === 'all' ? 'bg-port-accent text-port-on-accent' : 'border border-port-border bg-port-card text-port-text-muted'}`}
            >
              All
              {totalUnread > 0 && <span className="ml-1 opacity-70">{totalUnread}</span>}
            </button>
            {accounts.map((a) => {
              const unread = conversations.filter((c) => c.network === a.network).reduce((n, c) => n + c.unread, 0);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setNetwork(a.network)}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${network === a.network ? 'bg-port-accent text-port-on-accent' : 'border border-port-border bg-port-card text-port-text-muted'}`}
                >
                  <span className="size-2 rounded-full" style={{ background: NETWORKS[a.network]?.tint }} />
                  {a.label}
                  {unread > 0 && <span className="opacity-70">{unread}</span>}
                  {a.state === 'disconnected' && <span className="text-port-warning">!</span>}
                </button>
              );
            })}
          </>
        )}
        <button
          type="button"
          onClick={() => setUnreadOnly((v) => !v)}
          className={`ml-auto rounded-full px-2.5 py-1 text-xs ${unreadOnly ? 'bg-port-accent text-port-on-accent' : 'border border-port-border bg-port-card text-port-text-muted'}`}
        >
          Unread only
        </button>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(18rem,24rem)_1fr]">
        {/* list */}
        <div className={`flex min-h-0 flex-col rounded border border-port-border bg-port-card ${selected ? 'hidden md:flex' : 'flex'}`}>
          <div className="flex shrink-0 items-center gap-2 border-b border-port-border px-3 py-2">
            <Search size={13} className="text-port-text-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="w-full bg-transparent text-xs text-port-text placeholder:text-port-text-subtle focus:outline-none"
            />
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
                    className={`flex w-full items-center gap-2.5 border-b border-port-border/60 px-3 py-2.5 text-left hover:bg-port-bg/60 ${selected === c.id ? 'bg-port-bg' : ''}`}
                  >
                    <AvatarWithBadge conv={c} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${c.unread > 0 && !c.muted ? 'font-semibold text-port-text' : 'text-port-text-muted'}`}>
                        {c.title}
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

        {/* thread */}
        <div className={`flex min-h-0 flex-col rounded border border-port-border bg-port-card ${selected ? 'flex' : 'hidden md:flex'}`}>
          {!conv ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-port-text-subtle">
              Pick a conversation
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-port-border px-3 py-2">
                <button type="button" onClick={() => onSelect(null)} className="text-xs text-port-accent-text md:hidden">
                  Back
                </button>
                <AvatarWithBadge conv={conv} size={28} />
                <div className="min-w-0">
                  <p className="truncate text-sm text-port-text">{conv.title}</p>
                  <p className="truncate text-[11px] text-port-text-subtle">
                    {networkLabel(conv.network)} · {conv.handle}
                  </p>
                </div>
                <span className="ml-auto"><NetworkMark network={conv.network} level="text" /></span>
              </div>
              <MessageBubbles messages={threadFor(conv)} backfilling={backfilling} />
              <Composer conv={conv} disabled={sendBlocked} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
