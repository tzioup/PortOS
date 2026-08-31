/* PROTOTYPE — issue #9. Throwaway.
 *
 * VARIANT C — "Grouped by network". Network is neither a badge nor an axis:
 * it is the STRUCTURE. Conversations sit under collapsible network headings,
 * recency-sorted inside each, so no row needs a network mark at all. There is
 * no separate per-network filter control, because collapsing a section is the
 * filter.
 *
 * The bet: a single recency-ordered stream across nine networks is not actually
 * how anyone thinks about their messages — context switches by network, and a
 * WhatsApp thread and a Discord channel do not belong in the same run of rows.
 *
 * Costs this variant accepts on purpose, so they can be judged rather than
 * argued: the newest message on a quiet network is buried under a busy one, and
 * on a single-network install the grouping is one heading over everything.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { timeAgo } from '../../../utils/formatters';
import { NETWORKS, threadFor } from './beeperFixtures';
import {
  Avatar, BackfillBanner, BridgeWarning, Composer, EmptyState,
  MessageBubbles, NetworkMark, Preview, RowMeta,
} from './beeperProtoKit';

export const variantName = 'Grouped by network (network as structure)';

export default function BeeperVariantC({ scenario, selected, onSelect }) {
  const { accounts, conversations, backfilling } = scenario;
  const [collapsed, setCollapsed] = useState({});
  const [unreadOnly, setUnreadOnly] = useState(false);

  const conv = conversations.find((c) => c.id === selected) || null;
  const convAccount = accounts.find((a) => a.network === conv?.network);
  const sendBlocked = convAccount?.state === 'disconnected';

  const toggle = (net) => setCollapsed((prev) => ({ ...prev, [net]: !prev[net] }));

  // Groups are ordered by their own most recent message, so a network that just
  // lit up rises — recency still drives the page, one level up.
  const groups = accounts
    .map((a) => {
      const rows = conversations
        .filter((c) => c.network === a.network)
        .filter((c) => (!unreadOnly || c.unread > 0))
        .sort((x, y) => new Date(y.lastAt) - new Date(x.lastAt));
      return { account: a, rows, latest: rows[0]?.lastAt || null };
    })
    .filter((g) => g.rows.length > 0 || !unreadOnly)
    .sort((a, b) => new Date(b.latest || 0) - new Date(a.latest || 0));

  const anyRows = groups.some((g) => g.rows.length > 0);

  // Single-pane master/detail: the thread REPLACES the list rather than sitting
  // beside it, which is what buys the grouping enough width to breathe.
  if (conv) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-port-border px-3 py-2.5">
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-port-text-muted hover:border-port-accent"
          >
            <ChevronRight size={12} className="rotate-180" />
            All messages
          </button>
          <Avatar conv={conv} size={30} />
          <div className="min-w-0">
            <p className="truncate text-sm text-port-text">{conv.title}</p>
            <p className="truncate text-[11px] text-port-text-subtle">{conv.handle}</p>
          </div>
          <span className="ml-auto"><NetworkMark network={conv.network} level="text" /></span>
        </div>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden">
          <MessageBubbles messages={threadFor(conv)} backfilling={backfilling} />
          <Composer conv={conv} disabled={sendBlocked} prominent />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:p-4">
      <BridgeWarning accounts={accounts} />
      <BackfillBanner show={backfilling} />

      <div className="flex shrink-0 items-center justify-between">
        <p className="text-xs text-port-text-subtle">
          {accounts.length} network{accounts.length === 1 ? '' : 's'} · newest network first
        </p>
        <button
          type="button"
          onClick={() => setUnreadOnly((v) => !v)}
          className={`rounded-full px-2.5 py-1 text-xs ${unreadOnly ? 'bg-port-accent text-port-on-accent' : 'border border-port-border bg-port-card text-port-text-muted'}`}
        >
          Unread only
        </button>
      </div>

      {!anyRows ? (
        <EmptyState accounts={accounts} />
      ) : (
        <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-2 overflow-y-auto">
          {groups.map(({ account, rows }) => {
            const isOpen = !collapsed[account.network];
            const unread = rows.reduce((n, c) => n + c.unread, 0);
            const tint = NETWORKS[account.network]?.tint;
            return (
              <section key={account.id} className="overflow-hidden rounded border border-port-border bg-port-card">
                <button
                  type="button"
                  onClick={() => toggle(account.network)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-port-bg/50"
                  style={{ borderLeft: `3px solid ${tint}` }}
                >
                  {isOpen ? <ChevronDown size={14} className="text-port-text-subtle" /> : <ChevronRight size={14} className="text-port-text-subtle" />}
                  <span className="text-sm font-medium" style={{ color: tint }}>{account.label}</span>
                  <span className="text-xs text-port-text-subtle">{rows.length}</span>
                  {account.state === 'disconnected' && (
                    <span className="rounded bg-port-warning/15 px-1.5 py-0.5 text-[10px] text-port-warning">disconnected</span>
                  )}
                  {unread > 0 && (
                    <span className="ml-auto rounded-full bg-port-accent px-1.5 py-0.5 text-[10px] font-semibold text-port-on-accent">
                      {unread}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <ul className="border-t border-port-border">
                    {rows.length === 0 && (
                      <li className="px-3 py-2 text-xs text-port-text-subtle">Nothing unread here</li>
                    )}
                    {rows.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(c.id)}
                          className="flex w-full items-center gap-2.5 border-b border-port-border/50 px-3 py-2.5 text-left last:border-b-0 hover:bg-port-bg/50"
                        >
                          <Avatar conv={c} size={34} />
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
              </section>
            );
          })}
          <p className="pb-2 text-center text-[11px] text-port-text-subtle">
            Grouping means a quiet network never gets buried, and a busy one never floods the page.
          </p>
        </div>
      )}
    </div>
  );
}
