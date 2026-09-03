/**
 * Beeper ↔ Tribe identity linking (#34, decided on #10, built on the schema
 * from #27/PR42). Relates a `beeper_participants` row to a `tribe_people`
 * row via the split-by-durability design:
 *
 *   - A durable handle (a phone, ~81% of one-to-one counterparties, or a
 *     network username, ~6%) resolves through `tribe_identities` — see
 *     `server/services/tribeIdentities.js` — PLUS, for a phone specifically,
 *     the existing Tribe phone matcher (`tribeMatch.js`/`tribe.listPeople()`),
 *     since a WhatsApp/Signal/Google-Messages phone is very plausibly already
 *     on a Tribe person from calendar/iMessage/Contacts. Resolution never
 *     creates a person — only matches an existing one — so the auto path can
 *     never produce a duplicate.
 *   - No durable handle at all (~13%) has nothing to resolve against;
 *     `beeper_participants.tribe_person_id` is then the sole, hand-set truth
 *     (`linkParticipant` / `createPersonAndLinkParticipant`).
 *
 * `upsertParticipant` is the participant-row writer a future ingestion sweep
 * (#32) will call on every sync pass — its ON CONFLICT clause deliberately
 * never touches `tribe_person_id`, so a manual link on the 13%-no-handle case
 * survives every re-sync (#34 acceptance).
 *
 * Touchpoints: `logSenderTouchpoints` relates a GROUP conversation by message
 * SENDER only — Beeper's participant roster truncates (20/100, no cursor) so
 * it is never a complete membership list; iterating it to log touchpoints for
 * everyone "in" a group would silently invent contact with people who never
 * actually messaged. A message's `senderID` is always a real, present
 * participant, so deriving touchpoints from messages (never from the roster)
 * is correct for a 1:1 chat too, not just a group.
 */
import { ensureSchema, query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { classifyNetworkHandle, buildPersonMatchIndex, matchPerson } from '../lib/tribeMatch.js';
import * as tribe from './tribe.js';
import * as tribeIdentities from './tribeIdentities.js';

async function ensureReady() {
  await ensureSchema();
}

function rowToParticipant(row) {
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    sourceUserId: row.source_user_id,
    displayName: row.display_name || '',
    handle: row.handle || '',
    // Deliberately NULLed when the cached link points at a soft-deleted Tribe
    // person (`tp.deleted`, joined below) — `tribe.deletePerson` never fires
    // the FK's ON DELETE CASCADE (it's a soft delete), so the raw column can
    // point at a person who no longer counts as one. Callers (below, and
    // upsertParticipant's "still empty" check) then correctly treat this
    // participant as unlinked rather than resolving onto a deleted person.
    tribePersonId: (row.tribe_person_id && !row.tribe_person_deleted) ? row.tribe_person_id : null,
    // The Beeper NETWORK this participant's conversation belongs to — joined
    // from beeper_conversations.network, never client-supplied (#34 review:
    // a caller-supplied network let a username-shaped handle be linked under
    // the wrong scope, or with none at all). Authoritative scope for a
    // kind='handle' tribe_identities claim.
    network: row.network || '',
    observedVia: row.observed_via,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

export async function getParticipant(conversationId, sourceUserId) {
  await ensureReady();
  const result = await query(
    `SELECT p.*, c.network, tp.deleted AS tribe_person_deleted
     FROM beeper_participants p
     JOIN beeper_conversations c ON c.id = p.conversation_id
     LEFT JOIN tribe_people tp ON tp.id = p.tribe_person_id
     WHERE p.conversation_id = $1 AND p.source_user_id = $2`,
    [conversationId, sourceUserId],
  );
  return rowToParticipant(result.rows[0]);
}

/**
 * Resolve a participant to a Tribe person WITHOUT writing anything. Never
 * creates a person. Order: the existing cache column first (respects a
 * prior manual link, including on the no-durable-handle 13% case where the
 * cache IS the truth, and is null'd out when it points at a soft-deleted
 * person — see `rowToParticipant`); then, when a handle is present,
 * `tribe_identities` — a user's OWN explicit Beeper link, which must win over
 * the legacy `tribe_people.phones[]` array below it, since otherwise a fresh
 * manual claim on a phone another person's legacy array already holds would
 * silently lose to that stale array on every future resolution; falling back,
 * for a phone specifically, to the existing Tribe phone matcher (a
 * WhatsApp/Signal counterpart's phone is plausibly already on a Tribe person
 * from iMessage/Contacts, with no Beeper-specific claim recorded yet).
 * Returns `null` when nothing matches.
 *
 * `personIndex` is an optional pre-built `buildPersonMatchIndex(...)` result
 * — pass one when resolving many participants in a batch (`logSenderTouchpoints`
 * below) so the phone fallback doesn't reload and reindex every Tribe person
 * once per participant.
 */
export async function resolveParticipantPerson({ conversationId, sourceUserId }, personIndex = null) {
  const participant = await getParticipant(conversationId, sourceUserId);
  if (!participant) return null;
  if (participant.tribePersonId) return participant.tribePersonId;
  if (!participant.handle) return null;

  const classified = classifyNetworkHandle(participant.handle);
  if (!classified) return null;

  const via = await tribeIdentities.resolvePersonByIdentity({
    kind: classified.kind,
    network: classified.kind === 'phone' ? '' : participant.network,
    handle: classified.handle,
  });
  if (via) return via;

  if (classified.kind === 'phone') {
    const index = personIndex || buildPersonMatchIndex(await tribe.listPeople());
    const viaTribePhone = matchPerson({ phone: classified.handle }, index);
    if (viaTribePhone) return viaTribePhone;
  }

  return null;
}

/**
 * Insert-or-refresh a participant row. The `ON CONFLICT` update list
 * deliberately EXCLUDES `tribe_person_id` — a re-sync must never clobber a
 * manual link (#34 acceptance: "a counterparty with no durable identifier
 * links by hand and survives a re-sync"). After the write, opportunistically
 * auto-resolves and fills the cache ONLY when it is still empty — never
 * overrides an existing link, manual or previously auto-resolved.
 */
export async function upsertParticipant({
  conversationId, sourceUserId, displayName = '', handle = '', observedVia,
}) {
  if (!conversationId || !sourceUserId) {
    throw new ServerError('conversationId and sourceUserId are required', { status: 400, code: 'BAD_REQUEST' });
  }
  if (observedVia !== 'participant-list' && observedVia !== 'message-sender') {
    throw new ServerError("observedVia must be 'participant-list' or 'message-sender'", { status: 400, code: 'BAD_REQUEST' });
  }
  await ensureReady();
  await query(
    `INSERT INTO beeper_participants (conversation_id, source_user_id, display_name, handle, observed_via)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (conversation_id, source_user_id)
     DO UPDATE SET display_name = EXCLUDED.display_name, handle = EXCLUDED.handle,
       observed_via = EXCLUDED.observed_via, updated_at = NOW()`,
    [conversationId, sourceUserId, displayName, handle, observedVia],
  ).catch((err) => {
    if (err?.code === '23503') throw new ServerError('Conversation not found', { status: 404 });
    throw err;
  });

  const participant = await getParticipant(conversationId, sourceUserId);
  if (!participant.tribePersonId && handle) {
    const resolved = await resolveParticipantPerson({ conversationId, sourceUserId });
    if (resolved) {
      await query(
        `UPDATE beeper_participants SET tribe_person_id = $3, updated_at = NOW()
         WHERE conversation_id = $1 AND source_user_id = $2 AND tribe_person_id IS NULL`,
        [conversationId, sourceUserId, resolved],
      );
      return getParticipant(conversationId, sourceUserId);
    }
  }
  return participant;
}

/**
 * Explicit link — the inline thread-participant action (#10 decision 4).
 * When the participant carries a durable handle, ALSO claims it in
 * `tribe_identities` so the next participant (in this or another
 * conversation) presenting the same handle auto-resolves without another
 * manual click. `network` is never accepted as an argument — a `kind='handle'`
 * claim is scoped to the participant's OWN conversation's
 * `beeper_conversations.network`, joined server-side by `getParticipant`,
 * never a caller-supplied value (#34 review — a client-supplied network let a
 * handle be linked under the wrong scope, or with none at all).
 *
 * Refuses to link a soft-deleted `personId` (`tribeIdentities.assertPersonLinkable`)
 * BEFORE the handle branch, so the no-durable-handle case — where
 * `linkIdentity` is never called — is covered too. Returns
 * `{ ...participant, displacedPersonId }`: when the handle was already
 * claimed by a DIFFERENT person, that person's id, so the ownership move
 * (silent at the DB/audit-trigger level — see `tribeIdentities.linkIdentity`)
 * is surfaced to the caller instead.
 */
export async function linkParticipant({
  conversationId, sourceUserId, personId, source = 'user',
}) {
  if (!personId) throw new ServerError('personId is required', { status: 400, code: 'BAD_REQUEST' });
  await ensureReady();
  await tribeIdentities.assertPersonLinkable(personId);
  const participant = await getParticipant(conversationId, sourceUserId);
  if (!participant) throw new ServerError('Participant not found', { status: 404 });

  let displacedPersonId = null;
  if (participant.handle) {
    const classified = classifyNetworkHandle(participant.handle);
    if (classified) {
      const identity = await tribeIdentities.linkIdentity({
        personId,
        kind: classified.kind,
        network: classified.kind === 'phone' ? '' : participant.network,
        handle: classified.handle,
        source,
      });
      displacedPersonId = identity.displacedPersonId;
    }
  }

  const result = await query(
    `UPDATE beeper_participants SET tribe_person_id = $3, updated_at = NOW()
     WHERE conversation_id = $1 AND source_user_id = $2
     RETURNING *`,
    [conversationId, sourceUserId, personId],
  ).catch((err) => {
    if (err?.code === '23503') throw new ServerError('Person not found', { status: 404 });
    throw err;
  });
  return { ...rowToParticipant(result.rows[0]), displacedPersonId };
}

/**
 * Create a new Tribe person from a participant's own display name and link
 * it — the other half of #10 decision 4 ("can also create a new Tribe
 * person"). Never invoked automatically; always an explicit user action. The
 * network named in `notes` (display only) is the participant's OWN
 * conversation's network, joined server-side — never caller-supplied.
 */
export async function createPersonAndLinkParticipant({
  conversationId, sourceUserId, name, ring = 'tribe', relationship = '', source = 'user',
}) {
  const participant = await getParticipant(conversationId, sourceUserId);
  if (!participant) throw new ServerError('Participant not found', { status: 404 });
  const personName = String(name || participant.displayName || '').trim();
  if (!personName) throw new ServerError('name is required', { status: 400, code: 'BAD_REQUEST' });

  const person = await tribe.createPerson({
    name: personName,
    ring,
    relationship,
    notes: `Imported from Beeper${participant.network ? ` (${participant.network})` : ''}`,
    channel: 'Beeper',
  });
  const { displacedPersonId, ...linked } = await linkParticipant({
    conversationId, sourceUserId, personId: person.id, source,
  });
  return {
    person, participant: linked, created: true, displacedPersonId: displacedPersonId || null,
  };
}

/**
 * Relate a batch of Beeper messages to Tribe by SENDER only — never by
 * iterating `beeper_participants` (which can be a truncated roster). Each
 * candidate is `{ conversationId, senderId, sentAt, network, channel }`.
 * Dedupe key is `beeper:<YYYY-MM-DD>`, matching #10 decision "daily Tribe
 * touchpoints are written; there is no per-message activity event."
 * Returns `{ created, matched }` (mirrors `tribe.autoLogTouchpoints`'s shape).
 */
export async function logSenderTouchpoints(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { created: 0, matched: 0 };
  await ensureReady();

  // Built ONCE for the whole batch and threaded through resolveParticipantPerson's
  // phone fallback (mirrors tribe.autoLogTouchpoints), rather than every
  // resolution reloading and reindexing every Tribe person from scratch.
  const personIndex = buildPersonMatchIndex(await tribe.listPeople());

  // Memoize the participant -> person resolution per (conversationId,
  // senderId) within this batch, so a burst of messages from the same sender
  // resolves once, not per message. Day-level dedupe is NOT reimplemented
  // here: tribe.autoCreateTouchpoint's (person_id, dedupe_key) partial unique
  // index already collapses a same-day repeat into a harmless no-op insert.
  const personCache = new Map();
  let created = 0;
  let matched = 0;
  for (const c of candidates) {
    if (!c?.conversationId || !c?.senderId || !c?.sentAt) continue;
    const cacheKey = `${c.conversationId} ${c.senderId}`;
    if (!personCache.has(cacheKey)) {
      // eslint-disable-next-line no-await-in-loop -- resolving one sender at a time; batch sizes here are one sync sweep, not a bulk import
      personCache.set(cacheKey, await resolveParticipantPerson(
        { conversationId: c.conversationId, sourceUserId: c.senderId },
        personIndex,
      ));
    }
    const personId = personCache.get(cacheKey);
    if (!personId) continue;
    matched++;
    // Normalize to an ISO date before slicing — String(c.sentAt) on a live
    // Date OBJECT (as opposed to an already-ISO string) yields its
    // toString() form ("Wed Sep 03 2026 ..."), whose first 10 characters are
    // NOT a date, silently breaking the `beeper:<day>` dedupe key. Falls back
    // to the old slice for a value Date can't parse, rather than throwing.
    const parsedSentAt = new Date(c.sentAt);
    const day = Number.isNaN(parsedSentAt.getTime())
      ? String(c.sentAt).slice(0, 10)
      : parsedSentAt.toISOString().slice(0, 10);
    // eslint-disable-next-line no-await-in-loop -- same reason as above
    const touchpoint = await tribe.autoCreateTouchpoint(personId, {
      happenedAt: c.sentAt,
      channel: c.channel || (c.network ? `Beeper (${c.network})` : 'Beeper'),
      summary: '',
      source: 'message',
      dedupeKey: `beeper:${day}`,
      metadata: { network: c.network || '', conversationId: c.conversationId },
    });
    if (touchpoint) created++;
  }
  return { created, matched };
}
