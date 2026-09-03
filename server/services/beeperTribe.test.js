/**
 * Mocked-Postgres unit tests for the Beeper ↔ Tribe RESOLUTION ORDER (#34
 * review). The behavioral acceptance criteria live in `beeperTribe.db.test.js`
 * against a real database; this file exists because that suite runs only under
 * `npm run test:db`, so the ordering regression it guards — a cached
 * `beeper_participants.tribe_person_id` outranking an explicit
 * `tribe_identities` claim — would otherwise not be caught by the default
 * `npm --prefix server test` runner at all.
 *
 * The design contract being pinned (#10, "both stores, split by durability"):
 * `tribe_identities` is the truth for any DURABLE handle; the participant
 * cache column is authoritative ONLY where no durable handle exists.
 *
 * Postgres is mocked with in-memory maps that interpret the exact SQL shapes
 * `beeperTribe.js` / `tribeIdentities.js` issue, so the tests fail if either
 * the order OR the SQL changes. Every fixture uses placeholder handles and
 * 555-01xx numbers per root AGENTS.md Sensitive Data & Privacy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = {
  people: new Map(),        // id -> { deleted }
  conversations: new Map(), // id -> network
  participants: new Map(),  // `${conversationId}|${sourceUserId}` -> row
  identities: new Map(),    // `${kind}|${network}|${handle}` -> person_id
};
const seenSql = [];

const pKey = (c, s) => `${c}|${s}`;
const iKey = (k, n, h) => `${k}|${n}|${h}`;

function participantRow(row) {
  return {
    ...row,
    network: db.conversations.get(row.conversation_id) ?? '',
    tribe_person_deleted: row.tribe_person_id ? !!db.people.get(row.tribe_person_id)?.deleted : null,
  };
}

vi.mock('../lib/db.js', () => ({
  ensureSchema: vi.fn(async () => {}),
  query: vi.fn(async (sql, params = []) => {
    seenSql.push(sql);
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT p\.\*, c\.network, tp\.deleted/.test(s)) {
      const row = db.participants.get(pKey(params[0], params[1]));
      return { rows: row ? [participantRow(row)] : [] };
    }
    if (/^SELECT ti\.person_id FROM tribe_identities/.test(s)) {
      const personId = db.identities.get(iKey(params[0], params[1], params[2]));
      const alive = personId && !db.people.get(personId)?.deleted;
      return { rows: alive ? [{ person_id: personId }] : [] };
    }
    if (/^SELECT person_id FROM tribe_identities WHERE kind/.test(s)) {
      const personId = db.identities.get(iKey(params[0], params[1], params[2]));
      return { rows: personId ? [{ person_id: personId }] : [] };
    }
    if (/^SELECT deleted FROM tribe_people WHERE id/.test(s)) {
      const person = db.people.get(params[0]);
      return { rows: person ? [{ deleted: person.deleted }] : [] };
    }
    if (/^SELECT p\.conversation_id, p\.source_user_id, p\.handle, c\.network/.test(s)) {
      const rows = [...db.participants.values()]
        .filter((r) => r.tribe_person_id === params[0] && r.handle !== '')
        .map((r) => ({
          conversation_id: r.conversation_id,
          source_user_id: r.source_user_id,
          handle: r.handle,
          network: db.conversations.get(r.conversation_id) ?? '',
        }));
      return { rows };
    }
    if (/^INSERT INTO tribe_identities/.test(s)) {
      const [personId, kind, network, handle, source] = params;
      db.identities.set(iKey(kind, network, handle), personId);
      return {
        rows: [{
          id: `identity-${kind}-${network}-${handle}`,
          person_id: personId,
          kind,
          network,
          handle,
          source,
          linked_at: '2026-01-01T00:00:00.000Z',
          created_at: '2026-01-01T00:00:00.000Z',
        }],
      };
    }
    if (/^INSERT INTO beeper_participants/.test(s)) {
      const [conversationId, sourceUserId, displayName, handle, observedVia] = params;
      const key = pKey(conversationId, sourceUserId);
      const existing = db.participants.get(key);
      if (existing) {
        // Honor the REAL ON CONFLICT clause: a durable handle survives an
        // empty re-observation only while the COALESCE guard is in the SQL.
        const guarded = /COALESCE\(NULLIF\(EXCLUDED\.handle, ''\), beeper_participants\.handle\)/.test(s);
        db.participants.set(key, {
          ...existing,
          display_name: displayName,
          handle: guarded ? (handle || existing.handle) : handle,
          observed_via: observedVia,
        });
      } else {
        db.participants.set(key, {
          conversation_id: conversationId,
          source_user_id: sourceUserId,
          display_name: displayName,
          handle,
          observed_via: observedVia,
          tribe_person_id: null,
        });
      }
      return { rows: [] };
    }
    if (/^UPDATE beeper_participants SET tribe_person_id = NULL/.test(s)) {
      const row = db.participants.get(pKey(params[0], params[1]));
      if (row && row.tribe_person_id === params[2]) row.tribe_person_id = null;
      return { rows: [] };
    }
    if (/^UPDATE beeper_participants SET tribe_person_id = \$3/.test(s)) {
      const row = db.participants.get(pKey(params[0], params[1]));
      if (!row) return { rows: [] };
      if (/AND tribe_person_id IS NULL/.test(s) && row.tribe_person_id) return { rows: [] };
      row.tribe_person_id = params[2];
      return { rows: [participantRow(row)] };
    }
    throw new Error(`unmocked SQL: ${s.slice(0, 120)}`);
  }),
}));

const listPeople = vi.fn(async () => []);
vi.mock('./tribe.js', () => ({
  listPeople: (...args) => listPeople(...args),
  createPerson: vi.fn(),
  autoCreateTouchpoint: vi.fn(),
}));

const { query } = await import('../lib/db.js');
const beeperTribe = await import('./beeperTribe.js');

const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const OTHER_CONVERSATION = '00000000-0000-4000-8000-000000000002';
const CACHED_PERSON = '11111111-1111-4111-8111-111111111111';
const CLAIMING_PERSON = '22222222-2222-4222-8222-222222222222';
const LEGACY_PHONE_PERSON = '33333333-3333-4333-8333-333333333333';
const PHONE_RAW = '+1 (555) 010-0001';
const PHONE_NORMALIZED = '+15550100001';

function seedPerson(id) {
  db.people.set(id, { deleted: false });
  return id;
}

function seedParticipant({
  conversationId = CONVERSATION, sourceUserId = 'user-1', handle = '', tribePersonId = null,
  network = 'discord', displayName = 'Example Person', observedVia = 'message-sender',
} = {}) {
  db.conversations.set(conversationId, network);
  db.participants.set(pKey(conversationId, sourceUserId), {
    conversation_id: conversationId,
    source_user_id: sourceUserId,
    display_name: displayName,
    handle,
    observed_via: observedVia,
    tribe_person_id: tribePersonId,
  });
}

beforeEach(() => {
  db.people.clear();
  db.conversations.clear();
  db.participants.clear();
  db.identities.clear();
  seenSql.length = 0;
  listPeople.mockClear();
  listPeople.mockResolvedValue([]);
  query.mockClear();
  seedPerson(CACHED_PERSON);
  seedPerson(CLAIMING_PERSON);
  seedPerson(LEGACY_PHONE_PERSON);
});

describe('resolveParticipantPerson resolution order (#34 review)', () => {
  it('lets an explicit tribe_identities claim beat a stale cached tribe_person_id (phone)', async () => {
    seedParticipant({ handle: PHONE_RAW, tribePersonId: CACHED_PERSON, network: 'whatsapp' });
    db.identities.set(iKey('phone', '', PHONE_NORMALIZED), CLAIMING_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CLAIMING_PERSON);
  });

  it('lets an explicit tribe_identities claim beat a stale cached tribe_person_id (network username)', async () => {
    seedParticipant({ handle: '@Example_Handle', tribePersonId: CACHED_PERSON, network: 'discord' });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CLAIMING_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CLAIMING_PERSON);
  });

  it('keeps the cache authoritative when NO durable handle exists (the ~13% case)', async () => {
    seedParticipant({ handle: '', tribePersonId: CACHED_PERSON });

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CACHED_PERSON);
  });

  it('keeps the cache authoritative for a username on a network-less conversation (nothing durable to claim)', async () => {
    seedParticipant({ handle: '@example_handle', tribePersonId: CACHED_PERSON, network: '' });
    // A same-named claim on a REAL network must not leak into the unscoped row.
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CLAIMING_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CACHED_PERSON);
  });

  it('falls back to the cache for a durable handle nobody has claimed, before the legacy phone array', async () => {
    seedParticipant({ handle: PHONE_RAW, tribePersonId: CACHED_PERSON, network: 'whatsapp' });
    listPeople.mockResolvedValue([{ id: LEGACY_PHONE_PERSON, name: 'Example Legacy', phones: [PHONE_NORMALIZED] }]);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CACHED_PERSON);
  });

  it('falls back to the legacy Tribe phone matcher only when neither an identity nor a cache answers', async () => {
    seedParticipant({ handle: PHONE_RAW, tribePersonId: null, network: 'whatsapp' });
    listPeople.mockResolvedValue([{ id: LEGACY_PHONE_PERSON, name: 'Example Legacy', phones: [PHONE_NORMALIZED] }]);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(LEGACY_PHONE_PERSON);
  });

  it('returns null for an unknown participant', async () => {
    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'nobody',
    })).toBeNull();
  });
});

describe('linkParticipant', () => {
  it('nulls the displaced person\'s other participant caches on an ownership move, so they stop resolving to them', async () => {
    // Two conversations on the same network, both presenting the same handle;
    // the first is already cached onto CACHED_PERSON.
    seedParticipant({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-elsewhere',
      handle: '@Example_Handle', tribePersonId: CACHED_PERSON, network: 'discord',
    });
    seedParticipant({ handle: '@example_handle', tribePersonId: CACHED_PERSON, network: 'discord' });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CACHED_PERSON);

    const linked = await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(linked.displacedPersonId).toBe(CACHED_PERSON);

    // The OTHER conversation's row no longer points at the displaced person...
    expect(db.participants.get(pKey(OTHER_CONVERSATION, 'user-elsewhere')).tribe_person_id).toBeNull();
    // ...and now resolves through the identity claim to the new owner.
    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-elsewhere',
    })).toBe(CLAIMING_PERSON);
  });

  it('leaves a displaced person\'s UNRELATED participant rows alone', async () => {
    seedParticipant({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-elsewhere',
      handle: '@different_handle', tribePersonId: CACHED_PERSON, network: 'discord',
    });
    seedParticipant({ handle: '@example_handle', tribePersonId: CACHED_PERSON, network: 'discord' });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CACHED_PERSON);

    await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(db.participants.get(pKey(OTHER_CONVERSATION, 'user-elsewhere')).tribe_person_id).toBe(CACHED_PERSON);
  });

  it('writes the cache instead of throwing 400 when a username-bearing participant has no conversation network', async () => {
    seedParticipant({ handle: '@example_handle', network: '' });

    const linked = await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(linked.tribePersonId).toBe(CLAIMING_PERSON);
    expect(linked.displacedPersonId).toBeNull();
    // No inert, unscoped kind='handle' row was written.
    expect(db.identities.size).toBe(0);
  });

  it('still claims a phone identity on a network-less conversation (phones are network-less by design)', async () => {
    seedParticipant({ handle: PHONE_RAW, network: '' });

    await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(db.identities.get(iKey('phone', '', PHONE_NORMALIZED))).toBe(CLAIMING_PERSON);
  });
});

describe('upsertParticipant handle preservation', () => {
  it('guards the ON CONFLICT handle update with COALESCE/NULLIF', async () => {
    db.conversations.set(CONVERSATION, 'discord');
    await beeperTribe.upsertParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', handle: '@example_handle', observedVia: 'message-sender',
    });
    const insert = seenSql.find((sql) => /INSERT INTO beeper_participants/.test(sql));
    expect(insert.replace(/\s+/g, ' ')).toContain(
      "handle = COALESCE(NULLIF(EXCLUDED.handle, ''), beeper_participants.handle)",
    );
  });

  it('does not wipe a durable handle when the same participant is re-observed without one', async () => {
    seedParticipant({ handle: '@example_handle', network: 'discord' });

    const resynced = await beeperTribe.upsertParticipant({
      conversationId: CONVERSATION,
      sourceUserId: 'user-1',
      displayName: 'Example Person',
      handle: '',
      observedVia: 'participant-list',
    });
    expect(resynced.handle).toBe('@example_handle');
  });

  it('replaces the stored handle when a new, non-empty one is observed', async () => {
    seedParticipant({ handle: '@old_handle', network: 'discord' });

    const resynced = await beeperTribe.upsertParticipant({
      conversationId: CONVERSATION,
      sourceUserId: 'user-1',
      displayName: 'Example Person',
      handle: '@new_handle',
      observedVia: 'message-sender',
    });
    expect(resynced.handle).toBe('@new_handle');
  });
});
