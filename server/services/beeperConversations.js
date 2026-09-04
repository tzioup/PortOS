/**
 * Read model + wired rail controls for the Beeper chat surface (#35, design
 * decided on #9; store shape from #7/#27).
 *
 * **The mirror is the read path.** Nothing here calls Beeper to *read*: the
 * surface renders `beeper_conversations` / `beeper_messages` /
 * `beeper_participants`, which the sweep (#32) and the socket relay (#33)
 * keep current. That is what makes "displayed" imply "persisted", keeps the
 * list correct while Beeper Desktop is closed, and keeps the socket frames
 * invalidation-only — a refetch here is a local query, not a fan-out to the
 * upstream API.
 *
 * The two rail controls that are WIRED (#9: `Archive` and `Low priority`,
 * because `isArchived` and `isLowPriority` are real fields on every chat row)
 * are the one exception: they PATCH Beeper first and mirror the result second,
 * because Beeper owns that state. `isPinned` is deliberately NOT here — the
 * pinned set is Beeper's own, mirrored (#27), and a PortOS-local pin would be
 * a second source of truth for it.
 *
 * Writes NEVER retry. `beeperRequest`'s `allowRetry` already defaults to false
 * for exactly this reason, and the route surfaces `retryable: false` so a
 * client cannot invent a retry policy on top of an API with no idempotency key.
 */

import { query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { updateChat } from './beeperClient.js';

// The list endpoint returns a PARTICIPANT SUBSET, never a roster. Beeper's own
// participant lists truncate at 20 (list) / 100 (single GET) with no
// participants endpoint and no cursor (#2), so a row set is always a possible
// subset — `beeper_participants.observed_via` records which. Capping here is
// therefore honest rather than lossy: the number is a row-budget for the list
// payload, and `hasMoreParticipants` says the cell is not the whole story.
const LIST_PARTICIPANT_CAP = 8;

const DEFAULT_CONVERSATION_LIMIT = 50;
const MAX_CONVERSATION_LIMIT = 200;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/**
 * Keyset cursors, not offsets. An offset re-reads a window that shifted under
 * an incoming message and silently drops or repeats a row; the surface refetches
 * on every invalidation frame, so that shift is the normal case rather than a
 * rare one. The cursor carries the exact ordering tuple `(orderingTs, id)` the
 * ORDER BY uses, base64url-encoded so it is opaque to the client.
 */
export function encodeCursor(orderingTs, id) {
  if (!orderingTs || !id) return null;
  return Buffer.from(`${new Date(orderingTs).toISOString()}|${id}`, 'utf8').toString('base64url');
}

/**
 * `null` for anything unparseable — a stale or hand-edited cursor restarts the
 * page rather than 500ing, which is the same posture the rest of the surface
 * takes toward a deleted conversation id.
 */
export function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  if (separator <= 0) return null;
  const ts = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!id || Number.isNaN(new Date(ts).getTime())) return null;
  return { ts: new Date(ts).toISOString(), id };
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

const toIso = (value) => (value ? new Date(value).toISOString() : null);

function shapeConversation(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    network: row.network || '',
    sourceChatId: row.source_chat_id,
    title: row.title || '',
    type: row.type || 'single',
    isGroup: row.is_group === true,
    isPinned: row.is_pinned === true,
    isArchived: row.is_archived === true,
    isLowPriority: row.is_low_priority === true,
    isMuted: row.is_muted === true,
    lastActivity: toIso(row.last_activity),
    unreadCount: Number(row.unread_count) || 0,
    // `null` = this conversation has no mirrored message yet, which is
    // frequently CORRECT rather than pending: history depth varies enormously
    // per network (#3), so the surface says so instead of spinning.
    lastMessage: row.preview_id
      ? {
        id: row.preview_id,
        body: row.preview_unsent_at ? '' : (row.preview_body || ''),
        senderId: row.preview_sender_id || '',
        sentAt: toIso(row.preview_sent_at),
        isUnsent: Boolean(row.preview_unsent_at),
        isSender: row.preview_is_sender === true,
      }
      : null,
    participants: [],
    hasMoreParticipants: false,
  };
}

function shapeParticipant(row) {
  return {
    conversationId: row.conversation_id,
    sourceUserId: row.source_user_id,
    displayName: row.display_name || '',
    handle: row.handle || '',
    // The cache column from #27/#34. `null` means "not linked", never "no
    // person exists" — the inline link action on the thread is what resolves it.
    tribePersonId: row.tribe_person_id || null,
    tribePersonName: row.tribe_person_name || null,
    observedVia: row.observed_via || '',
  };
}

function shapeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id || '',
    // A tombstoned message keeps its row AND its body in the store (#7/#13);
    // the surface renders the placeholder instead, so the body is withheld
    // here rather than shipped to a client that must not display it.
    body: row.unsent_at ? '' : (row.body || ''),
    sentAt: toIso(row.sent_at),
    editedAt: toIso(row.edited_at),
    unsentAt: toIso(row.unsent_at),
    // Which side of the thread this belongs on, mirrored from the API's own
    // `Message.isSender` (#27's `is_sender`). Derived server-side and never
    // guessed from `senderId`: `accounts[].user.id` differs from `senderID` on
    // every network, so the client has nothing to compare against.
    isSender: row.is_sender === true,
    attachments: [],
  };
}

function shapeAttachment(row) {
  return {
    messageId: row.message_id,
    idx: Number(row.idx) || 0,
    // Metadata only — the byte mirror is #13. `mxcId` is a REFERENCE the
    // attachment slice resolves later, never a URL the browser can fetch.
    mxcId: row.mxc_id || null,
    mimeType: row.mime_type || '',
    byteLength: row.byte_length === null || row.byte_length === undefined ? null : Number(row.byte_length),
    fileName: row.file_name || '',
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
  };
}

const clampLimit = (value, fallback, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Attach the participant subset to a page of conversations in ONE extra query
 * rather than one per row. Ordering puts linked people first so the capped
 * subset shows the rows a Tribe link already resolved.
 */
async function attachParticipants(conversations, { cap = LIST_PARTICIPANT_CAP } = {}) {
  if (conversations.length === 0) return conversations;
  const ids = conversations.map((c) => c.id);
  const result = await query(
    `SELECT p.conversation_id, p.source_user_id, p.display_name, p.handle,
            p.tribe_person_id, p.observed_via, tp.name AS tribe_person_name
       FROM beeper_participants p
       LEFT JOIN tribe_people tp ON tp.id = p.tribe_person_id
      WHERE p.conversation_id = ANY($1::uuid[])
      ORDER BY p.conversation_id,
               (p.tribe_person_id IS NULL),
               p.display_name,
               p.source_user_id`,
    [ids],
  );
  const byConversation = new Map(ids.map((id) => [id, []]));
  for (const row of result?.rows || []) {
    byConversation.get(row.conversation_id)?.push(shapeParticipant(row));
  }
  return conversations.map((conversation) => {
    const all = byConversation.get(conversation.id) || [];
    return {
      ...conversation,
      participants: cap === null ? all : all.slice(0, cap),
      hasMoreParticipants: cap !== null && all.length > cap,
    };
  });
}

/**
 * One page of the conversation list, newest activity first.
 *
 * Every filter is TRI-STATE by omission: an absent `archived` means "do not
 * filter on archived at all", which is a different query from `archived:false`.
 * The rail's Inbox scope asks for `archived:false, lowPriority:false`; the
 * Archive and Low-priority scopes ask for the positive. Collapsing absent into
 * false would make the unified scope silently hide archived chats with no way
 * to ask for them (root AGENTS.md, absent-vs-empty).
 */
export async function listConversations({
  network, unreadOnly, archived, lowPriority, limit, cursor,
} = {}) {
  const pageSize = clampLimit(limit, DEFAULT_CONVERSATION_LIMIT, MAX_CONVERSATION_LIMIT);
  const params = [];
  const where = [];

  if (typeof network === 'string' && network) {
    params.push(network);
    where.push(`c.network = $${params.length}`);
  }
  if (unreadOnly === true) where.push('c.unread_count > 0');
  if (typeof archived === 'boolean') {
    params.push(archived);
    where.push(`c.is_archived = $${params.length}`);
  }
  if (typeof lowPriority === 'boolean') {
    params.push(lowPriority);
    where.push(`c.is_low_priority = $${params.length}`);
  }

  const decoded = decodeCursor(cursor);
  if (decoded) {
    params.push(decoded.ts, decoded.id);
    where.push(`(COALESCE(c.last_activity, c.created_at), c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  params.push(pageSize + 1);
  const result = await query(
    `SELECT c.*,
            lm.id AS preview_id, lm.body AS preview_body, lm.sender_id AS preview_sender_id,
            lm.sent_at AS preview_sent_at, lm.unsent_at AS preview_unsent_at,
            lm.is_sender AS preview_is_sender,
            COALESCE(c.last_activity, c.created_at) AS ordering_ts
       FROM beeper_conversations c
       LEFT JOIN LATERAL (
         SELECT m.id, m.body, m.sender_id, m.sent_at, m.unsent_at, m.is_sender
           FROM beeper_messages m
          WHERE m.conversation_id = c.id
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
          LIMIT 1
       ) lm ON TRUE
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(c.last_activity, c.created_at) DESC, c.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const rows = result?.rows || [];
  const page = rows.slice(0, pageSize);
  const conversations = await attachParticipants(page.map(shapeConversation));
  const last = page[page.length - 1];
  return {
    conversations,
    // `null`, not an empty string: "there is no next page" is a different
    // answer from "here is a cursor that returns nothing".
    nextCursor: rows.length > pageSize && last ? encodeCursor(last.ordering_ts, last.id) : null,
  };
}

/** One conversation, with its FULL mirrored participant set (no list cap). */
export async function getConversation(conversationId) {
  const result = await query(
    `SELECT c.*,
            lm.id AS preview_id, lm.body AS preview_body, lm.sender_id AS preview_sender_id,
            lm.sent_at AS preview_sent_at, lm.unsent_at AS preview_unsent_at,
            lm.is_sender AS preview_is_sender
       FROM beeper_conversations c
       LEFT JOIN LATERAL (
         SELECT m.id, m.body, m.sender_id, m.sent_at, m.unsent_at, m.is_sender
           FROM beeper_messages m
          WHERE m.conversation_id = c.id
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
          LIMIT 1
       ) lm ON TRUE
      WHERE c.id = $1`,
    [conversationId],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  const [conversation] = await attachParticipants([shapeConversation(row)], { cap: null });
  return conversation;
}

/**
 * One page of a thread, NEWEST FIRST — the order a chat surface actually
 * consumes, because it renders the tail and pages backwards into history. The
 * client reverses for display; the API does not pretend the oldest message is
 * reachable in one call, because on several networks it is not.
 */
export async function listMessages(conversationId, { limit, cursor } = {}) {
  const pageSize = clampLimit(limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
  const params = [conversationId];
  let keyset = '';
  const decoded = decodeCursor(cursor);
  if (decoded) {
    params.push(decoded.ts, decoded.id);
    keyset = ` AND (COALESCE(m.sent_at, m.created_at), m.id) < ($2::timestamptz, $3::text)`;
  }
  params.push(pageSize + 1);

  const result = await query(
    `SELECT m.*, COALESCE(m.sent_at, m.created_at) AS ordering_ts
       FROM beeper_messages m
      WHERE m.conversation_id = $1${keyset}
      ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const rows = result?.rows || [];
  const page = rows.slice(0, pageSize);
  const messages = page.map(shapeMessage);

  if (messages.length > 0) {
    const attachments = await query(
      `SELECT message_id, idx, mxc_id, mime_type, byte_length, file_name, width, height
         FROM beeper_attachments
        WHERE conversation_id = $1 AND message_id = ANY($2::text[])
        ORDER BY message_id, idx`,
      [conversationId, messages.map((m) => m.id)],
    );
    const byMessage = new Map(messages.map((m) => [m.id, m]));
    for (const row of attachments?.rows || []) {
      byMessage.get(row.message_id)?.attachments.push(shapeAttachment(row));
    }
  }

  const last = page[page.length - 1];
  return {
    messages,
    nextCursor: rows.length > pageSize && last ? encodeCursor(last.ordering_ts, last.id) : null,
  };
}

/**
 * The rail's scope list: the networks actually present in the mirror, never a
 * hardcoded roster. #9 is explicit that the development machine's nine
 * networks are an outlier (today's free tier caps a new account at five, most
 * installs have one), so anything that enumerates networks reads them from
 * data — a network PortOS has never heard of still renders.
 *
 * Unread is aggregated over NON-ARCHIVED rows only: the rail badge answers
 * "how much is waiting in my inbox", and an archived chat is by definition not.
 */
export async function listNetworks() {
  const result = await query(
    `SELECT c.network,
            COUNT(*)::int AS conversation_count,
            COALESCE(SUM(c.unread_count) FILTER (WHERE c.is_archived = FALSE), 0)::int AS unread_count,
            COUNT(*) FILTER (WHERE c.unread_count > 0 AND c.is_archived = FALSE)::int AS unread_conversations,
            ARRAY_AGG(DISTINCT c.account_id) AS account_ids,
            MAX(COALESCE(c.last_activity, c.created_at)) AS last_activity
       FROM beeper_conversations c
      WHERE c.network <> ''
      GROUP BY c.network
      ORDER BY c.network`,
  );
  return (result?.rows || []).map((row) => ({
    network: row.network,
    conversationCount: Number(row.conversation_count) || 0,
    unreadCount: Number(row.unread_count) || 0,
    unreadConversations: Number(row.unread_conversations) || 0,
    accountIds: Array.isArray(row.account_ids) ? row.account_ids.filter(Boolean) : [],
    lastActivity: toIso(row.last_activity),
  }));
}

// ---------------------------------------------------------------------------
// Wired rail controls (#9: Archive and Low priority)
// ---------------------------------------------------------------------------

/**
 * The one write shape this slice has. Beeper owns the flag, so the order is
 * PATCH-then-mirror: a mirror row updated before the upstream call would show a
 * state the network never accepted, and the next sweep would silently revert it.
 *
 * The PATCH does not retry (`beeperRequest`'s default), and a failure
 * propagates as a coded `BeeperApiError` with the mirror untouched.
 *
 * The response is Beeper's updated `Chat`. It is read DEFENSIVELY: a bridge
 * that answers 200 with a body missing the flag must not blank the mirror, so
 * the requested value is the fallback — present-but-false is honoured, absent
 * is not.
 */
async function setConversationFlag(conversationId, field, column, value) {
  const found = await query(
    'SELECT id, source_chat_id FROM beeper_conversations WHERE id = $1',
    [conversationId],
  );
  const row = found?.rows?.[0];
  if (!row) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });

  const chat = await updateChat(row.source_chat_id, { [field]: value });
  const applied = typeof chat?.[field] === 'boolean' ? chat[field] : value;

  await query(
    `UPDATE beeper_conversations SET ${column} = $2, updated_at = NOW() WHERE id = $1`,
    [conversationId, applied],
  );
  console.log(`🫧 Beeper ${field}=${applied} on conversation ${conversationId}`);
  return getConversation(conversationId);
}

export const setConversationArchived = (conversationId, archived) =>
  setConversationFlag(conversationId, 'isArchived', 'is_archived', archived === true);

export const setConversationLowPriority = (conversationId, lowPriority) =>
  setConversationFlag(conversationId, 'isLowPriority', 'is_low_priority', lowPriority === true);
