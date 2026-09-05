import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Archive, BellOff, ChevronDown, Loader2, Plus, RefreshCw, Send, Trash2, UserPlus, Users,
} from 'lucide-react';
import NetworkLogo, { networkLabel } from './BeeperNetworkLogo';
import BeeperAttachment from './BeeperAttachment';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { decodeHtmlEntities, parseMessageBody } from '../../../lib/beeperMessageBody';
import { formatBytes } from '../../../utils/formatters';

/**
 * Thread + composer + the inline Tribe-linking action, for the Beeper chat
 * surface (#35). Structure ported from the #9 prototype (`BeeperSurface.jsx`):
 * date-separator pills, sender avatars, deleted-message placeholders, and a
 * composer that names the network it would send on.
 *
 * Two things this deliberately does NOT do:
 *
 *  - **It does not treat an empty thread as an error or as loading.** History
 *    depth varies enormously per network (#3), so a mirrored conversation with
 *    no messages is frequently the true answer. It says that, rather than
 *    spinning forever or rendering a fault.
 *  - **It does not name the transport.** #9 wants "… on Google Messages (RCS)";
 *    the mirror carries `network` but not `transport` (#27), so the label stops
 *    at the network rather than inventing one.
 *
 * Sending itself (#53, wired on the durable outbox from #36) is a thin layer
 * over `onSend`/`confirmAndSend`/`cancelConfirmation`/`retryOutboxEntry`/
 * `dismissOutboxEntry`, which the surface supplies from `useBeeperOutbox`.
 * This component owns none of the send lifecycle — it only renders what the
 * hook reports: the pending/failed/stalled rows in `outboxEntries` (filtered
 * against `messages` so a confirmed send shows once, as the real mirrored
 * message, not twice), and the inline first-contact question when
 * `confirmation` is set. Nothing here ever retries a send that touched the
 * wire on its own; a `failed` row's "Retry" composes a NEW outbox entry with
 * the same text, exactly like typing it again, because Beeper has no
 * idempotency key and a client-driven resend of the same row would risk a
 * duplicate real message. A stalled `approved` row (PR #60 blocker 1 — a
 * send refused before the server could even claim the row, most often
 * `OUTBOX_BREAKER_OPEN`) is the opposite case: nothing touched the wire, so
 * its "Retry" re-dispatches the SAME row, and it also gets a "Dismiss" to
 * give up on it — the original bug was this state having neither.
 *
 * Direction comes from the mirrored `isSender`, never from comparing
 * `senderId` against the local user — `accounts[].user.id` differs from
 * `senderID` on every network (#2), so there is nothing to compare against.
 * Own messages sit right-aligned with no sender name and no avatar, the
 * reference interface's shape.
 */

/**
 * One message body.
 *
 * Two shapes arrive from Beeper and both are handled here. A PLAIN body is a
 * text node with its entities decoded (#59: an ampersand was rendering as the
 * five-character `&amp;`, because `normalizeMessageRow` stores what the source
 * sent and some bridges send entity-encoded text). An HTML body — 26% of
 * messages on a real install, Discord and Matrix — is parsed into an
 * allowlisted block/span model by `lib/beeperMessageBody.js` and rendered as
 * React elements, since rendering it as a text node showed the tags literally.
 *
 * Nothing here ever reaches `dangerouslySetInnerHTML`: every branch produces
 * elements and text nodes, so a tag outside the allowlist cannot execute, load
 * or style anything.
 */
function MessageBody({ body }) {
  const blocks = parseMessageBody(body);
  if (blocks === null) return <p className="whitespace-pre-wrap break-words">{decodeHtmlEntities(body)}</p>;
  return blocks.map((block, blockIndex) => {
    const spans = block.spans.map((span, spanIndex) => {
      const key = `${blockIndex}-${spanIndex}`;
      let node = span.text;
      if (span.bold) node = <strong className="font-semibold">{node}</strong>;
      if (span.italic) node = <em className="italic">{node}</em>;
      if (span.href) {
        node = (
          <a
            href={span.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-port-accent underline underline-offset-2"
          >
            {node}
          </a>
        );
      }
      return <span key={key}>{node}</span>;
    });
    return block.type === 'quote'
      ? (
        <blockquote key={blockIndex} className="my-1 border-l-2 border-port-border pl-2 whitespace-pre-wrap break-words text-gray-300">
          {spans}
        </blockquote>
      )
      : <p key={blockIndex} className="whitespace-pre-wrap break-words">{spans}</p>;
  });
}

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

/**
 * The exact sentence shown for a send the server found stranded in `sending` at
 * boot (`SEND_INTERRUPTED`, written by `reconcileOutboxOnBoot` in
 * `server/services/beeperOutbox.js`, which owns the identical literal — the two
 * bundles cannot share a module, so they share a test instead).
 *
 * It deliberately does not claim a delivery verdict. The POST was in flight
 * when the process died, so whether it landed is unknowable from here; the copy
 * points at the chat, because looking is the only thing that actually answers
 * it, and Retry composes a new message rather than resending that one.
 */
const SEND_INTERRUPTED_COPY = 'Delivery unconfirmed: PortOS restarted mid-send. Check the chat before retrying.';

/**
 * One outbox row — a send that has not yet been confirmed by the mirror, or
 * one that failed. Always outbound (right-aligned, no avatar), matching the
 * bubble a mirrored `isSender` message renders, so a pending send does not
 * visually jump when it swaps for the real thing.
 *
 * Only ONE of the four outcomes below spins, and the spinner is the exception
 * rather than the default. Every state that will not change on its own — a
 * failure, an interrupted send, an unconfirmed one, a refused one — resolves to
 * a terminal line that says what happened, because a spinner for a state
 * nothing can ever advance is a lie the user cannot dismiss, and it survives
 * every reload.
 *
 * `approved` is normally in flight for the moment between the create and
 * send requests (`sending` is true). If it is STILL `approved` once nothing
 * is actively sending — and it is not the row a first-contact confirmation
 * is currently asking about — the send was refused before the server could
 * even claim the row, most often `OUTBOX_BREAKER_OPEN` (#36). Left alone
 * that renders as a permanent "Sending…" phantom that survives reload (PR
 * #60 blocker 1), so it gets the same "stalled" treatment as `failed`: a
 * reason, a Retry, and — since nothing here was ever posted to Beeper — a
 * Dismiss that gives up on it outright.
 *
 * The two Retries are not the same action, and the breaker splits them (PR
 * #60 blocker 2). A `failed` row's Retry composes a NEW entry through the
 * composer's own send path, which the breaker blocks exactly as it blocks
 * Send — so with the breaker tripped that button is disabled and carries the
 * same reason as the Send button, rather than staying live and doing nothing.
 * A `stalled` row's Retry re-dispatches the existing row: the server decides,
 * and its 429 toasts, so it stays enabled.
 */
function OutboxRow({
  entry, sending, isConfirming, onRetry, onDismiss, breakerTripped, breakerReason,
}) {
  const failed = entry.state === 'failed';
  const interrupted = failed && entry.errorCode === 'SEND_INTERRUPTED';
  // Recorded by the server's 30s fallback when it could not find the message it
  // had just sent. The row stays `awaiting-confirmation` on purpose — the send
  // may well have been delivered, and marking it failed would invite the one
  // mistake that cannot be taken back — so this reads as "sent, unconfirmed",
  // carries the reason the server recorded, and offers NO Retry. It never
  // changes on its own, so it must never spin.
  const unresolved = !failed && entry.errorCode === 'CONFIRMATION_UNRESOLVED';
  const stalled = entry.state === 'approved' && !sending && !isConfirming;
  const blocked = failed || stalled;
  const confirming = entry.state === 'awaiting-confirmation' || entry.state === 'sent';
  const retryBlocked = breakerTripped && !stalled;
  const outcome = blocked ? (failed ? 'failed' : 'stalled') : (unresolved ? 'unconfirmed' : 'pending');
  // An interrupted send gets the copy verbatim and nothing else: prefixing
  // "Not delivered" would assert a verdict the crash destroyed the evidence for.
  let blockedReason = 'Not sent — the send was refused';
  if (interrupted) blockedReason = SEND_INTERRUPTED_COPY;
  else if (failed) blockedReason = `Not delivered${entry.errorMessage ? ` — ${entry.errorMessage}` : ''}`;
  return (
    <div
      data-testid="beeper-outbox-row"
      data-state={entry.state}
      data-outcome={outcome}
      className="flex items-end justify-end gap-2"
    >
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm text-gray-100 ${
          blocked ? 'border border-port-error/40 bg-port-error/10' : 'bg-port-accent/25'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{entry.body}</p>
        <span className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px]">
          {blocked && (
            <>
              <span className="text-port-error">{blockedReason}</span>
              <button
                type="button"
                onClick={() => onRetry(entry)}
                disabled={retryBlocked}
                title={retryBlocked ? breakerReason : undefined}
                className="rounded px-1 py-0.5 text-port-accent transition-colors hover:underline disabled:cursor-not-allowed disabled:text-gray-500 disabled:no-underline disabled:hover:no-underline"
              >
                Retry
              </button>
              {stalled && (
                <button
                  type="button"
                  onClick={() => onDismiss(entry)}
                  className="rounded px-1 py-0.5 text-gray-400 transition-colors hover:underline"
                >
                  Dismiss
                </button>
              )}
            </>
          )}
          {unresolved && (
            <span className="text-port-warning">
              {`Sent, unconfirmed${entry.errorMessage ? ` — ${entry.errorMessage}` : ''}`}
            </span>
          )}
          {!blocked && !unresolved && (
            <span className="flex items-center gap-1 text-gray-400">
              <Loader2 size={10} className="animate-spin" />
              {confirming ? 'Confirming…' : 'Sending…'}
            </span>
          )}
        </span>
      </div>
    </div>
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
  outboxEntries = [],
  sending = false,
  confirmation = null,
  onSend,
  confirmAndSend,
  cancelConfirmation,
  retryOutboxEntry,
  dismissOutboxEntry,
  breaker = null,
  people,
  linkingId,
  onLinkParticipant,
  onCreateAndLinkParticipant,
  onBack,
  onRetry,
  onArchive,
  onLowPriority,
  onPurge,
  purging,
  onAttachmentUpdated,
  writePending,
}) {
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeConfirmation, setPurgeConfirmation] = useState('');
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

  // Outbox rows still worth showing: anything the mirror has not caught up
  // with yet. Once a `sent` entry's `messageId` shows up in `messages` (the
  // real message, arrived via the invalidation-driven refetch), it is dropped
  // here rather than rendered twice — the mirrored message IS the confirmation.
  // `entries` arrives newest-first (the server's own order, preserved through
  // every client-side prepend); reversed to read oldest-first like `ordered`.
  const visibleOutbox = useMemo(() => {
    const mirroredIds = new Set(messages.map((message) => message.id));
    return [...outboxEntries]
      .filter((entry) => !(entry.messageId && mirroredIds.has(entry.messageId)))
      .reverse();
  }, [outboxEntries, messages]);

  const trimmedDraft = draft.trim();
  const breakerTripped = Boolean(breaker?.tripped);
  const canSend = trimmedDraft.length > 0 && !sending && !breakerTripped;
  const sendDisabledReason = breakerTripped
    ? `Beeper sending is blocked by the runaway breaker (${breaker?.reason || 'unexpected send rate'}) — clear it in Beeper settings.`
    : (trimmedDraft.length === 0 ? 'Type a message to send' : undefined);

  const handleSendClick = () => { if (canSend) onSend(draft); };
  // Bare Enter stays a newline (the textarea is multi-line); ⌘/Ctrl+Enter is
  // the send shortcut, matching the reference interface and #53's spec.
  const handleComposerKeyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSendClick();
    }
  };
  // A failed row's only recovery: compose the SAME text again as a brand new
  // outbox entry. Never a resend of the failed row — see the file docstring.
  // A stalled `approved` row (PR #60 blocker 1) is the opposite case: nothing
  // ever reached Beeper for it, so retrying re-sends the SAME row instead —
  // composing a new one on every click would just manufacture more phantoms
  // while the breaker stays tripped.
  //
  // `clearsDraft: false` on the failed-row path: that send is the OLD row's
  // text, not what is in the composer. Clearing on its success would throw
  // away a message typed while the failed row sat above it — and drop it from
  // storage too, since the surface's `setDraft('')` deletes the persisted
  // entry. Only the composer's own Send clears the composer.
  const handleRetry = (entry) => {
    if (entry.state === 'approved') { retryOutboxEntry?.(entry); return; }
    if (!breakerTripped) onSend(entry.body, { clearsDraft: false });
  };
  const handleDismiss = (entry) => { dismissOutboxEntry?.(entry); };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversation?.id, ordered.length, visibleOutbox.length]);

  // A typed confirmation must never survive the conversation it was typed for:
  // switching threads with the panel open would otherwise leave a primed Purge
  // button pointing at a different chat.
  //
  // Keyed on a CHANGE of id, not on the id as a dependency: a refetch that
  // momentarily resolves `conversation` to null (a reload, a failed poll) would
  // otherwise fire this twice and silently close a panel the user is typing
  // into — the value is discarded on a real switch, never on a re-render.
  const purgeConversationRef = useRef(null);
  useEffect(() => {
    const id = conversation?.id || null;
    if (!id || purgeConversationRef.current === id) return;
    purgeConversationRef.current = id;
    setPurgeOpen(false);
    setPurgeConfirmation('');
  }, [conversation?.id]);

  // Order matters, and this is the whole reason these three are separate
  // branches: `loading` and `error` are both reachable with NO conversation —
  // a cold deep link whose detail fetch fails (503, 500, offline) leaves
  // `conversation` null and `error` set. Answering that with "Pick a
  // conversation" renders a named URL as if nothing were selected, with no
  // error and no way back: every fetch behind this passes `{ silent: true }`,
  // so there is no toast either. "Pick a conversation" is only correct when
  // nothing is selected, nothing is in flight, and nothing went wrong.
  if (!conversation && error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-gray-300">Could not open this conversation</p>
        <p className="max-w-sm text-[11px] text-port-error">{error}</p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={loading}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-port-border px-3 text-xs text-gray-200 transition-colors hover:border-port-accent disabled:opacity-40"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            className="min-h-[36px] rounded-lg px-3 text-xs text-gray-400 transition-colors hover:text-gray-200"
          >
            Back to conversations
          </button>
        </div>
      </div>
    );
  }

  if (!conversation && loading) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-gray-500">
        Loading conversation…
      </div>
    );
  }

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
          {onPurge && (
            <button
              type="button"
              onClick={() => setPurgeOpen((open) => !open)}
              aria-expanded={purgeOpen}
              title="Delete this conversation's PortOS mirror — Beeper keeps the chat"
              className="inline-flex min-h-[32px] items-center gap-1 rounded border border-port-border px-2 text-[11px] text-gray-300 transition-colors hover:border-port-error hover:text-port-error"
            >
              <Trash2 size={12} />
              Purge
            </button>
          )}
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

      {/* The purge confirmation is TYPED, in-drawer, and names both the
          conversation and the bytes it is about to free (#13) — not a
          `window.confirm`, which the client conventions forbid and which could
          not state either fact. It is also explicit that this is a LOCAL
          purge: Beeper still has the chat, and the next sweep re-mirrors it. */}
      {purgeOpen && onPurge && (
        <div className="shrink-0 border-b border-port-error/40 bg-port-error/5 px-3 py-2">
          <p className="text-[11px] uppercase tracking-wide text-port-error">Purge this mirror</p>
          <p className="pt-1 text-xs text-gray-300">
            Deletes PortOS&rsquo;s copy of <span className="text-white">{conversation.title || 'this conversation'}</span>
            {' '}— its messages, participants and{' '}
            {formatBytes(conversation.attachmentBytes || 0)} of mirrored attachment bytes
            {conversation.attachmentFiles ? ` across ${conversation.attachmentFiles} file(s)` : ''}.
          </p>
          <p className="pt-1 text-[11px] text-gray-500">
            Beeper itself is untouched: the chat stays on its network, and the next sync will mirror it again.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <label htmlFor="beeper-purge-confirm" className="text-[11px] text-gray-400">
              Type <span className="font-mono text-gray-200">purge</span> to confirm
            </label>
            <input
              id="beeper-purge-confirm"
              type="text"
              value={purgeConfirmation}
              onChange={(event) => setPurgeConfirmation(event.target.value)}
              autoComplete="off"
              className="w-28 rounded border border-port-border bg-port-bg px-2 py-1 text-xs text-white"
            />
            <button
              type="button"
              disabled={purgeConfirmation.trim().toLowerCase() !== 'purge' || purging}
              onClick={() => onPurge()}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded border border-port-error px-2 text-[11px] text-port-error transition-colors hover:bg-port-error/10 disabled:opacity-40"
            >
              {purging ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
              Purge mirror
            </button>
            <button
              type="button"
              onClick={() => { setPurgeOpen(false); setPurgeConfirmation(''); }}
              className="min-h-[32px] px-2 text-[11px] text-gray-400 transition-colors hover:text-gray-200"
            >
              Cancel
            </button>
          </div>
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
            an error — history depth varies enormously per network. Gated on
            `visibleOutbox` too: the very first message to a brand-new,
            genuinely-empty conversation is itself a pending outbox row, and
            that is not "no messages mirrored yet" either. */}
        {!loading && !error && ordered.length === 0 && visibleOutbox.length === 0 && (
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
                    <MessageBody body={message.body} />
                  )}
                  {/* Bytes arrive on first view through the mirror route, not
                      with the message payload — see BeeperAttachment. */}
                  {(message.attachments || []).map((attachment) => (
                    <BeeperAttachment
                      key={`${message.id}-${attachment.idx}`}
                      attachment={attachment}
                      onUpdated={onAttachmentUpdated
                        ? (updated) => onAttachmentUpdated(message.id, updated)
                        : undefined}
                    />
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

        {/* Pending/failed sends. Not yet in `messages` — that arrives only
            once the mirror has caught up (#53, on the outbox from #36). */}
        {visibleOutbox.map((entry) => (
          <OutboxRow
            key={entry.id}
            entry={entry}
            sending={sending}
            isConfirming={confirmation?.entry?.id === entry.id}
            onRetry={handleRetry}
            onDismiss={handleDismiss}
            breakerTripped={breakerTripped}
            breakerReason={sendDisabledReason}
          />
        ))}

        <div ref={bottomRef} />
      </div>

      {/* First-contact confirmation (#8 decision 5, wired on #53): PortOS has
          never completed a send to this conversation, so the server refused
          and asked. Inline, never `window.confirm` — client conventions. */}
      {confirmation && (
        <InlineConfirmRow
          variant="separator"
          tone="warning"
          question={`This is the first message PortOS has sent to ${conversation.title || 'this contact'} on ${networkLabel(conversation.network)} — send it?`}
          confirmText="Send anyway"
          cancelText="Cancel"
          onConfirm={confirmAndSend}
          onCancel={cancelConfirmation}
        />
      )}

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
            onKeyDown={handleComposerKeyDown}
            placeholder={`Message ${conversation.title || 'this chat'} on ${networkLabel(conversation.network)}`}
            className="min-w-0 flex-1 resize-none bg-transparent text-sm text-white placeholder:text-gray-500 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={handleSendClick}
          disabled={!canSend}
          aria-label="Send"
          title={sendDisabledReason}
          className="shrink-0 rounded-full bg-port-accent p-2 text-port-bg transition-colors hover:bg-port-accent/85 disabled:cursor-not-allowed disabled:bg-port-accent/40 disabled:hover:bg-port-accent/40"
        >
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
}
