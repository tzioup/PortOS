/**
 * Tribe network-scoped identities (#34, decided on #10) — CRUD over
 * `tribe_identities`: `person_id`, `kind`, `network`, `handle`, `source`,
 * `linked_at`, `UNIQUE (kind, network, handle)`.
 *
 * This is the durable-handle "truth" half of #10's split-by-durability
 * design. The other half — `beeper_participants.tribe_person_id` as a cache
 * authoritative only when no durable handle exists — lives in
 * `server/services/beeperTribe.js`, which is also this table's only caller
 * today. Kept as its own service (rather than folded into `beeperTribe.js`)
 * because `tribe_identities` is Tribe-domain, not Beeper-domain — the same
 * table is the documented landing spot for a future Signal retrofit (#16,
 * deferred, not built here).
 *
 * INTENTIONALLY MACHINE-LOCAL — same ADR as the rest of Tribe
 * (docs/decisions/2026-06-26-tribe-and-universe-runs-local.md). No sync hook
 * here by design, consistent with tribe.js.
 */
import { ensureSchema, query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';

async function ensureReady() {
  await ensureSchema();
}

export function rowToIdentity(row) {
  return {
    id: row.id,
    personId: row.person_id,
    kind: row.kind,
    network: row.network || '',
    handle: row.handle,
    source: row.source || '',
    linkedAt: row.linked_at?.toISOString?.() ?? row.linked_at,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  };
}

/**
 * Look up the Tribe person currently claiming a `(kind, network, handle)`
 * identity, or `null`. `network` defaults to `''` (the network-less scope
 * `classifyNetworkHandle`'s `'phone'` kind uses — the same phone number means
 * the same person regardless of which network reported it). A `kind='handle'`
 * identity is always network-scoped — an empty network can never resolve one,
 * since `linkIdentity` refuses to write such a row (see below).
 *
 * Joined against `tribe_people` and filtered to `deleted = FALSE`:
 * `tribe.deletePerson` is a SOFT delete, so `ON DELETE CASCADE` on this
 * table's `person_id` FK never fires for it, and an unfiltered lookup would
 * keep resolving a Beeper participant onto a person the user deleted.
 */
export async function resolvePersonByIdentity({ kind, network = '', handle }) {
  if (!kind || !handle) return null;
  if (kind === 'handle' && !network) return null;
  await ensureReady();
  const result = await query(
    `SELECT ti.person_id
     FROM tribe_identities ti
     JOIN tribe_people tp ON tp.id = ti.person_id
     WHERE ti.kind = $1 AND ti.network = $2 AND ti.handle = $3 AND tp.deleted = FALSE`,
    [kind, network, handle],
  );
  return result.rows[0]?.person_id || null;
}

/**
 * Confirm a person exists and is not soft-deleted before letting them claim
 * an identity or a `beeper_participants` link. The `tribe_people` FK alone
 * does not block linking to a soft-deleted person — `tribe.deletePerson` is
 * `UPDATE ... SET deleted = TRUE`, not a hard delete, so the row (and its FK)
 * still exists. Exported so `server/services/beeperTribe.js` can run the same
 * check before writing `beeper_participants.tribe_person_id`, including the
 * no-durable-handle case where `linkIdentity` below is never reached.
 */
export async function assertPersonLinkable(personId) {
  await ensureReady();
  const result = await query(`SELECT deleted FROM tribe_people WHERE id = $1`, [personId]);
  const row = result.rows[0];
  if (!row || row.deleted) throw new ServerError('Person not found', { status: 404 });
}

export async function listIdentitiesForPerson(personId) {
  await ensureReady();
  const result = await query(
    `SELECT * FROM tribe_identities WHERE person_id = $1 ORDER BY linked_at DESC`,
    [personId],
  );
  return result.rows.map(rowToIdentity);
}

/**
 * Claim a `(kind, network, handle)` identity for a person. Re-linking an
 * already-claimed identity to a DIFFERENT person moves ownership (`DO UPDATE`)
 * rather than erroring — there is no unlink UI yet (#10's "Not yet specified"
 * list), and a single-user install has no concurrent-writer race to defend
 * against (root AGENTS.md Security Model), so "the last explicit link wins"
 * is the simplest correct behavior until an unlink/merge flow exists. Because
 * that move is silent at the database level (the audit trigger on this table
 * only captures hard deletes — there is no `deleted` column to tombstone-flip
 * on — so a `person_id` UPDATE leaves no `record_audit` row either), the
 * returned identity carries `displacedPersonId`: the id of whoever previously
 * owned this exact identity, or `null` on a fresh claim / a re-link to the
 * SAME person. Callers (`beeperTribe.linkParticipant`, the `/beeper/link*`
 * routes) surface it so an ownership move is never silent to the user.
 *
 * `network` is required for `kind='handle'` — a network-scoped username
 * claimed with no network is the inert-row / cross-network-collision hazard
 * this function exists to prevent (see server/routes/tribe.js's
 * `beeperLinkSchema` comment). `kind='phone'` stays network-less by design.
 */
export async function linkIdentity({
  personId, kind, network = '', handle, source = '',
}) {
  if (!personId) throw new ServerError('personId is required', { status: 400, code: 'BAD_REQUEST' });
  if (!kind || !handle) throw new ServerError('kind and handle are required', { status: 400, code: 'BAD_REQUEST' });
  if (kind === 'handle' && !network) {
    throw new ServerError('network is required to link a handle identity', { status: 400, code: 'BAD_REQUEST' });
  }
  await ensureReady();
  await assertPersonLinkable(personId);

  const existing = await query(
    `SELECT person_id FROM tribe_identities WHERE kind = $1 AND network = $2 AND handle = $3`,
    [kind, network, handle],
  );
  const previousPersonId = existing.rows[0]?.person_id || null;

  const result = await query(
    `INSERT INTO tribe_identities (person_id, kind, network, handle, source, linked_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (kind, network, handle)
     DO UPDATE SET person_id = EXCLUDED.person_id, source = EXCLUDED.source, linked_at = NOW()
     RETURNING *`,
    [personId, kind, network, handle, source],
  ).catch((err) => {
    if (err?.code === '23503') throw new ServerError('Person not found', { status: 404 });
    throw err;
  });
  const displacedPersonId = previousPersonId && previousPersonId !== personId ? previousPersonId : null;
  return { ...rowToIdentity(result.rows[0]), displacedPersonId };
}
