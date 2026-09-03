/**
 * Guard: Beeper conversation-mirror records must NEVER federate (#27).
 *
 * The mirror holds full message bodies and attachment metadata pulled from
 * every connected network — exactly the shape of data the peer-sync PULL path
 * (`GET /api/peer-sync/record`) was never designed to carry safely. The store
 * decision (rationale on #7, ADR alongside it) settled this: these tables are
 * machine-local, full stop.
 *
 * Modeled directly on `privacyNeverFederates.test.js` (ADR
 * docs/decisions/2026-08-08-privacy-records-machine-local.md, #2148) — same
 * shape of guard, same reasoning. These assertions are cheap and blunt on
 * purpose: they match the string `beeper` broadly across each federation
 * surface, so a future `beeperConversation` or `beeperMessage` kind trips the
 * guard no matter what it is called.
 */

import { describe, it, expect } from 'vitest';
import { PEER_SUBSCRIBABLE_KINDS } from './peerSyncShared.js';
import { PORTOS_SCHEMA_VERSIONS, NON_RECORD_SCHEMA_CATEGORIES } from '../../lib/schemaVersions.js';
import { beeperDdl } from '../../lib/db/schema/beeper.js';

const mentionsBeeper = (value) => /beeper/i.test(String(value));

// Columns that only exist to support cross-instance sync. A beeper table that
// grows one is either federating already or is being prepared to — both are
// the thing this design forbids. `deleted_at` is included even though the
// store uses `unsent_at` for its tombstone, precisely because that rename
// was made to keep this list collision-free.
const FEDERATION_COLUMNS = ['sync_sequence', 'deleted_at'];

/** The `CREATE TABLE beeper_*` statements, each a complete balanced string. */
const beeperCreateTableStatements = beeperDdl.filter(
  (stmt) => /CREATE TABLE IF NOT EXISTS beeper_/i.test(stmt),
);

describe('beeper conversation mirror never federates (#27)', () => {
  it('exposes no beeper kind to peer-sync subscriptions', () => {
    expect(PEER_SUBSCRIBABLE_KINDS.filter(mentionsBeeper)).toEqual([]);
  });

  it('declares no beeper wire-schema category', () => {
    expect(Object.keys(PORTOS_SCHEMA_VERSIONS).filter(mentionsBeeper)).toEqual([]);
    expect([...NON_RECORD_SCHEMA_CATEGORIES].filter(mentionsBeeper)).toEqual([]);
  });

  // Explicit timeout: the lazy import below resolves the whole dataSync
  // service graph INSIDE the test body (see privacyNeverFederates.test.js for
  // why that cost is paid here rather than at module load).
  it('declares no beeper dataSync snapshot category', async () => {
    const { getSupportedCategories } = await import('../dataSync.js');
    expect(getSupportedCategories().filter(mentionsBeeper)).toEqual([]);
  }, 30000);

  it('gives no beeper table a sync cursor or tombstone column', () => {
    // Sanity: if the filter ever matches nothing the assertion below is
    // vacuous, so pin the table count we expect to be guarding.
    expect(beeperCreateTableStatements).toHaveLength(6);
    for (const stmt of beeperCreateTableStatements) {
      const table = stmt.match(/beeper_[a-z_]+/i)?.[0];
      for (const column of FEDERATION_COLUMNS) {
        expect(`${table}:${stmt.includes(column)}`).toBe(`${table}:false`);
      }
    }
  });

  // Bypass probe — proves the assertions above actually fire.
  it('the guard predicates reject a planted violation', () => {
    expect(['universe', 'beeperConversation'].filter(mentionsBeeper)).toEqual(['beeperConversation']);
    expect(
      ['CREATE TABLE IF NOT EXISTS beeper_conversations (id UUID, sync_sequence BIGINT)']
        .filter((s) => FEDERATION_COLUMNS.some((c) => s.includes(c))),
    ).toHaveLength(1);
  });
});
