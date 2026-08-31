# ADR: Beeper Message Bodies Are Mirrored Machine-Local

- **Date:** 2026-08-31
- **Status:** Accepted
- **Related:** wayfinder map [Beeper in Comms](https://github.com/tzioup/PortOS/issues/1),
  ticket [Design the Beeper conversation and message store](https://github.com/tzioup/PortOS/issues/7),
  research [#2](https://github.com/tzioup/PortOS/issues/2) (API surface),
  [#3](https://github.com/tzioup/PortOS/issues/3) (delivery and backfill),
  [#5](https://github.com/tzioup/PortOS/issues/5) (identity model),
  ADR [privacy records machine-local](./2026-08-08-privacy-records-machine-local.md),
  ADR [tribe and universe runs local](./2026-06-26-tribe-and-universe-runs-local.md),
  [`docs/STORAGE.md`](../STORAGE.md), [`server/services/imessageSync.js`](../../server/services/imessageSync.js)

## Context

PortOS already ingests two message sources. Neither of them keeps the text.

`imessageSync.js` opens Apple's `chat.db` read-only, walks it from a ROWID cursor,
and writes a **short summary** into `human_activity_events` plus a daily row into
`tribe_touchpoints`. `signalSync.js` follows the same shape. The full body stays
in the source database, and PortOS holds a pointer and a gist. That position is
deliberate: the source is on the same machine, it is authoritative, and it is
always available, so mirroring it would duplicate bytes for nothing.

The Beeper integration breaks all three of those assumptions.

1. **The source is not durable.** Beeper's own history depth varies enormously by
   network (#3): Discord server channels return **zero** history, Discord DMs
   about five conversations at fifty messages each, LinkedIn and Google Chat
   nothing at all. What Beeper has today it may not have next month, and it is
   not a database PortOS can re-read at will.
2. **The source is not queryable the way PortOS needs.** List endpoints have no
   `limit` and expose only opaque cursors (#2). There is no "give me every message
   from this person across every network since March". Search, `pgvector`
   similarity, and writing-style analysis all need the text local.
3. **The source can vanish.** Beeper Desktop is a third-party app on a paid
   service. A read-through design makes every PortOS feature built on this data
   stop working the day the app is uninstalled, the subscription lapses, or the
   vendor changes the API.

## Decision

**PortOS mirrors full Beeper message bodies into its own PostgreSQL database.
The mirror is the read path for the UI. Beeper is an ingestion source, not a
backing store.**

Concretely:

- `beeper_conversations`, `beeper_messages`, `beeper_participants`, and
  `beeper_sync_cursors` are `db-primary` under [`docs/STORAGE.md`](../STORAGE.md).
  `beeper_messages.body` holds the message text.
- The client reads PostgreSQL only. A single server-side sync writer owns every
  call to the Beeper API. The WebSocket (#3) is an **invalidation hint** that
  triggers an HTTP refetch, never a data source, because it is at-most-once with
  no replay on reconnect.
- Attachment **bytes are not mirrored** by this decision. Messages carry
  attachment references only; what PortOS stores, streams, or discards is a
  separate open question on the map.

### This departs from the iMessage position, knowingly

The iMessage doctrine is "full bodies stay in Apple's chat.db". That doctrine is
correct **for a local, durable, queryable source**. Beeper is none of the three.
The doctrine is not superseded, it is scoped: a source that PortOS can re-read
cheaply and completely stays unmirrored, and a source that cannot be is mirrored.

## Privacy consequences, and where they are enforced

Message bodies are the most sensitive payload PortOS has yet persisted. They are
also the exact class the federation layer must never carry
([ADR privacy records machine-local](./2026-08-08-privacy-records-machine-local.md)).

**No `beeper_*` table federates.** Following the Privacy Center precedent
exactly, and permanently unless this ADR is superseded:

- No Beeper kind is added to `PEER_SUBSCRIBABLE_KINDS`.
- No Beeper category is added to `dataSync`'s `CATEGORIES`.
- No Beeper table gains a `sync_sequence` cursor or a sync-flavoured
  `deleted` / `deleted_at` tombstone pair. (`beeper_messages.deleted_at` is an
  **inbound source tombstone** and is unrelated to sync; the naming collision is
  called out here so a future reader does not mistake it for a sync cursor.)
- No Beeper category is added to `PORTOS_SCHEMA_VERSIONS`. There is no wire
  contract to version because there is no wire.
- A guard test asserts no table matching `beeper_%` appears in any of those
  allowlists, so the exclusion is enforced rather than merely intended.

Exclusion is already the default posture: the sync layer is three allowlists, and
a table with no sequence cursor cannot travel. The guard test exists so a future
change cannot opt these tables in by accident.

### Retention

**PortOS never discards a mirrored body automatically.** No age window, no size
cap, no silent eviction. An archive that quietly forgets is not trustworthy for
the purposes it was built for.

Deletion is an explicit user action only, offered at two grains: purge one
conversation, or purge the whole Beeper store. Both are hard deletes.

### Source deletions and edits

A deletion **at the source** is a tombstone, not a removal, matching what the
reference client does and what the API reports: the row is kept, `deleted_at` is
stamped, and `body` is set to `NULL`. The message keeps its sender and its
position in the timeline.

An edit at the source overwrites `body` and stamps `edited_at`. PortOS keeps no
revision history: it cannot reconstruct one from the API, so a partial history
would be misleading.

An **outbound** delete is a different operation with different consequences (the
API's `DELETE` defaults to unsending for everyone, #2). It does not share a code
path with the inbound tombstone, and it must not share a word in the UI.

## Consequences

**Accepted costs.**

- The database grows without bound in the normal case. This is the price of the
  guarantee above, and it is bounded in practice by one person's message volume.
- A local PostgreSQL now holds the plaintext of every bridged conversation. The
  install's threat model already assumes a single trusted user on a private
  machine; this raises the value of that machine's disk encryption, and it is
  the reason the federation exclusion is enforced by test rather than by comment.
- Two sources of truth exist transiently. Beeper is authoritative for anything
  newer than the last sync; the mirror is authoritative for everything older,
  including history Beeper itself has since dropped.

**Bought.**

- Search, `pgvector` similarity, and writing-style analysis over message text
  become ordinary PortOS queries.
- The Comms UI works offline and survives Beeper being closed, uninstalled, or
  unsubscribed.
- Tribe relation runs against local rows rather than paginated third-party calls.

## Rejected alternatives

**Read-through, no mirror.** Every UI read hits the Beeper API. Rejected: no
search, no style analysis, no offline, no history beyond what Beeper still holds,
and the opaque-cursor pagination (#2) makes even a conversation list slow.

**Mirror metadata, not bodies.** Store sender, timestamp and a short summary, the
iMessage shape. Rejected: the summary is lossy and cannot be regenerated once
Beeper drops the source message, which defeats the archive and the analysis
alike.

**Mirror bodies, encrypted at rest with `vaultCrypto.js`.** Rejected for this
ADR, not forever. The vault's design point is a small set of high-value fields
with a masked plaintext projection for display; applying it to every message body
would defeat `tsvector` and `pgvector` indexing, which are the reason for
mirroring in the first place. Whether the token itself is vaulted is a separate
open question on the map.

**Retention window.** Keep ninety days, drop the rest. Rejected: it makes the
archive unreliable for the one thing it exists for, and the storage it saves is
not scarce.
