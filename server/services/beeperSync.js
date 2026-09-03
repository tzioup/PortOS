/**
 * Beeper ingestion sweep (#32, decided on #3 and #12; store shape from #7/#27,
 * Tribe linking from #10/#34, attachment policy from #13).
 *
 * This is the HTTP refetch that makes ingestion CORRECT. It is not a fallback
 * for a dead socket: Beeper's WebSocket is at-most-once with no replay on
 * reconnect, and it drops events during hydration while the connection looks
 * perfectly healthy, so a poll that only ran when the socket was down would be
 * asleep during two of the three loss paths. The socket (#33) makes ingestion
 * PROMPT; this sweep makes it complete, and it runs unconditionally on its own
 * timer.
 *
 * Watermark-bounded, never a full history rebuild. Per account:
 *   1. refresh `beeper_accounts` from the live roster (never `loginID`);
 *   2. page `GET /v1/chats?accountIDs=…` newest-first and STOP at the first
 *      chat that is not newer than its stored `beeper_sync_cursors.last_activity`
 *      — the list is ordered by last activity, so everything past it is older;
 *   3. for each changed chat: upsert the conversation, upsert participants
 *      (`beeperTribe.upsertParticipant`), page new messages from the stored
 *      opaque cursor with `direction: 'after'`, log daily Tribe touchpoints
 *      (`beeperTribe.logSenderTouchpoints`), then commit message rows,
 *      attachment references and the cursor row in ONE transaction.
 *
 * **The transaction boundary is the point of the whole module.** Message rows,
 * attachment references and the `beeper_sync_cursors` row commit together, so
 * an interrupted sweep leaves the cursor exactly where it was and the next
 * sweep refetches the same window. `imessageSync` implements the same
 * never-skip rule by hand precisely because its store and its cursor live in
 * different places (#12 decision 8); here they share a database, so the
 * guarantee is the transaction's rather than the author's.
 *
 * Everything OUTSIDE that transaction is deliberately idempotent and ordered
 * BEFORE it, so a crash between steps can only cause repeated work, never lost
 * work: the conversation upsert, the participant upserts and the touchpoint
 * writes are all keyed and deduped (touchpoints on `beeper:<YYYY-MM-DD>`), and
 * they all re-run on the next sweep because the cursor never moved.
 *
 * No AI provider call happens anywhere on this path — ingestion is
 * deterministic — so AGENTS.md's "No cold-bootstrap LLM calls" does not gate
 * it, exactly as `imessageScheduler.js` records for the same shape.
 */

import { query, withTransaction } from '../lib/db.js';
import {
  BeeperApiError,
  resolveBeeperConfig,
  getJoinedAccounts,
  listChatsPage,
  listMessagesPage,
} from './beeperClient.js';
import { upsertParticipant, logSenderTouchpoints } from './beeperTribe.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';
import { getSettings } from './settings.js';

export const DEFAULT_INTERVAL_MINUTES = 5;

// Safety caps. `GET /v1/chats` has no `limit`, so the page size is the
// server's; these bound one sweep's work rather than one page's.
const MAX_CHAT_PAGES_PER_ACCOUNT = 20;
// Catching up on new messages walks forward from the stored cursor, so this is
// a burst ceiling, not a history depth. A chat that is further behind than this
// keeps its (advanced) cursor and finishes catching up on the next sweep.
const MAX_MESSAGE_PAGES_PER_CHAT = 10;

const LOG_PREFIX = '🫧 Beeper sweep';

// ---------------------------------------------------------------------------
// Config + arming gate
// ---------------------------------------------------------------------------

/**
 * The `createSyncScheduler` config contract: `{ enabled, intervalMinutes }`.
 * `enabled` is the user's own "Enable scheduled Beeper sync" toggle from the
 * Comms → Beeper card (#30) — the ingestion flag, distinct from the instance
 * FEATURE flag that governs navigation (#11 keeps the two separate). The
 * interval is locked at registration by the factory; changing it needs a
 * restart, identical to the four existing ingestion domains.
 */
export async function getBeeperSyncConfig() {
  const settings = await getSettings().catch(() => ({}));
  const config = settings?.beeper || {};
  return {
    enabled: config.enabled === true,
    intervalMinutes: Number.isFinite(config.intervalMinutes) && config.intervalMinutes >= 1
      ? Math.floor(config.intervalMinutes)
      : DEFAULT_INTERVAL_MINUTES,
  };
}

/**
 * Whether the sweep may be armed at all: the instance feature is on AND a
 * token is configured (#12 decision 2). Deliberately SILENT — the acceptance
 * criterion on #32 is that with the feature off, or with no token, nothing is
 * registered and *nothing logs*; a fresh install that has never opened the
 * Beeper card should not narrate a feature it does not have.
 *
 * **Never gates on Beeper's `app.state`.** Measured on a live instance (#12):
 * the stream reported `initializing` for 105 continuous seconds while nine
 * accounts were `connected` and a chat page returned in 230 ms. Gating on it
 * would stall a healthy install indefinitely.
 *
 * The token is read through `resolveBeeperConfig`, the client's single
 * credential call site, so this works unchanged whether the token still lives
 * in `settings.beeper.token` or in the encrypted vault #31 lands behind that
 * same function. The token value itself is never returned, logged or stored.
 */
export async function isBeeperIngestionArmed() {
  const featureEnabled = await isInstanceFeatureEnabled('beeper').catch(() => false);
  if (!featureEnabled) return false;
  const { token } = await resolveBeeperConfig().catch(() => ({ token: null }));
  return Boolean(token);
}

// ---------------------------------------------------------------------------
// Normalizers (pure — no I/O, no DB)
// ---------------------------------------------------------------------------

function toIsoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toIntOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Account roster row. Fields are picked EXPLICITLY rather than spread — the
 * client already strips the top-level `loginID` (the bridge login credential,
 * effectively the user's phone number), and picking by name means a future
 * field added upstream cannot reach the database without someone naming it
 * here.
 */
export function normalizeAccountRow(account) {
  const accountId = typeof account?.accountID === 'string' ? account.accountID : '';
  return {
    accountId,
    network: String(account?.network ?? ''),
    displayName: String(account?.user?.fullName || account?.user?.username || account?.network || accountId || ''),
    status: String(account?.status || account?.bridgeStatus || ''),
    bridgeId: String(account?.bridgeId || account?.bridge || ''),
  };
}

/**
 * Conversation row. `type` is stored RAW: the schema deliberately carries no
 * enum constraint on it (`db.catalogDdlParity.test.js` forbids one), so a new
 * Beeper chat type never needs a two-file migration to accept. `is_group` is
 * the derived boolean the UI filters on.
 */
export function normalizeChatRow(chat) {
  const type = String(chat?.type || 'single');
  return {
    accountId: String(chat?.accountID ?? ''),
    sourceChatId: String(chat?.id ?? ''),
    network: String(chat?.network ?? ''),
    title: String(chat?.title ?? ''),
    type,
    isGroup: type === 'group',
    isPinned: chat?.isPinned === true,
    isArchived: chat?.isArchived === true,
    isLowPriority: chat?.isLowPriority === true,
    isMuted: chat?.isMuted === true,
    lastActivity: toIsoOrNull(chat?.lastActivity),
    unreadCount: Number.isFinite(chat?.unreadCount) ? Math.max(0, Math.trunc(chat.unreadCount)) : 0,
  };
}

/**
 * Message row. Two mutation shapes ride in on an ordinarily-shaped message
 * rather than as their own events (#7/#13):
 *   - an EDIT is a populated `editedTimestamp`;
 *   - an UNSEND is `isDeleted: true`, a tombstone that keeps the row and its
 *     body. The API reports no deletion timestamp, so `unsent_at` records when
 *     PortOS first OBSERVED the tombstone (`observedAt`) — the upsert below
 *     COALESCEs it, so the first observation is the one that sticks.
 */
export function normalizeMessageRow(message, observedAt) {
  return {
    id: String(message?.id ?? ''),
    senderId: String(message?.senderID ?? ''),
    body: typeof message?.text === 'string' ? message.text : '',
    sentAt: toIsoOrNull(message?.timestamp),
    editedAt: toIsoOrNull(message?.editedTimestamp),
    unsentAt: message?.isDeleted === true ? observedAt : null,
    sortKey: String(message?.sortKey ?? ''),
    // The API's own `isSender`, and the ONLY reliable inbound/outbound signal:
    // `accounts[].user.id` differs from `senderID` on every network (#2), so a
    // comparison against the local user cannot be made. Strict `=== true`, so a
    // bridge that omits the field lands on inbound rather than on `undefined`.
    isSender: message?.isSender === true,
  };
}

/**
 * Attachment REFERENCES only — metadata, never bytes (#13 puts the lazy byte
 * mirror and its disk budget in its own slice). `srcURL` and `posterImg` are
 * deliberately not persisted: both carry the spec's own "may be temporary or
 * local-only to this device" warning, so storing either would put a decaying
 * value in a durable archive. `sha256` has no source field on the inbound
 * `Attachment` at all and stays NULL until the byte mirror computes one.
 */
export function normalizeAttachmentRows(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  return attachments.map((attachment, idx) => ({
    idx,
    mxcId: typeof attachment?.id === 'string' && attachment.id ? attachment.id : null,
    mimeType: String(attachment?.mimeType ?? ''),
    byteLength: toIntOrNull(attachment?.fileSize),
    fileName: String(attachment?.fileName ?? ''),
    width: toIntOrNull(attachment?.size?.width),
    height: toIntOrNull(attachment?.size?.height),
  }));
}

/**
 * Participant roster entries for one chat. `participants` is always an OBJECT
 * (`{ hasMore, items, total }`), never a bare array, and it TRUNCATES at 20 on
 * the list endpoint with no participants endpoint and no cursor to continue on
 * — which is exactly why `beeper_participants.observed_via` exists (#27): a
 * roster row set is always a possible subset.
 */
export function normalizeParticipants(chat) {
  const items = Array.isArray(chat?.participants?.items) ? chat.participants.items : [];
  return items
    .filter((participant) => typeof participant?.id === 'string' && participant.id)
    .map((participant) => ({
      sourceUserId: participant.id,
      displayName: String(participant.fullName || participant.username || ''),
      handle: String(participant.phoneNumber || participant.username || ''),
    }));
}

/**
 * Whether a chat has moved since its stored watermark. Three distinct states,
 * never collapsed (the root AGENTS.md absent-vs-empty rule):
 *   - no cursor row at all → never swept, always sweep;
 *   - a row with no watermark → sweep only once the chat reports activity, so
 *     a genuinely empty chat (a Discord server channel with zero history is
 *     frequently correct) is not re-paged every five minutes forever;
 *   - both present → strictly newer wins.
 */
export function chatNeedsSweep(chat, stored) {
  if (!stored) return true;
  if (!stored.lastActivity) return Boolean(chat?.lastActivity);
  if (!chat?.lastActivity) return false;
  return new Date(chat.lastActivity).getTime() > new Date(stored.lastActivity).getTime();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every stored cursor for one account, as a `Map` keyed on the Beeper chat id. */
async function readAccountCursors(accountId) {
  const result = await query(
    `SELECT chat_id, cursor, last_activity FROM beeper_sync_cursors WHERE account_id = $1`,
    [accountId],
  );
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return new Map(rows.map((row) => [row.chat_id, {
    cursor: row.cursor || null,
    lastActivity: row.last_activity ? new Date(row.last_activity).toISOString() : null,
  }]));
}

function assertPagedShape(page, what) {
  if (!Array.isArray(page?.items)) {
    throw new BeeperApiError(`Beeper API returned an unexpected ${what} response shape (expected { items: [] })`, {
      status: 502, code: 'MALFORMED_RESPONSE', retryable: false,
    });
  }
}

/**
 * New messages for one chat, plus the opaque cursor to store.
 *
 * With a stored cursor this walks FORWARD (`direction: 'after'`), which the
 * SDK's own auto-pagination never does — it only ever reads `oldestCursor` —
 * so the forward walk is driven by hand here.
 *
 * With NO stored cursor this takes the newest page ONLY and anchors the cursor
 * there. Deep history backfill is a different feature with a different cost
 * profile (history depth varies wildly per network, #3), and silently pulling
 * every message of every chat the first time a user enables the toggle is not
 * a sweep.
 */
async function fetchNewMessages(chatId, storedCursor, clientOptions) {
  const direction = storedCursor ? 'after' : 'before';
  const maxPages = storedCursor ? MAX_MESSAGE_PAGES_PER_CHAT : 1;
  const messages = [];
  let cursor = storedCursor || undefined;
  let anchorCursor = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    // eslint-disable-next-line no-await-in-loop -- cursor pagination is inherently sequential
    const page = await listMessagesPage(chatId, { cursor, direction, ...clientOptions });
    assertPagedShape(page, `/v1/chats/{chatID}/messages`);
    messages.push(...page.items);
    if (page.newestCursor) anchorCursor = page.newestCursor;
    if (!page.hasMore) break;
    const nextCursor = direction === 'after' ? page.newestCursor : page.oldestCursor;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return { messages, cursor: anchorCursor };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Refresh `beeper_accounts` from the live roster. `getJoinedAccounts` joins
 * `/v1/accounts` to `/v1/bridges` by `accountID` (never by `network` — that
 * join returns zero rows) so the status card's `status`/`bridge_id` columns
 * are populated with Beeper Desktop closed. `loginID` never reaches here.
 */
async function refreshAccounts(clientOptions) {
  const accounts = (await getJoinedAccounts(clientOptions)).map(normalizeAccountRow)
    .filter((account) => account.accountId);
  for (const account of accounts) {
    // eslint-disable-next-line no-await-in-loop -- one roster, a handful of rows
    await query(
      `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (account_id) DO UPDATE SET network = EXCLUDED.network,
         display_name = EXCLUDED.display_name, status = EXCLUDED.status,
         bridge_id = EXCLUDED.bridge_id, last_seen_at = NOW(), updated_at = NOW()`,
      [account.accountId, account.network, account.displayName, account.status, account.bridgeId],
    );
  }
  return accounts;
}

/**
 * Upsert the conversation row and return its synthetic UUID. Committed on its
 * own, BEFORE the message transaction, for two reasons: the participant writer
 * (`beeperTribe.upsertParticipant`) runs on the pool and cannot see an
 * uncommitted row, and a conversation row carries no cursor, so re-running it
 * is free. The watermark lives in `beeper_sync_cursors`, never here.
 */
async function upsertConversation(chat) {
  const result = await query(
    `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type, is_group,
       is_pinned, is_archived, is_low_priority, is_muted, last_activity, unread_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (account_id, source_chat_id) DO UPDATE SET network = EXCLUDED.network,
       title = EXCLUDED.title, type = EXCLUDED.type, is_group = EXCLUDED.is_group,
       is_pinned = EXCLUDED.is_pinned, is_archived = EXCLUDED.is_archived,
       is_low_priority = EXCLUDED.is_low_priority, is_muted = EXCLUDED.is_muted,
       last_activity = COALESCE(EXCLUDED.last_activity, beeper_conversations.last_activity),
       unread_count = EXCLUDED.unread_count, updated_at = NOW()
     RETURNING id`,
    [
      chat.accountId, chat.network, chat.sourceChatId, chat.title, chat.type, chat.isGroup,
      chat.isPinned, chat.isArchived, chat.isLowPriority, chat.isMuted, chat.lastActivity, chat.unreadCount,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Message rows, attachment references and the cursor row — the one atomic
 * unit. Attachments are written after their message inside the SAME
 * transaction because `beeper_attachments.message_id` is a foreign key onto a
 * row this transaction is itself creating.
 *
 * Three COALESCE guards make a re-observation non-destructive, which matters
 * because an unsend arrives as a normal message with its text stripped:
 * `body` never regresses to empty, `unsent_at` never un-tombstones, and
 * `edited_at` never clears. #7's rule is that a body is never discarded
 * automatically, so the archive keeps the caption even after the source
 * forgets it.
 */
async function commitMessages({ conversationId, accountId, sourceChatId, rows, cursor, lastActivity }) {
  return withTransaction(async (client) => {
    for (const { message, attachments } of rows) {
      // eslint-disable-next-line no-await-in-loop -- ordered writes inside one transaction
      await client.query(
        `INSERT INTO beeper_messages (id, conversation_id, sender_id, body, sent_at, edited_at, unsent_at, sort_key, is_sender)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           body = COALESCE(NULLIF(EXCLUDED.body, ''), beeper_messages.body),
           sender_id = COALESCE(NULLIF(EXCLUDED.sender_id, ''), beeper_messages.sender_id),
           sent_at = COALESCE(EXCLUDED.sent_at, beeper_messages.sent_at),
           edited_at = COALESCE(EXCLUDED.edited_at, beeper_messages.edited_at),
           unsent_at = COALESCE(beeper_messages.unsent_at, EXCLUDED.unsent_at),
           sort_key = COALESCE(NULLIF(EXCLUDED.sort_key, ''), beeper_messages.sort_key),
           -- Never downgrades a stored TRUE to FALSE: the field is optional on
           -- the inbound Message, so a later page that omits it must not flip a
           -- message the user actually sent onto the other side of the thread.
           is_sender = beeper_messages.is_sender OR EXCLUDED.is_sender,
           updated_at = NOW()`,
        [
          message.id, conversationId, message.senderId, message.body,
          message.sentAt, message.editedAt, message.unsentAt, message.sortKey,
          message.isSender,
        ],
      );
      for (const attachment of attachments) {
        // eslint-disable-next-line no-await-in-loop -- same transaction, ordered after its message
        await client.query(
          `INSERT INTO beeper_attachments (conversation_id, message_id, idx, mxc_id, mime_type,
             byte_length, file_name, width, height)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (conversation_id, message_id, idx) DO UPDATE SET
             mxc_id = COALESCE(EXCLUDED.mxc_id, beeper_attachments.mxc_id),
             mime_type = EXCLUDED.mime_type, byte_length = EXCLUDED.byte_length,
             file_name = EXCLUDED.file_name, width = EXCLUDED.width, height = EXCLUDED.height,
             updated_at = NOW()`,
          [
            conversationId, message.id, attachment.idx, attachment.mxcId, attachment.mimeType,
            attachment.byteLength, attachment.fileName, attachment.width, attachment.height,
          ],
        );
      }
    }

    // The cursor moves LAST and only inside this transaction, so a failure
    // anywhere above rolls it back with the rows it was going to describe.
    await client.query(
      `INSERT INTO beeper_sync_cursors (account_id, chat_id, cursor, last_activity, last_swept_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (account_id, chat_id) DO UPDATE SET
         cursor = COALESCE(EXCLUDED.cursor, beeper_sync_cursors.cursor),
         last_activity = COALESCE(EXCLUDED.last_activity, beeper_sync_cursors.last_activity),
         last_swept_at = NOW()`,
      [accountId, sourceChatId, cursor, lastActivity],
    );
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

async function sweepChat({ chat, stored, clientOptions, observedAt }) {
  const normalized = normalizeChatRow(chat);
  if (!normalized.accountId || !normalized.sourceChatId) return { messages: 0 };

  const conversationId = await upsertConversation(normalized);
  if (!conversationId) return { messages: 0 };

  const { messages, cursor } = await fetchNewMessages(
    normalized.sourceChatId, stored?.cursor, clientOptions,
  );

  // Roster first, then senders: a message-sender observation carries a richer
  // handle than a truncated roster entry, and `upsertParticipant` COALESCEs
  // the handle rather than overwriting it, so the better one wins either way.
  for (const participant of normalizeParticipants(chat)) {
    // eslint-disable-next-line no-await-in-loop -- at most 20 per chat (the list endpoint truncates there)
    await upsertParticipant({ conversationId, ...participant, observedVia: 'participant-list' });
  }

  const rows = messages
    .map((message) => ({ message: normalizeMessageRow(message, observedAt), raw: message }))
    .filter(({ message }) => message.id)
    .map(({ message, raw }) => ({ message, raw, attachments: normalizeAttachmentRows(raw) }));

  const seenSenders = new Set();
  for (const { message, raw } of rows) {
    if (!message.senderId || seenSenders.has(message.senderId)) continue;
    seenSenders.add(message.senderId);
    // eslint-disable-next-line no-await-in-loop -- one row per distinct sender in this window
    await upsertParticipant({
      conversationId,
      sourceUserId: message.senderId,
      displayName: String(raw?.senderName ?? ''),
      handle: '',
      observedVia: 'message-sender',
    });
  }

  // Touchpoints are derived from message SENDERS only, never from the
  // participant roster (which truncates, so iterating it would invent contact
  // with people who never messaged). Written BEFORE the commit deliberately:
  // they are day-deduped on `beeper:<YYYY-MM-DD>`, so a rolled-back sweep
  // re-derives exactly the same ones next pass, whereas writing them after the
  // cursor advanced would lose them for good.
  await logSenderTouchpoints(rows
    .filter(({ raw }) => raw?.isSender !== true)
    .map(({ message }) => ({
      conversationId,
      senderId: message.senderId,
      sentAt: message.sentAt,
      network: normalized.network,
    })));

  await commitMessages({
    conversationId,
    accountId: normalized.accountId,
    sourceChatId: normalized.sourceChatId,
    rows,
    cursor: cursor || stored?.cursor || null,
    lastActivity: normalized.lastActivity,
  });

  return { messages: rows.length };
}

async function sweepAccount(account, clientOptions, observedAt) {
  const cursors = await readAccountCursors(account.accountId);
  let cursor;
  let chatsSwept = 0;
  let messagesWritten = 0;
  let reachedWatermark = false;

  for (let pageIndex = 0; pageIndex < MAX_CHAT_PAGES_PER_ACCOUNT && !reachedWatermark; pageIndex++) {
    // eslint-disable-next-line no-await-in-loop -- cursor pagination is inherently sequential
    const page = await listChatsPage({
      cursor, direction: 'before', accountIDs: [account.accountId], ...clientOptions,
    });
    assertPagedShape(page, '/v1/chats');

    for (const chat of page.items) {
      const stored = cursors.get(String(chat?.id ?? ''));
      if (!chatNeedsSweep(chat, stored)) {
        // The list is ordered by last activity, so the first chat that is not
        // newer than its watermark ends the walk for this account.
        reachedWatermark = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- one chat at a time; each is its own transaction
      const result = await sweepChat({ chat, stored, clientOptions, observedAt });
      chatsSwept++;
      messagesWritten += result.messages;
    }

    if (reachedWatermark || !page.hasMore) break;
    if (!page.oldestCursor || page.oldestCursor === cursor) break;
    cursor = page.oldestCursor;
  }

  return { chatsSwept, messagesWritten };
}

// A per-run re-entrancy guard: one sweep at a time, process-wide. The timer,
// the manual run-now route and #33's three socket triggers (reconnect, `seq`
// gap, `app.state` recovery) all land here, and two overlapping sweeps would
// page the same chats twice and race on the same cursor rows. A caller that
// arrives mid-sweep is told so rather than queued — the in-flight sweep is
// already fetching everything the newcomer would have.
let inFlightSweep = null;

async function executeSweep(reason) {
  const clientOptions = await resolveBeeperConfig();
  if (!clientOptions.token) {
    throw new BeeperApiError('Beeper access token is not configured', {
      status: 401, code: 'NOT_CONFIGURED', retryable: false,
    });
  }

  const startedAt = Date.now();
  const observedAt = new Date(startedAt).toISOString();
  const accounts = await refreshAccounts(clientOptions);

  let chats = 0;
  let messages = 0;
  let failedAccounts = 0;
  for (const account of accounts) {
    // eslint-disable-next-line no-await-in-loop -- accounts are swept in order; each owns its own cursors
    const result = await sweepAccount(account, clientOptions, observedAt).catch((err) => {
      failedAccounts++;
      console.error(`❌ ${LOG_PREFIX}: account ${account.accountId} failed: ${err.message}`);
      return null;
    });
    if (!result) continue;
    chats += result.chatsSwept;
    messages += result.messagesWritten;
  }

  const durationMs = Date.now() - startedAt;
  console.log(`${LOG_PREFIX} (${reason}): ${accounts.length} accounts, ${chats} chats, ${messages} messages in ${durationMs}ms`);
  return {
    skipped: false, reason, accounts: accounts.length, chats, messages, failedAccounts, durationMs,
  };
}

/**
 * Run one watermark-bounded sweep. Exported for the scheduler, the manual
 * run-now route, and #33's three socket triggers.
 *
 * Throws only when the sweep cannot start at all (no token, roster
 * unreachable); a single account failing is isolated and reported as
 * `failedAccounts` so one broken bridge cannot cost the others their pass.
 */
export async function runBeeperSweep({ reason = 'scheduler' } = {}) {
  if (inFlightSweep) {
    console.log(`${LOG_PREFIX} (${reason}): a sweep is already running — skipping`);
    return { skipped: true, reason, accounts: 0, chats: 0, messages: 0, failedAccounts: 0, durationMs: 0 };
  }
  const run = executeSweep(reason);
  inFlightSweep = run;
  try {
    return await run;
  } finally {
    inFlightSweep = null;
  }
}
