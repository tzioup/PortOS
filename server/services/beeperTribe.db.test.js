/**
 * Postgres-backed tests for Beeper ↔ Tribe identity linking (#34), proving the
 * issue's own Acceptance criteria against real constraints (FK cascade, the
 * `tribe_identities` UNIQUE (kind, network, handle) index, the
 * `(person_id, dedupe_key)` touchpoint dedupe) rather than mocked SQL:
 *
 *   - A counterparty with a phone links to an existing Tribe person without
 *     creating a duplicate.
 *   - A counterparty with no durable identifier links by hand and survives a
 *     re-sync.
 *   - A group conversation creates touchpoints for senders only, and never
 *     for a truncated roster.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`
 * (registered in vitest.config.db.js's DB_TEST_INCLUDE — a `<name>.db.test.js`
 * file is not auto-globbed). Every fixture uses placeholder names/handles per
 * root AGENTS.md Sensitive Data & Privacy — no real handle, name, or phone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as tribe from './tribe.js';
import * as tribeIdentities from './tribeIdentities.js';
import * as beeperTribe from './beeperTribe.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/beeperTribe.db.test', dbReady, skipReason);

const nonce = `beepertribe-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ACCOUNT_ID = nonce;
const createdPersonIds = [];

afterAll(async () => {
  if (dbReady) {
    // Cascades through conversations/messages/participants/cursors.
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]).catch(() => {});
    // tribe_identities cascades off tribe_people, but delete people explicitly
    // to also clean up their touchpoints.
    for (const id of createdPersonIds) {
      // eslint-disable-next-line no-await-in-loop -- small fixed teardown list
      await query('DELETE FROM tribe_people WHERE id = $1', [id]).catch(() => {});
    }
    await close();
  }
});

async function makeAccount() {
  await query(
    `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
     VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')
     ON CONFLICT (account_id) DO NOTHING`,
    [ACCOUNT_ID],
  );
}

async function makeConversation(sourceChatId, { isGroup = false } = {}) {
  const { rows } = await query(
    `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type, is_group)
     VALUES ($1, 'whatsapp', $2, 'Example Chat', $3, $4)
     RETURNING id`,
    [ACCOUNT_ID, sourceChatId, isGroup ? 'group' : 'single', isGroup],
  );
  return rows[0].id;
}

async function makePerson(name) {
  const person = await tribe.createPerson({ name });
  createdPersonIds.push(person.id);
  return person;
}

describe.skipIf(!runDb)('beeperTribe (#34)', () => {
  it('a counterparty with a phone links to an existing Tribe person without creating a duplicate', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-phone-chat`);

    // Existing Tribe person already known via, say, iMessage/Contacts.
    const person = await tribe.createPerson({ name: 'Example Phone Person', phones: ['+15550100001'] });
    createdPersonIds.push(person.id);

    // Beeper hands us a participant whose `handle` is that same phone
    // (User.phoneNumber), never having been linked through Beeper before.
    const participant = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'wa-user-1',
      displayName: 'Example Phone Person',
      handle: '+1 (555) 010-0001',
      observedVia: 'message-sender',
      network: 'whatsapp',
    });

    // Auto-resolved on upsert — no manual link needed, and no new person made.
    expect(participant.tribePersonId).toBe(person.id);
    const peopleNamed = await query(
      `SELECT COUNT(*)::int AS n FROM tribe_people WHERE name = 'Example Phone Person'`,
    );
    expect(peopleNamed.rows[0].n).toBe(1);
  });

  it('a counterparty with no durable identifier links by hand and survives a re-sync', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-nohandle-chat`);
    const person = await makePerson('Example No-Handle Person');

    // First sync: no phone, no username (the ~13% case — e.g. Facebook/Slack).
    const first = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'fb-user-1',
      displayName: 'Example No-Handle Person',
      handle: '',
      observedVia: 'message-sender',
    });
    expect(first.tribePersonId).toBeNull();

    // The user links by hand.
    const linked = await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'fb-user-1', personId: person.id,
    });
    expect(linked.tribePersonId).toBe(person.id);

    // A re-sync re-upserts the same participant row (same display name/handle,
    // simulating the ingestion sweep re-observing this counterparty).
    const resynced = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'fb-user-1',
      displayName: 'Example No-Handle Person',
      handle: '',
      observedVia: 'message-sender',
    });
    expect(resynced.tribePersonId).toBe(person.id);
  });

  it('a durable USERNAME handle claims a tribe_identities row and resolves a second participant presenting it', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-handle-chat`);
    const person = await makePerson('Example Handle Person');

    await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'dc-user-1',
      displayName: 'Example Handle Person',
      handle: '@example_handle',
      observedVia: 'message-sender',
      network: 'discord',
    });
    const linked = await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'dc-user-1', personId: person.id, network: 'discord',
    });
    expect(linked.tribePersonId).toBe(person.id);

    const identities = await tribeIdentities.listIdentitiesForPerson(person.id);
    expect(identities).toContainEqual(expect.objectContaining({
      kind: 'handle', network: 'discord', handle: 'example_handle',
    }));

    // A second, DIFFERENT conversation's participant presents the identical
    // handle — it should auto-resolve to the same person without a manual link.
    const otherConversationId = await makeConversation(`${nonce}-handle-chat-2`);
    const secondParticipant = await beeperTribe.upsertParticipant({
      conversationId: otherConversationId,
      sourceUserId: 'dc-user-1-again',
      displayName: 'Example Handle Person',
      handle: '@Example_Handle',
      observedVia: 'message-sender',
      network: 'discord',
    });
    expect(secondParticipant.tribePersonId).toBe(person.id);
  });

  it('enforces UNIQUE (kind, network, handle) semantics via linkIdentity re-link (moves ownership, no duplicate row)', async () => {
    const personA = await makePerson('Example Identity Owner A');
    const personB = await makePerson('Example Identity Owner B');

    await tribeIdentities.linkIdentity({ personId: personA.id, kind: 'handle', network: 'slack', handle: 'example-owner' });
    const relinked = await tribeIdentities.linkIdentity({ personId: personB.id, kind: 'handle', network: 'slack', handle: 'example-owner' });
    expect(relinked.personId).toBe(personB.id);

    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM tribe_identities WHERE kind = 'handle' AND network = 'slack' AND handle = 'example-owner'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('a group conversation creates touchpoints for senders only, never for a truncated roster', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-group-chat`, { isGroup: true });

    const sender = await makePerson('Example Group Sender');
    const rosterOnly = await makePerson('Example Roster-Only Person');

    // The sender messaged and is linked.
    await beeperTribe.upsertParticipant({
      conversationId, sourceUserId: 'group-sender-1', displayName: 'Example Group Sender', handle: '', observedVia: 'message-sender',
    });
    await beeperTribe.linkParticipant({ conversationId, sourceUserId: 'group-sender-1', personId: sender.id });

    // A second person is on the (truncated) participant roster but NEVER sent
    // a message in this batch — logSenderTouchpoints must never touch them,
    // because it never enumerates beeper_participants at all.
    await beeperTribe.upsertParticipant({
      conversationId, sourceUserId: 'group-roster-only-1', displayName: 'Example Roster-Only Person', handle: '', observedVia: 'participant-list',
    });
    await beeperTribe.linkParticipant({ conversationId, sourceUserId: 'group-roster-only-1', personId: rosterOnly.id });

    const before = await tribe.listTouchpoints(rosterOnly.id);
    expect(before).toHaveLength(0);

    const result = await beeperTribe.logSenderTouchpoints([
      { conversationId, senderId: 'group-sender-1', sentAt: new Date().toISOString(), network: 'whatsapp' },
      { conversationId, senderId: 'group-sender-1', sentAt: new Date().toISOString(), network: 'whatsapp' }, // same sender, same day — dedupes
    ]);
    expect(result.created).toBe(1);
    expect(result.matched).toBe(2);

    const senderTouchpoints = await tribe.listTouchpoints(sender.id);
    expect(senderTouchpoints).toHaveLength(1);
    expect(senderTouchpoints[0].source).toBe('message');

    // The roster-only person, despite being linked and present in
    // beeper_participants, never sent a message — no touchpoint for them.
    const after = await tribe.listTouchpoints(rosterOnly.id);
    expect(after).toHaveLength(0);
  });
});
