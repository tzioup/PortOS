/**
 * Beeper outbound outbox (fork issue #36, decided on #8, confirmation
 * transport decided on #12).
 *
 * PortOS's send posture is upstream's tier 2 — draft → human approve → human
 * send, through ONE service whose only non-test caller is a human HTTP route
 * (`server/routes/beeper.js`). `messageSender.sendDraft` is the shape this
 * reuses: the `status === 'approved'` gate, the mismatch gate, and the
 * one-human-caller rule. What it deliberately does NOT reuse is that service's
 * FILE-BACKED draft store — the `beeper_*` tables are `db-primary`, and #8
 * rejected straddling two storage classifications. Hence a Beeper-native
 * `beeper_outbox` row.
 *
 * Four rules this module exists to enforce:
 *
 *  1. **The row is written before the POST.** Intent survives a crash between
 *     the click and the send, and the row is the one serialization point per
 *     entry — the `approved → sending` transition is a conditional UPDATE, so
 *     a double-click cannot double-post.
 *  2. **A send is NEVER retried automatically.** Beeper has no idempotency key
 *     on `POST /v1/chats/{chatID}/messages`, so a retry delivers a second real
 *     message to a real person. A transport failure leaves exactly one row in
 *     `failed`, with the code and message, and no second POST. Re-sending is a
 *     NEW row, created by a new human action; the failed one stays visible.
 *  3. **Confirmation is a resolve, never a re-send.** The send is asynchronous
 *     and answers only `{ chatID, pendingMessageID }`. The row confirms on the
 *     `message.upserted` invalidation relayed by #33, with a 30-second fallback
 *     to `GET /v1/chats/{chatID}/messages/{messageID}` — WebSocket delivery is
 *     at-most-once with no replay, so the socket cannot be the only path.
 *     Neither path sends anything.
 *  4. **A runaway breaker, not a rate quota.** Every send is one human click,
 *     so a quota paces a human who is already paced. The breaker catches the
 *     failure this design cannot otherwise see — a software loop — and only a
 *     human clears it.
 *
 * No AI drafting and no AI review (#8 decision 8), and no agent reach: no
 * `cosToolRegistry` entry, no voice tool, no scheduler. `beeperOutboxHumanGate.test.js`
 * asserts that structurally rather than by convention.
 */

import { query } from '../lib/db.js';
import { BeeperApiError, getMessage, listMessagesPage, sendMessage } from './beeperClient.js';
import { normalizeMessageRow } from './beeperSync.js';
import { beeperSocketEvents } from './beeperSocketEvents.js';

const LOG_PREFIX = '🫧 Beeper outbox';

/**
 * The socket is the fast path; this is the floor under it. 30 s is #12's
 * decision: long enough that a healthy `message.upserted` almost always wins
 * the race (so the fallback GET is rare rather than routine), short enough
 * that a dropped frame does not leave a send unresolved on screen.
 */
export const CONFIRMATION_TIMEOUT_MS = 30_000;

/**
 * Runaway-breaker thresholds. Deliberately far above anything a human at a
 * composer produces and far below what an unattended loop produces in the same
 * minute: eleven sends inside a minute is one every 5.5 seconds, sustained,
 * which is a fault rather than a conversation. The consecutive-failure arm
 * catches the other loop shape — a caller that keeps firing at a Beeper that
 * keeps refusing.
 */
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_MAX_SENDS_IN_WINDOW = 10;
export const BREAKER_MAX_CONSECUTIVE_FAILURES = 3;

const DEFAULT_RUNTIME = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

let runtime = { ...DEFAULT_RUNTIME };

// Breaker + confirmation state is in-memory ON PURPOSE. The failure it defends
// against is a live in-process loop, so process-lifetime scope is the right
// scope: a restart clears it, and a loop that survived the restart re-trips it
// within the same window. Persisting it would instead let one bad minute wedge
// the composer across restarts with no way back except the same human click.
let sendTimestamps = [];
let consecutiveFailures = 0;
let breaker = { tripped: false, reason: null, trippedAt: null };

// outboxId → { chatId, body, pendingMessageId, requestedAt, timer, resolving }
const pendingConfirmations = new Map();
let invalidateListenerAttached = false;

/** Test seam for injected time (mirrors `beeperSocket.js`'s runtime object). */
export function configureOutboxRuntime(overrides = {}) {
  runtime = { ...DEFAULT_RUNTIME, ...overrides };
}

export function resetOutboxRuntime() {
  runtime = { ...DEFAULT_RUNTIME };
}

// ---------------------------------------------------------------------------
// Runaway breaker
// ---------------------------------------------------------------------------

function trip(reason) {
  breaker = { tripped: true, reason, trippedAt: new Date(runtime.now()).toISOString() };
  console.error(`${LOG_PREFIX}: runaway breaker tripped (${reason}) — sends blocked until a human clears it`);
}

/**
 * The breaker's read model, surfaced on `GET /api/beeper/status`. `tripped` is
 * the gate; the two counters ride along so the card can say WHY rather than
 * just that something is blocked.
 */
export function getOutboxBreakerState() {
  const cutoff = runtime.now() - BREAKER_WINDOW_MS;
  return {
    tripped: breaker.tripped,
    reason: breaker.reason,
    trippedAt: breaker.trippedAt,
    sendsInWindow: sendTimestamps.filter((ts) => ts > cutoff).length,
    consecutiveFailures,
    windowMs: BREAKER_WINDOW_MS,
    maxSendsInWindow: BREAKER_MAX_SENDS_IN_WINDOW,
    maxConsecutiveFailures: BREAKER_MAX_CONSECUTIVE_FAILURES,
  };
}

/**
 * The ONLY way back. Reachable exclusively from `POST /api/beeper/outbox/breaker/clear`
 * — no timer, no backoff, no automatic recovery: a breaker that resets itself
 * is a delay, not a breaker.
 */
export function clearOutboxBreaker() {
  breaker = { tripped: false, reason: null, trippedAt: null };
  sendTimestamps = [];
  consecutiveFailures = 0;
  console.log(`${LOG_PREFIX}: runaway breaker cleared by a human action`);
  return getOutboxBreakerState();
}

function assertBreakerClosed() {
  if (!breaker.tripped) return;
  throw new BeeperApiError(
    `Beeper sending is blocked by the runaway breaker (${breaker.reason}). Clear it to send again.`,
    { status: 429, code: 'OUTBOX_BREAKER_OPEN', retryable: false },
  );
}

/**
 * Count this attempt against the window BEFORE the POST, and refuse the one
 * that crosses the line. Counting after the POST would let the loop's own
 * first burst through before the breaker ever saw it.
 */
function registerSendAttempt() {
  const now = runtime.now();
  sendTimestamps = sendTimestamps.filter((ts) => ts > now - BREAKER_WINDOW_MS);
  sendTimestamps.push(now);
  if (sendTimestamps.length > BREAKER_MAX_SENDS_IN_WINDOW) {
    trip(`more than ${BREAKER_MAX_SENDS_IN_WINDOW} sends in ${BREAKER_WINDOW_MS / 1000}s`);
    assertBreakerClosed();
  }
}

function registerSendFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_MAX_CONSECUTIVE_FAILURES) {
    trip(`${consecutiveFailures} consecutive send failures`);
  }
}

function registerSendSuccess() {
  consecutiveFailures = 0;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ENTRY_COLUMNS = `id, conversation_id AS "conversationId", chat_id AS "chatId", body, state,
  pending_message_id AS "pendingMessageId", message_id AS "messageId",
  error_code AS "errorCode", error_message AS "errorMessage",
  created_at AS "createdAt", approved_at AS "approvedAt", sent_at AS "sentAt"`;

async function readEntry(id) {
  const result = await query(`SELECT ${ENTRY_COLUMNS} FROM beeper_outbox WHERE id = $1`, [id]);
  return result?.rows?.[0] ?? null;
}

/** Every outbox row for one conversation, newest first — including failed ones. */
export async function listOutboxEntries({ conversationId, limit = 50 } = {}) {
  const result = await query(
    `SELECT ${ENTRY_COLUMNS} FROM beeper_outbox
     WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [conversationId, Math.min(200, Math.max(1, Math.trunc(limit) || 50))],
  );
  return Array.isArray(result?.rows) ? result.rows : [];
}

/**
 * Step one of the two-step send: a human composed this text and submitted it.
 * The row lands `approved` (with `approved_at` stamped) because the create call
 * itself IS the approval — it is reachable only from a human HTTP route, and
 * the send is a second, separate human action against the row this returns.
 * `draft` exists in the state CHECK for a later persisted/AI-assisted draft and
 * has no writer here; the send gate keys on `approved`, so nothing can send
 * from it.
 */
export async function createOutboxEntry({ conversationId, body }) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) {
    throw new BeeperApiError('An outbox entry needs a non-empty message body', {
      status: 400, code: 'OUTBOX_EMPTY_BODY', retryable: false,
    });
  }

  const conversation = await query(
    'SELECT id, source_chat_id AS "sourceChatId" FROM beeper_conversations WHERE id = $1',
    [conversationId],
  );
  const chatId = conversation?.rows?.[0]?.sourceChatId;
  if (!chatId) {
    throw new BeeperApiError('Conversation not found in the Beeper mirror', {
      status: 404, code: 'CONVERSATION_NOT_FOUND', retryable: false,
    });
  }

  const inserted = await query(
    `INSERT INTO beeper_outbox (conversation_id, chat_id, body, state, approved_at)
     VALUES ($1, $2, $3, 'approved', NOW())
     RETURNING ${ENTRY_COLUMNS}`,
    [conversationId, chatId, text],
  );
  console.log(`${LOG_PREFIX}: entry approved for chat (${text.length} chars)`);
  return inserted.rows[0];
}

/**
 * Whether PortOS has ever COMPLETED a send to this conversation. First contact
 * is the case #8 decision 5 puts a confirmation on — a first message to a
 * possibly mis-resolved handle on a possibly wrong network — and it is the only
 * one, because confirming every reply trains the user to click through.
 *
 * Keyed on the outbox rather than on a mirrored `isSender` message: the mirror
 * records what the USER sent from their phone, which is not evidence that this
 * PortOS install has ever addressed the conversation correctly.
 */
export async function isFirstContact(conversationId) {
  const result = await query(
    "SELECT 1 FROM beeper_outbox WHERE conversation_id = $1 AND state = 'sent' LIMIT 1",
    [conversationId],
  );
  return (result?.rows?.length ?? 0) === 0;
}

async function markFailed(id, code, message) {
  await query(
    `UPDATE beeper_outbox SET state = 'failed', error_code = $2, error_message = $3, updated_at = NOW()
     WHERE id = $1`,
    [id, code || 'SEND_FAILED', String(message || '').slice(0, 2000)],
  );
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Step two: perform the send. Every gate below runs BEFORE the row is claimed,
 * so a refused send leaves the row exactly as it was and re-sendable by the
 * same human action.
 *
 * `confirmFirstContact` must be explicitly `true` on the first outbound message
 * to a conversation. The client obtains it from an inline confirmation row, not
 * a `window.confirm` (client conventions forbid the latter).
 */
export async function sendOutboxEntry(id, { confirmFirstContact = false } = {}) {
  const entry = await readEntry(id);
  if (!entry) {
    throw new BeeperApiError('Outbox entry not found', {
      status: 404, code: 'OUTBOX_ENTRY_NOT_FOUND', retryable: false,
    });
  }
  if (entry.state !== 'approved') {
    throw new BeeperApiError(
      `Outbox entry is "${entry.state}", must be "approved" to send. A failed or already-sent entry is never re-sent in place — compose a new message.`,
      { status: 409, code: 'OUTBOX_INVALID_STATE', retryable: false },
    );
  }
  assertBreakerClosed();
  if (!confirmFirstContact && await isFirstContact(entry.conversationId)) {
    throw new BeeperApiError(
      'This is the first message PortOS has ever sent to this conversation — confirm the recipient and network before sending.',
      { status: 409, code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED', retryable: false },
    );
  }
  registerSendAttempt();

  // The serialization point. A second concurrent send of the same row loses
  // this conditional UPDATE and never reaches the POST.
  const claimed = await query(
    "UPDATE beeper_outbox SET state = 'sending', updated_at = NOW() WHERE id = $1 AND state = 'approved' RETURNING id",
    [id],
  );
  if ((claimed?.rowCount ?? 0) !== 1) {
    throw new BeeperApiError('Outbox entry is already being sent', {
      status: 409, code: 'OUTBOX_INVALID_STATE', retryable: false,
    });
  }

  // Retry is OFF (the client's send-safe default): no idempotency key means a
  // retried POST is a second real message. One attempt, one row, no second POST.
  const result = await sendMessage(entry.chatId, { text: entry.body })
    .then((value) => ({ ok: true, value }))
    .catch((err) => ({ ok: false, err }));

  if (!result.ok) {
    const err = result.err;
    await markFailed(id, err?.code, err?.message);
    registerSendFailure();
    console.error(`${LOG_PREFIX}: send failed (${err?.code || 'SEND_FAILED'})`);
    throw new BeeperApiError(err?.message || 'Beeper send failed', {
      status: err?.status === 0 || !err?.status ? 0 : err.status,
      code: err?.code || 'SEND_FAILED',
      retryable: false,
      details: { outboxId: id },
    });
  }

  registerSendSuccess();
  const pendingMessageId = typeof result.value?.pendingMessageID === 'string' ? result.value.pendingMessageID : null;
  const updated = await query(
    `UPDATE beeper_outbox SET state = 'awaiting-confirmation', pending_message_id = $2,
       error_code = NULL, error_message = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING ${ENTRY_COLUMNS}`,
    [id, pendingMessageId],
  );
  console.log(`${LOG_PREFIX}: sent, awaiting confirmation${pendingMessageId ? '' : ' (no pending id returned)'}`);
  armConfirmation({ id, chatId: entry.chatId, conversationId: entry.conversationId, body: entry.body, pendingMessageId });
  return updated.rows[0];
}

// ---------------------------------------------------------------------------
// Confirmation (socket first, 30s GET fallback)
// ---------------------------------------------------------------------------

function detachInvalidateListener() {
  if (!invalidateListenerAttached || pendingConfirmations.size > 0) return;
  beeperSocketEvents.off('invalidate', handleInvalidation);
  invalidateListenerAttached = false;
}

/**
 * Relayed invalidation frames carry ids and kinds only — never bodies — so a
 * frame is a PROMPT to resolve, not the resolution. Any `message.upserted` on a
 * chat with a send in flight triggers the same lookup the timer would have run,
 * just sooner.
 *
 * Runs outside the Express lifecycle (an EventEmitter callback), so the
 * rejection is caught and logged here rather than crashing the process.
 */
function handleInvalidation(frame) {
  if (frame?.kind !== 'message.upserted') return;
  for (const [id, pending] of pendingConfirmations) {
    if (frame.chatID && frame.chatID !== pending.chatId) continue;
    resolveConfirmation(id, 'socket').catch((err) => {
      console.error(`${LOG_PREFIX}: socket-triggered confirmation failed: ${err.message}`);
    });
  }
}

function armConfirmation({ id, chatId, conversationId, body, pendingMessageId }) {
  const timer = runtime.setTimeout(() => {
    resolveConfirmation(id, 'fallback-timeout').catch((err) => {
      console.error(`${LOG_PREFIX}: fallback confirmation failed: ${err.message}`);
    });
  }, CONFIRMATION_TIMEOUT_MS);
  pendingConfirmations.set(id, {
    chatId, conversationId, body, pendingMessageId, requestedAt: runtime.now(), timer, resolving: false,
  });
  if (!invalidateListenerAttached) {
    beeperSocketEvents.on('invalidate', handleInvalidation);
    invalidateListenerAttached = true;
  }
}

/**
 * Find the message this send became. Two lookups, in order, and NEITHER sends:
 *
 *  1. `GET /v1/chats/{chatID}/messages/{messageID}` with the `pendingMessageID`
 *     — the spec states that endpoint accepts a pending id, a final id, or a
 *     Matrix event id, which is exactly what makes the resolve step work.
 *  2. Failing that (no pending id came back, or the id 404s because the network
 *     assigned a final one), the chat's newest page, matched on
 *     `isSender` + the exact body + a timestamp at or after the send. The body
 *     match is deliberately exact: a near-match is a different message.
 */
async function lookupSentMessage(pending) {
  if (pending.pendingMessageId) {
    const direct = await getMessage(pending.chatId, pending.pendingMessageId)
      .then((value) => value)
      .catch((err) => {
        if (err?.code === 'NOT_FOUND') return null;
        throw err;
      });
    if (direct?.id) return direct;
  }

  const page = await listMessagesPage(pending.chatId);
  const items = Array.isArray(page?.items) ? page.items : [];
  // A minute of slack below the send: `timestamp` is assigned by the network,
  // not by PortOS, and the two clocks are not the same clock.
  const floor = pending.requestedAt - 60_000;
  return items.find((message) => message?.isSender === true
    && message?.text === pending.body
    && (!message?.timestamp || new Date(message.timestamp).getTime() >= floor)) ?? null;
}

/**
 * Mirror the confirmed message so the thread shows it without waiting for the
 * next sweep. `normalizeMessageRow` is beeperSync's own normalizer, reused so
 * an outbound row is shaped exactly like an ingested one; the upsert carries
 * the same non-destructive COALESCE guards as the sweep's, and the sweep's
 * later re-observation of the same id updates rather than duplicates it.
 */
async function mirrorSentMessage(conversationId, message) {
  const row = normalizeMessageRow(message, new Date(runtime.now()).toISOString());
  if (!row.id) return;
  await query(
    `INSERT INTO beeper_messages (id, conversation_id, sender_id, body, sent_at, edited_at, unsent_at, sort_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       body = COALESCE(NULLIF(EXCLUDED.body, ''), beeper_messages.body),
       sender_id = COALESCE(NULLIF(EXCLUDED.sender_id, ''), beeper_messages.sender_id),
       sent_at = COALESCE(EXCLUDED.sent_at, beeper_messages.sent_at),
       edited_at = COALESCE(EXCLUDED.edited_at, beeper_messages.edited_at),
       unsent_at = COALESCE(beeper_messages.unsent_at, EXCLUDED.unsent_at),
       sort_key = COALESCE(NULLIF(EXCLUDED.sort_key, ''), beeper_messages.sort_key),
       updated_at = NOW()`,
    [row.id, conversationId, row.senderId, row.body, row.sentAt, row.editedAt, row.unsentAt, row.sortKey],
  );
}

function releasePending(id) {
  const pending = pendingConfirmations.get(id);
  if (pending?.timer !== undefined) runtime.clearTimeout(pending.timer);
  pendingConfirmations.delete(id);
  detachInvalidateListener();
}

/**
 * Resolve one in-flight send. Idempotent by construction: the `resolving` flag
 * stops the socket path and the timer path overlapping, and the terminal UPDATE
 * is conditional on `awaiting-confirmation`, so whichever path lands first is
 * the one that writes.
 *
 * The unresolved case is deliberately NOT `failed`. A send whose message cannot
 * be found may well have been delivered, and marking it failed invites a
 * re-send — the one mistake that cannot be taken back, since Beeper's own
 * `DELETE` unsends for everyone. It stays `awaiting-confirmation` with a
 * recorded reason, which reads as "sent, unconfirmed" and offers no re-send.
 */
async function resolveConfirmation(id, reason) {
  const pending = pendingConfirmations.get(id);
  if (!pending || pending.resolving) return null;
  pending.resolving = true;

  const found = await lookupSentMessage(pending)
    .then((value) => ({ ok: true, value }))
    .catch((err) => ({ ok: false, err }));
  pending.resolving = false;

  if (!found.ok) {
    // A lookup failure on the socket path costs nothing — the timer is still
    // armed. On the fallback path it is the end of the road.
    console.error(`${LOG_PREFIX}: confirmation lookup failed (${found.err?.code || 'unknown'})`);
    if (reason === 'fallback-timeout') {
      await noteUnresolved(id, `Confirmation lookup failed: ${found.err?.code || 'unknown error'}`);
    }
    return null;
  }

  const message = found.value;
  if (!message) {
    if (reason === 'fallback-timeout') {
      await noteUnresolved(id, 'Beeper reported no matching message within 30s — it may still have been delivered, so it was not re-sent.');
    }
    return null;
  }

  const status = typeof message?.sendStatus?.status === 'string' ? message.sendStatus.status : null;
  if (status && status.startsWith('FAIL')) {
    releasePending(id);
    await markFailed(id, `SEND_${status}`, message?.sendStatus?.message || message?.sendStatus?.reason || 'Beeper reported a failed send');
    console.error(`${LOG_PREFIX}: Beeper reported ${status} for a sent message`);
    return null;
  }

  const settled = await query(
    `UPDATE beeper_outbox SET state = 'sent', message_id = $2, sent_at = COALESCE($3::timestamptz, NOW()),
       error_code = NULL, error_message = NULL, updated_at = NOW()
     WHERE id = $1 AND state = 'awaiting-confirmation' RETURNING ${ENTRY_COLUMNS}`,
    [id, String(message.id), message?.timestamp ?? null],
  );
  releasePending(id);
  if ((settled?.rowCount ?? 0) !== 1) return null;

  await mirrorSentMessage(pending.conversationId, message);
  // Ids and kinds only, on the same relay #33 already forwards to subscribed
  // browsers — never the body, which stays on this machine.
  beeperSocketEvents.emit('invalidate', {
    kind: 'message.upserted',
    chatID: pending.chatId,
    ids: [String(message.id)],
    seq: null,
    ts: new Date(runtime.now()).toISOString(),
  });
  console.log(`${LOG_PREFIX}: send confirmed via ${reason}`);
  return settled.rows[0];
}

/** Record why a send is unconfirmed without moving it out of flight. */
async function noteUnresolved(id, message) {
  releasePending(id);
  await query(
    `UPDATE beeper_outbox SET error_code = 'CONFIRMATION_UNRESOLVED', error_message = $2, updated_at = NOW()
     WHERE id = $1 AND state = 'awaiting-confirmation'`,
    [id, message],
  );
  console.warn(`${LOG_PREFIX}: send unconfirmed after ${CONFIRMATION_TIMEOUT_MS / 1000}s — left in flight, never re-sent`);
}

/**
 * Drop every armed confirmation timer. Used by the suite between cases; there
 * is no production caller, because a process that is exiting takes its timers
 * with it and the durable state is the row, not the timer.
 */
export function cancelPendingConfirmations() {
  for (const id of [...pendingConfirmations.keys()]) releasePending(id);
}

/** The outbox's slice of `GET /api/beeper/status`. */
export function getOutboxStatus() {
  return {
    breaker: getOutboxBreakerState(),
    awaitingConfirmation: pendingConfirmations.size,
  };
}
