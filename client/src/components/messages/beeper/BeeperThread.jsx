import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Archive, BellOff, ChevronDown, Loader2, Paperclip, Plus, Send, Trash2, UserPlus, Users,
} from 'lucide-react';
import NetworkLogo, { networkLabel } from './BeeperNetworkLogo';

/**
 * Thread + composer + the inline Tribe-linking action, for the Beeper chat
 * surface (#35). Structure ported from the #9 prototype (`BeeperSurface.jsx`):
 * date-separator pills, sender avatars, deleted-message placeholders, and a
 * composer that names the network it would send on.
 *
 * Three things this deliberately does NOT do:
 *
 *  - **It does not send.** The composer is a draft buffer plus UI; the durable
 *    outbox, the runaway breaker and the socket/GET confirmation are their own
 *    slice, because a Beeper send is asynchronous with no idempotency key and a
 *    half-built send path is the one failure that cannot be undone without an
 *    unsend-for-everyone. The action is disabled and says so.
 *  - **It does not treat an empty thread as an error or as loading.** History
 *    depth varies enormously per network (#3), so a mirrored conversation with
 *    no messages is frequently the true answer. It says that, rather than
 *    spinning forever or rendering a fault.
 *  - **It does not name the transport.** #9 wants "… on Google Messages (RCS)";
 *    the mirror carries `network` but not `transport` (#27), so the label stops
 *    at the network rather than inventing one.
 *
 * Direction comes from the mirrored `isSender`, never from comparing
 * `senderId` against the local user — `accounts[].user.id` differs from
 * `senderID` on every network (#2), so there is nothing to compare against.
 * Own messages sit right-aligned with no sender name and no avatar, the
 * reference interface's shape.
 */

const dayLabel = (iso) => {
  if (!iso) return 'Unknown date';
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

const clockTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

const initials = (name) => String(name || '?')
  .replace(/^[#+@]/, '')
  .split(/\s+/)
  .slice(0, 2)
  .map((word) => word[0])
  .filter(Boolean)
  .join('')
  .toUpperCase() || '?';

function Avatar({ name, size = 40 }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-port-border font-medium text-gray-300"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}

/**
 * A participant row with the inline "Link to Tribe person" action from #34.
 * Two shapes in one control because they are the same decision: an existing
 * person, or a new one created from the participant's own display name.
 * `tribePersonId` present means the link is already resolved — the row then
 * states who it is rather than offering the action again.
 */
function ParticipantRow({ participant, people, linking, onLink, onLinkNew }) {
  const [personId, setPersonId] = useState('');
  const selectId = `beeper-link-${participant.sourceUserId}`;

  if (participant.tribePersonId) {
    return (
      <li className="flex items-center gap-2 py-1 text-xs text-gray-300">
        <Avatar name={participant.displayName || participant.handle} size={22} />
        <span className="min-w-0 flex-1 truncate">{participant.displayName || participant.handle || participant.sourceUserId}</span>
        <span className="shrink-0 truncate text-[11px] text-port-success">
          {participant.tribePersonName ? `Linked · ${participant.tribePersonName}` : 'Linked'}
        </span>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-2 py-1 text-xs text-gray-300">
      <Avatar name={participant.displayName || participant.handle} size={22} />
      <span className="min-w-0 flex-1 truncate">{participant.displayName || participant.handle || participant.sourceUserId}</span>
      <label htmlFor={selectId} className="sr-only">
        Link {participant.displayName || participant.sourceUserId} to a Tribe person
      </label>
      <select
        id={selectId}
        value={personId}
        onChange={(event) => setPersonId(event.target.value)}
        className="max-w-[9rem] rounded border border-port-border bg-port-bg px-2 py-1 text-[11px] text-gray-200"
      >
        <option value="">Link to…</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>{person.name}</option>
        ))}
      </select>
      <button
        type="button"
        disabled={!personId || linking}
        onClick={() => onLink(participant, personId)}
        className="inline-flex min-h-[28px] items-center gap-1 rounded border border-port-border px-2 py-1 text-[11px] text-gray-200 transition-colors hover:border-port-accent disabled:opacity-40"
      >
        {linking ? <Loader2 size={11} className="animate-spin" /> : <Users size={11} />}
        Link
      </button>
      <button
        type="button"
        disabled={linking}
        onClick={() => onLinkNew(participant)}
        title="Create a new Tribe person from this participant and link them"
        className="inline-flex min-h-[28px] items-center gap-1 rounded border border-port-border px-2 py-1 text-[11px] text-gray-200 transition-colors hover:border-port-accent disabled:opacity-40"
      >
        <UserPlus size={11} />
        New
      </button>
    </li>
  );
}

export default function BeeperThread({
  conversation,
  messages,
  loading,
  error,
  hasMore,
  loadingMore,
  onLoadMore,
  draft,
  onDraftChange,
  people,
  linkingId,
  onLinkParticipant,
  onCreateAndLinkParticipant,
  onBack,
  onArchive,
  onLowPriority,
  writePending,
}) {
  const [peopleOpen, setPeopleOpen] = useState(false);
  const bottomRef = useRef(null);

  // Newest-first from the API (the order a chat surface pages in); oldest-first
  // for display. Reversing here rather than server-side keeps the cursor
  // semantics honest: the API never pretends the oldest message is one call away.
  const ordered = useMemo(() => [...messages].reverse(), [messages]);
  const senderName = useMemo(() => {
    const map = new Map();
    for (const participant of conversation?.participants || []) {
      map.set(participant.sourceUserId, participant.tribePersonName || participant.displayName || participant.handle || '');
    }
    return map;
  }, [conversation?.participants]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversation?.id, ordered.length]);

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-gray-500">
        Pick a conversation
      </div>
    );
  }

  let lastDay = null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-port-border px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="rounded p-1.5 text-gray-400 hover:text-white md:hidden"
        >
          <ArrowLeft size={16} />
        </button>
        <Avatar name={conversation.title} size={28} />
        <div className="min-w-0">
          <p className="flex items-center gap-1 truncate text-sm text-white">
            {conversation.title || 'Untitled conversation'}
            {conversation.isMuted && <BellOff size={11} className="shrink-0 text-gray-500" />}
          </p>
          <p className="truncate text-[11px] text-gray-500">{networkLabel(conversation.network)}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={writePending}
            onClick={() => onArchive(!conversation.isArchived)}
            title={conversation.isArchived ? 'Unarchive in Beeper' : 'Archive in Beeper'}
            className="inline-flex min-h-[32px] items-center gap-1 rounded border border-port-border px-2 text-[11px] text-gray-300 transition-colors hover:border-port-accent disabled:opacity-40"
          >
            <Archive size={12} />
            {conversation.isArchived ? 'Unarchive' : 'Archive'}
          </button>
          <button
            type="button"
            disabled={writePending}
            onClick={() => onLowPriority(!conversation.isLowPriority)}
            title={conversation.isLowPriority ? 'Restore normal priority in Beeper' : 'Mark low priority in Beeper'}
            className="inline-flex min-h-[32px] items-center gap-1 rounded border border-port-border px-2 text-[11px] text-gray-300 transition-colors hover:border-port-accent disabled:opacity-40"
          >
            <ChevronDown size={12} />
            {conversation.isLowPriority ? 'Normal' : 'Low priority'}
          </button>
          <button
            type="button"
            onClick={() => setPeopleOpen((open) => !open)}
            aria-expanded={peopleOpen}
            className="inline-flex min-h-[32px] items-center gap-1 rounded border border-port-border px-2 text-[11px] text-gray-300 transition-colors hover:border-port-accent"
          >
            <Users size={12} />
            People
          </button>
        </div>
      </div>

      {peopleOpen && (
        <div className="shrink-0 border-b border-port-border bg-port-bg/60 px-3 py-2">
          {/* Beeper truncates a participant list at 20 (list) / 100 (single
              GET) with no participants endpoint and no cursor, so this is a
              subset by construction — saying so beats implying a roster. */}
          <p className="pb-1 text-[11px] uppercase tracking-wide text-gray-500">
            Participants{conversation.hasMoreParticipants ? ' (partial — Beeper truncates long rosters)' : ''}
          </p>
          {(conversation.participants || []).length === 0 ? (
            <p className="text-xs text-gray-500">No participants mirrored yet.</p>
          ) : (
            <ul className="max-h-40 divide-y divide-port-border/40 overflow-y-auto">
              {conversation.participants.map((participant) => (
                <ParticipantRow
                  key={participant.sourceUserId}
                  participant={participant}
                  people={people}
                  linking={linkingId === participant.sourceUserId}
                  onLink={onLinkParticipant}
                  onLinkNew={onCreateAndLinkParticipant}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
        {hasMore && (
          <div className="pb-2 text-center">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-port-border px-3 text-[11px] text-gray-300 transition-colors hover:border-port-accent disabled:opacity-40"
            >
              {loadingMore ? <Loader2 size={11} className="animate-spin" /> : null}
              Load earlier messages
            </button>
          </div>
        )}

        {error && <p className="py-2 text-center text-xs text-port-error">{error}</p>}

        {loading && ordered.length === 0 && (
          <p className="py-6 text-center text-xs text-gray-500">Loading messages…</p>
        )}

        {/* An empty thread is a legitimate steady state, not a spinner and not
            an error — history depth varies enormously per network. */}
        {!loading && !error && ordered.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-sm text-gray-300">No messages mirrored yet</p>
            <p className="max-w-sm text-[11px] text-gray-500">
              How much history a bridge hands over varies enormously between networks — some backfill years,
              some only what has arrived since you connected. An empty thread here is often correct rather than broken.
            </p>
          </div>
        )}

        {ordered.map((message) => {
          const day = dayLabel(message.sentAt);
          const showDay = day !== lastDay;
          lastDay = day;
          const name = senderName.get(message.senderId) || message.senderId || 'Unknown sender';
          const out = message.isSender === true;
          return (
            <div key={message.id}>
              {showDay && (
                <p className="py-2 text-center">
                  <span className="rounded-full bg-port-card px-2.5 py-0.5 text-[11px] text-gray-400">{day}</span>
                </p>
              )}
              <div
                data-testid="beeper-message"
                data-direction={out ? 'out' : 'in'}
                className={`flex items-end gap-2 ${out ? 'justify-end' : 'justify-start'}`}
              >
                {!out && <Avatar name={name} size={26} />}
                <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm text-gray-100 ${out ? 'bg-port-accent/25' : 'bg-port-card'}`}>
                  {!out && <p className="mb-0.5 text-[11px] font-medium text-port-accent">{name}</p>}
                  {message.unsentAt ? (
                    <p className="flex items-center gap-1.5 italic text-gray-500">
                      <Trash2 size={12} /> This message was unsent
                    </p>
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  )}
                  {(message.attachments || []).map((attachment) => (
                    <p
                      key={`${message.id}-${attachment.idx}`}
                      className="mt-1 flex items-center gap-1.5 rounded border border-dashed border-port-border px-2 py-1 text-[11px] text-gray-400"
                    >
                      <Paperclip size={11} />
                      {attachment.fileName || attachment.mimeType || 'Attachment'}
                    </p>
                  ))}
                  <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-gray-500">
                    {clockTime(message.sentAt)}
                    {message.editedAt && <span>· edited</span>}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-port-border p-2.5">
        <button
          type="button"
          aria-label="Attach a file"
          title="Attachments are not wired yet"
          disabled
          className="shrink-0 rounded-full p-2 text-gray-600"
        >
          <Plus size={17} />
        </button>
        <div className="flex flex-1 items-center gap-2 rounded-full border border-port-border bg-port-card px-3 py-1.5">
          <NetworkLogo network={conversation.network} size={15} />
          <label htmlFor="beeper-composer" className="sr-only">
            Message {conversation.title} on {networkLabel(conversation.network)}
          </label>
          <textarea
            id="beeper-composer"
            rows={1}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={`Message ${conversation.title || 'this chat'} on ${networkLabel(conversation.network)}`}
            className="min-w-0 flex-1 resize-none bg-transparent text-sm text-white placeholder:text-gray-500 focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled
          aria-label="Send"
          title="Sending from PortOS is not wired yet — the durable outbox lands in a follow-up slice. Your draft is kept."
          className="shrink-0 rounded-full bg-port-accent/40 p-2 text-port-bg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
