// Beeper conversation mirror DDL (#27). Machine-local mirror of the Beeper
// Desktop API (accounts, conversations, messages, participants, attachment
// metadata, and per-chat sync cursors). Carries the schema decisions from the
// Beeper wayfinder map (#1); rationale lives on #7 (store shape), #10 (Tribe
// handles), #12 (transport), #13 (attachments) — not repeated here.
//
// NEVER FEDERATED — enforced by beeperNeverFederates.test.js. No table here
// gets a `sync_sequence` column, a PEER_SUBSCRIBABLE_KINDS entry, a dataSync
// snapshot category, or a PORTOS_SCHEMA_VERSIONS entry.
//
// Deletions from the source are tombstones, not removals: a message the
// source unsends keeps its row, body, and attachments and gains `unsent_at`
// — the column is named for what the source actually reports, and an archive
// that quietly forgets a caption while keeping its photo is not trustworthy.
// Because the inbound tombstone is `unsent_at`, the federation guard keys on
// `sync_sequence` alone and needs no soft-delete exemption. See the ADR
// landing alongside #7 for the full argument.
export const beeperDdl = [
  // The account roster the settings card renders from with Beeper closed
  // (#11 left the store to this issue). `loginID` is never stored — it is
  // the bridge login credential's own id, not something PortOS needs to
  // read a chat.
  `CREATE TABLE IF NOT EXISTS beeper_accounts (
    account_id TEXT PRIMARY KEY,
    network TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    bridge_id TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // The ONE Beeper credential this install holds (#31). AES-256-GCM ciphertext
  // via `server/lib/vaultCrypto.js` — never `settings.json`, never a plaintext
  // file, never a log line. Single-row by construction (`id = 'default'`),
  // because PortOS models one Beeper account per install (#1 charting decision
  // 8); a second row would silently create a second identity no surface can
  // choose between.
  //
  // `token_expires_at NULL` means "never expires" — the state only Beeper's own
  // UI can mint, and the reason pasting a token is a first-class alternative to
  // OAuth rather than a fallback (#11 decision 3). There is no refresh grant, so
  // an expired token is re-connected, never refreshed. `scopes` and `client_id`
  // are stored for the disconnect-time revocation call, and are NEVER surfaced
  // to a client payload; `client_id` is a public-client identifier from dynamic
  // registration, not a secret, and is empty for a pasted token.
  `CREATE TABLE IF NOT EXISTS beeper_credentials (
    id TEXT PRIMARY KEY,
    token_enc TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ,
    scopes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'pasted' CHECK (source IN ('oauth','pasted')),
    client_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // Synthetic UUID primary key so a later cross-network merge never has to
  // repoint every child row — `source_chat_id` is the Beeper-side identity.
  // Pin/archive/mute/low-priority/unread state is Beeper's own state, mirrored
  // read-only; PortOS never invents a second source of truth for it. `type`
  // is intentionally unconstrained: db.catalogDdlParity.test.js forbids a
  // hardcoded enum constraint on any `type` column in this schema (the same
  // rule that keeps catalog_ingredients.type app-layer-gated), so a new
  // Beeper chat type never needs a two-file migration to accept.
  `CREATE TABLE IF NOT EXISTS beeper_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id TEXT NOT NULL REFERENCES beeper_accounts (account_id) ON DELETE CASCADE,
    network TEXT NOT NULL DEFAULT '',
    source_chat_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'single',
    is_group BOOLEAN NOT NULL DEFAULT FALSE,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    is_low_priority BOOLEAN NOT NULL DEFAULT FALSE,
    is_muted BOOLEAN NOT NULL DEFAULT FALSE,
    last_activity TIMESTAMPTZ,
    unread_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (account_id, source_chat_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_conversations_account_activity ON beeper_conversations (account_id, last_activity DESC)`,

  // Keyed on Beeper's own message id (TEXT — bridges do not guarantee a UUID
  // shape). Full bodies persist machine-local, per the store ADR.
  //
  // `is_sender` mirrors the API's own `Message.isSender` and is the ONLY
  // reliable way to tell an outbound message from an inbound one: `senderID`
  // cannot be compared against the local user, because `accounts[].user.id`
  // differs from `senderID` on every network (#2). Without the column a chat
  // surface has to guess which side of the thread a message belongs on, and a
  // guess is wrong on exactly the networks that matter most.
  `CREATE TABLE IF NOT EXISTS beeper_messages (
    id TEXT PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES beeper_conversations (id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    sent_at TIMESTAMPTZ,
    edited_at TIMESTAMPTZ,
    unsent_at TIMESTAMPTZ,
    sort_key TEXT NOT NULL DEFAULT '',
    is_sender BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // Additive, for an install whose `beeper_messages` predates the column —
  // `CREATE TABLE IF NOT EXISTS` is a no-op there, so the inline declaration
  // above only reaches a FRESH install. Same shape as catalog.js's
  // `chunk_index` / `parent_scrap_id`, and the reason the default is FALSE
  // rather than NULL: an unbackfilled row renders as inbound, which is the
  // right way round for a mirror that is mostly other people's messages.
  `ALTER TABLE beeper_messages ADD COLUMN IF NOT EXISTS is_sender BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_messages_conversation_sort ON beeper_messages (conversation_id, sort_key)`,

  // `observed_via` is required, not cosmetic: the Beeper API's participant
  // lists truncate (20 in a chat listing, 100 in a single-chat GET) with no
  // participants endpoint and no cursor, so a row set is always a possible
  // subset. Without this column a half-empty roster reads as a complete one.
  // `tribe_person_id` is nullable and ON DELETE SET NULL — removing a Tribe
  // person un-links the handle rather than deleting the mirrored participant.
  `CREATE TABLE IF NOT EXISTS beeper_participants (
    conversation_id UUID NOT NULL REFERENCES beeper_conversations (id) ON DELETE CASCADE,
    source_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    handle TEXT NOT NULL DEFAULT '',
    tribe_person_id UUID REFERENCES tribe_people (id) ON DELETE SET NULL,
    observed_via TEXT NOT NULL CHECK (observed_via IN ('participant-list','message-sender')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (conversation_id, source_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_participants_tribe_person ON beeper_participants (tribe_person_id) WHERE tribe_person_id IS NOT NULL`,

  // `(conversation_id, message_id, idx)` addresses one attachment within a
  // message's attachment array. `mxc_id` is the source attachment identifier
  // (typically an mxc:// URL); `srcURL` is NEVER persisted here — it carries
  // its own documented decay warning and is only a cache-state hint, not a
  // durable reference. `keep` exempts an attachment from the least-recently-
  // viewed eviction that bounds the on-disk byte budget.
  `CREATE TABLE IF NOT EXISTS beeper_attachments (
    conversation_id UUID NOT NULL REFERENCES beeper_conversations (id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES beeper_messages (id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    mxc_id TEXT,
    sha256 TEXT,
    mime_type TEXT NOT NULL DEFAULT '',
    byte_length BIGINT,
    file_name TEXT NOT NULL DEFAULT '',
    width INTEGER,
    height INTEGER,
    last_viewed_at TIMESTAMPTZ,
    keep BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (conversation_id, message_id, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_attachments_eviction ON beeper_attachments (last_viewed_at) WHERE keep = FALSE`,
  `CREATE INDEX IF NOT EXISTS idx_beeper_attachments_sha256 ON beeper_attachments (sha256) WHERE sha256 IS NOT NULL`,

  // `chat_id` is the Beeper-side chat id (matches `source_chat_id` above),
  // not the synthetic `beeper_conversations.id` — the backfill sweep calls
  // the upstream List Messages API by the source's own id, and a cursor can
  // exist before the conversation row does. Rows and cursor commit in one
  // transaction with whatever sync wrote them (app-level contract; this
  // table only defines the shape).
  `CREATE TABLE IF NOT EXISTS beeper_sync_cursors (
    account_id TEXT NOT NULL REFERENCES beeper_accounts (account_id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    cursor TEXT,
    last_activity TIMESTAMPTZ,
    last_swept_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, chat_id)
  )`,
];
