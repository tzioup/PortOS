# Beeper

PortOS mirrors the chats a local [Beeper Desktop](https://www.beeper.com/) install already
bridges — WhatsApp, Discord, Telegram, and whatever else the user has connected — into its own
PostgreSQL store, renders them at **Comms > Beeper** (`/messages/beeper`), and can send one
message at a time through a human-gated outbox. Every request goes to Beeper Desktop's own local
HTTP and WebSocket API, on loopback by default. Nothing about the mirror crosses the federation
layer, and PortOS never talks to Beeper's cloud.

The feature is off by default and ships no credential. It becomes reachable only once the
**Beeper** instance feature is on and a token has been stored.

## What it talks to

Beeper Desktop exposes a local HTTP + WebSocket API. PortOS defaults to
`http://127.0.0.1:23373` (`DEFAULT_BASE_URL` in `server/services/beeperClient.js`), and
`settings.beeper.baseUrl` makes that editable for an install listening somewhere else. The
loopback literal rather than `localhost` is deliberate: a dual-stack box may resolve `localhost`
to `::1` first.

The client is raw `fetch`, deliberately **not** `@beeper/desktop-api`: the published SDK lags
the live API and exposes no `Account.status`, no `loginID`, and no `/v1/bridges`. `GET /v1/spec`
on the running instance is the reference the client was written against. `server/lib/safeUrlFetch.js`
cannot wrap it — that helper blocks loopback in both postures by design, and this API *is* a
loopback service — so every call goes through `fetchWithTimeout` directly, the same way the
Ollama and LM Studio integrations do.

The endpoints the shipped feature actually calls:

| Beeper endpoint | Used for |
| --- | --- |
| `GET /v1/info` | Liveness probe (it also answers unauthenticated, which is why it is the probe and not a credential check) and the `endpoints.oauth.introspection_endpoint` fallback |
| `GET /v1/accounts`, `GET /v1/bridges` | The account roster, joined into `beeper_accounts` |
| `GET /v1/chats?accountIDs=…` | Conversation ingestion, newest-first |
| `GET /v1/chats/{chatID}/messages` | Message ingestion, and the outbox's confirmation fallback |
| `GET /v1/chats/{chatID}/messages/{messageID}` | The outbox's confirmation fallback |
| `POST /v1/chats/{chatID}/messages` | The one send call, reached only from the outbox |
| `PATCH /v1/chats/{chatID}` | The Archive and Low priority rail controls |
| `GET`/`HEAD /v1/assets/serve` | The attachment mirror — the stream and its size pre-flight |
| `WS /v1/ws` | The realtime transport |
| `/.well-known/oauth-authorization-server` and the endpoints it advertises | Connect and disconnect |

`beeperClient.js` wraps more of the API than the features currently reach — chat and message
search, read/unread state, reactions, edit and delete, `POST /v1/assets/download`, and the
single-chat GET all have wrappers and tests but no caller in a shipped feature path.

Live verification against a real instance was done on **Beeper Desktop 4.3.89**; the
"[What is not verified live](#what-is-not-verified-live)" section below says what that pass did
and did not cover.

Two non-obvious response shapes the client encodes, both confirmed live:

- `GET`/`HEAD /v1/assets/serve` answers **502**, not 404, for media the source network has aged
  out. A generic "5xx is transient" retry policy would loop forever on it, so an asset-endpoint
  502 maps to a terminal `ASSET_UNAVAILABLE`.
- `POST /v1/assets/download` does *not* share that. It answers **200** with `{ error: "…" }` and
  no `srcURL`, so `downloadAsset` validates the 200 body itself and converges on the same
  terminal error.

Reads may retry once on a replayable connection failure. **Writes never retry** — Beeper has no
idempotency key on send, so a retried POST delivers a second real message to a real person.
`allowRetry` is off by default on every request for exactly that reason, and a thrown
`BeeperApiError` carries a `retryable` flag callers key on rather than re-deriving from the
status code.

## Setup

1. In **Settings > Features**, make sure the **Comms** group is on and turn on **Beeper**.
   Beeper is off by default and has no auto-detector — a token-presence gate cannot bootstrap
   the very screen that sets the token.
2. Open **Comms > Beeper**, then the settings drawer from the header action
   (deep-linked as `?settings=1`, so ⌘K and voice can open it directly).
3. Connect: either **Connect Beeper** (OAuth) or paste a token from Beeper Desktop's own UI.
   Both are first-class; see below.
4. Turn on **Enable scheduled Beeper sync** and save. Nothing is ingested until this is on.
5. Optionally adjust the sweep interval, the base URL, and the attachment disk budget in the
   same drawer.

The settings the drawer writes are `settings.beeper.{enabled, intervalMinutes, baseUrl,
attachmentBudgetGb}` — `enabled` false, 5 minutes, the loopback default, and 5 GB. The schema
(`beeperSettingsSchema`) is `.strict()` and has no token field at all, so a credential can never
ride the generic settings route.

Storing a credential, or flipping the Beeper feature or the Comms group, arms or disarms both
the sweep scheduler and the realtime transport immediately — `reconcileBeeperIngestion()` in
`server/services/beeperArming.js` is called from every one of those paths, so no restart is
needed and a disconnect stops the relay rather than leaving it running on a revoked token.

## Connecting

**OAuth is run by PortOS itself.** Beeper Desktop's authorization-server metadata advertises a
`registration_endpoint`, `token_endpoint_auth_methods_supported: ["none"]` and
`code_challenge_methods_supported: ["S256"]`, so PortOS registers itself as a *public* client by
dynamic registration (client name `PortOS`, `token_endpoint_auth_method: none`) and runs
authorization-code + PKCE S256 with a `state` parameter. Both scopes (`read write`) are
requested in one authorization — a second consent round trip in the middle of composing a
message is worse than one prompt at setup.

The PKCE verifier never leaves the server. Pending authorizations live in memory keyed by
`state`, expire after ten minutes, and carry the endpoints discovered when the flow started, so
a base-URL change mid-flow cannot steer the callback at a different token endpoint. Every
discovered endpoint is re-validated against the configured base URL: a metadata document naming
a different host or port is refused outright (the loopback spellings count as one host), which
is what keeps a user-editable base URL from becoming a way to POST the authorization code
off-box.

The redirect URI is built from the browser's own `window.location.origin`, which the client
sends with `POST /api/beeper/oauth/start`. That is untrusted input — whatever lands in
`redirect_uri` is where the authorization code is sent — so `server/lib/beeperOAuthOrigin.js`
accepts it only as a bare `http(s)` origin whose host is a loopback spelling, the host the
request arrived on, or a host named by the configured `PORTOS_UI_URL`/`PORTOS_API_URL`. The port
is deliberately not pinned, because the UI and the API are different ports of one install.
Anything else is refused, warned about *without* logging the value, and falls back to the
request-derived origin. This exists because under the Vite dev proxy the request-derived origin
is the API origin, not the UI origin the browser is actually on.

`GET /api/beeper/oauth/callback` is hit by a browser redirect, not by the SPA, so every outcome
renders as a redirect back to `/messages/beeper` with a flag the tab toasts. The authorization
code is exchanged server-side and never reaches the client.

**Pasting a token is a first-class alternative, not a fallback.** Nothing in the OAuth surface
accepts a lifetime, while Beeper's own UI can mint a no-expiry token — and there is no
`refresh_token` grant anywhere in the metadata, so an expired token is re-connected, never
refreshed. A pasted token is verified before it is stored: RFC 7662 introspection when an
introspection endpoint is discoverable (from the metadata document, or failing that from
`/v1/info`'s `endpoints.oauth.introspection_endpoint`, validated through the same same-host
check), otherwise a call that requires the bearer. A token the server refuses is never stored.

**Where the credential lives.** One row, `id = 'default'`, in `beeper_credentials`: AES-256-GCM
ciphertext via `server/lib/vaultCrypto.js`, decrypted only at the moment of use. The token
grants read *and* send across every bridged network and `DELETE /v1/chats/…/messages/…` defaults
to unsending for everyone, so it does not follow the plaintext-settings precedent that root
`AGENTS.md`'s free-service carve-out covers. The token value is never logged, never put into an
error message, and never returned to a route: `GET /api/beeper/status` reports presence, expiry
and provenance only.

The honest limit, stated rather than overclaimed: `ensureVaultKey()` writes the vault key to the
install-root `.env`, on the same disk as the ciphertext. That bounds database dumps, backup
snapshots and accidental echoes. It does not defend against an attacker who already has
filesystem access.

A legacy plaintext `settings.beeper.token` from the original client survives as a **read-only**
fallback so an install that hand-edited one keeps working; nothing writes it.

**Disconnect** (`DELETE /api/beeper/token`) revokes at the authorization server first when the
credential came from OAuth and a revocation endpoint is advertised, then deletes the local copy
either way — a user asking to disconnect must always end up disconnected. It is idempotent, and
it disarms the sweep and the socket.

## The Comms feature group

`beeper` is one of four features in the **Comms** group (`facetime`, `imessage`, `signal`,
`beeper`), declared in `server/lib/instanceFeatureRegistry.js` as a plain `group: 'comms'` on the
feature descriptor. Settings > Features renders the group toggle and each member's own
tri-state override.

Resolution order for a grouped feature (`resolveOne` in `server/services/instanceFeatures.js`):

1. **The feature's own stored override wins**, on or off. Setting it back to "inherit"
   (`null`) drops the stored key entirely rather than writing a third sentinel.
2. **Otherwise the group decides.** Group off hides every member that has not overridden on;
   group on hands the feature back to its own normal resolution.
3. **Then the detector**, when the feature has one.
4. **Then `defaultEnabled`.**

A group's own `enabled` flag defaults to **true** when no group state is stored, so registering
the group never hid a feature an existing install already saw and no settings write was needed
to preserve the previous behaviour. Malformed settings fail toward `false` for both the feature
override and the group flag — untrustworthy settings must not be read as a confident "on".

Beeper itself declares no detector by design, and `defaultEnabled: false`.

The gate is applied to navigation, never to routes: with the feature off, the sidebar row and
the Messages tab pill disappear and `⌘K`/voice stop offering it, but `/messages/beeper` keeps
resolving so a bookmark or a direct link still works.

## The mirror

Ingestion is an HTTP sweep, not a socket feed. Beeper's WebSocket is at-most-once with no replay
on reconnect and drops events during hydration while the connection still looks healthy, so a
poll that ran only when the socket was down would be asleep during two of the three loss paths.
The socket makes ingestion *prompt*; the sweep makes it *complete*, and it runs unconditionally
on its own timer.

`server/services/beeperScheduler.js` is the fifth instance of the shared `createSyncScheduler`,
alongside iMessage, Signal, Spotify and YouTube. It is gated twice, and the two flags are
deliberately different things:

- `isBeeperIngestionArmed()` — the **instance feature** plus a stored token. Checked silently: a
  fresh install with the feature off narrates nothing it does not have.
- `settings.beeper.enabled` — the **user's ingestion opt-in**, re-read on every tick, so
  turning it off mid-session stops runs without a restart.

The first run is one interval after registration, never at boot. The interval is locked at
registration; changing it takes effect at the next process start.

Per account, one sweep:

1. refreshes `beeper_accounts` from the live roster;
2. pages `GET /v1/chats?accountIDs=…` newest-first and **stops at the first chat that is not
   newer than the stored `beeper_sync_cursors.last_activity` watermark** — the list is ordered by
   last activity, so everything past that point is older;
3. for each changed chat: upserts the conversation, upserts participants, pages new messages
   forward from the stored opaque cursor, logs daily Tribe touchpoints, then commits message
   rows, attachment references and the cursor row in **one transaction**.

That transaction boundary is the point of the module: an interrupted sweep leaves the cursor
exactly where it was and the next sweep refetches the same window. Everything outside it — the
conversation upsert, the participant upserts, the touchpoint writes — is keyed, deduped and
ordered *before* the commit, so a crash can only cause repeated work, never lost work. Safety
caps bound one sweep's work at 20 chat pages per account and 10 message pages per chat; a chat
further behind than that keeps its advanced cursor *and* its old watermark, so it stays eligible
and finishes catching up on the next sweep instead of being skipped as caught-up.

No AI provider call happens anywhere on this path. Ingestion is deterministic.

**What is mirrored:** accounts, conversations, messages, participants, attachment *metadata* and
per-chat sync cursors, across eight `beeper_*` tables. **What is not:** `loginID` is stripped
from every account and bridge row before it reaches any caller (it is the bridge login
credential's own id — a phone number), and `activeAccountCount` is dropped because it is
documented to over-report. Beeper's own `isPinned` is mirrored rather than duplicated: PortOS
stores no pin of its own, and there is deliberately no route to set one. Deletions from the
source are tombstones, not removals — a message the source unsends keeps its row, body and
attachments and gains `unsent_at`.

**Tribe linking** relates a `beeper_participants` row to a `tribe_people` row by durability of
handle: a phone or a network username resolves through `tribe_identities` (plus the existing
Tribe phone matcher for a phone), and resolution only ever *matches* an existing person, never
creates one, so the automatic path cannot produce a duplicate. A participant with no durable
handle is linked by hand, and the participant upsert never touches `tribe_person_id`, so a
manual link survives every re-sync. Group touchpoints are derived from message **senders**, never
from the participant roster, because Beeper truncates that roster (20 in a list, 100 on a single
GET, no cursor) and iterating it would invent contact with people who never messaged.

### Attachments

The byte mirror is **lazy**. Ingestion writes the attachment's metadata and its durable `mxc_id`
reference; the bytes arrive only when a human opens the thread that shows them. A mirrored
account's attachment history runs to gigabytes, and fetching all of it is a transfer nobody
asked for. A bulk backfill exists, but it is a user action behind a consent step that names the
count and the byte size first, and it stops at the disk budget rather than blowing through it.

Files are **content-addressed** at `data/beeper/attachments/<sha256[0..2]>/<sha256>.<ext>`, so
one photo forwarded into four chats is one file and four rows — which is why every deletion path
runs a reference check before unlinking. The extension is cosmetic: `GET /v1/assets/serve` sends
no `Content-Type` at all, so the row stores Beeper's declared `mimeType` and the serving route is
handed that explicitly rather than letting anything be sniffed out of a filename.

- **Per-attachment ceiling: 32 MiB** (`BEEPER_ATTACHMENT_MAX_BYTES`), matching the ceiling PortOS
  already uses for a single federated media asset. It is a named constant, not a setting: an
  over-cap attachment is not lost, it keeps its row and offers "fetch anyway", which is the
  escape hatch a knob would otherwise have been. The cap is enforced at the `HEAD` pre-flight
  *and* mid-stream, because a bridge that declines to report `Content-Length` would otherwise get
  an unbounded write past a ceiling the pre-flight could not see.
- **Disk budget: `settings.beeper.attachmentBudgetGb`**, 5 GB by default, 0.1–1000 accepted.
- **Eviction** is least-recently-viewed, at most 50 candidates per sweep, and it skips anything
  the user locked with `keep`. Before evicting, it `HEAD`s the source: a 502 means Beeper can no
  longer supply the file, so the local copy is the last one in existence and is **kept**
  regardless of age and stamped `unavailable_at` so nothing re-probes it. Any *other* probe
  failure (Beeper closed, a transport blip) stops the sweep rather than evicting on an unanswered
  question, and a row with no `mxc_id` is never a candidate at all, because eviction is only safe
  when the file can be fetched again.
- The same six-hourly sweep also runs an orphan backstop (a file no row points at, a row whose
  file is gone, an abandoned `.partial` older than an hour). It runs whether or not scheduled
  sync is on, because bytes already on disk still count against the budget.
- A stalled transfer is bounded by **silence**, not elapsed time: 60 seconds without a chunk
  aborts, so a slow but progressing 32 MiB download is never cut off and a dead one is.

Bytes are served from an authenticated `/api/` route (`GET /api/beeper/attachments/:messageId/:idx`),
never a static `data/` mount — message media is PII and the store is a pile of hashes that a
directory mount would expose without the row-level check the route performs.

### Realtime

`server/services/beeperSocket.js` holds one long-lived WebSocket from the PortOS server to
`/v1/ws`. The browser cannot hold it: Beeper binds to loopback with CORS locked to the machine,
and a browser cannot set an `Authorization` header on `new WebSocket()`. It uses the `ws`
package rather than Node's built-in WebSocket because a protocol-level server ping is the only
liveness signal Beeper offers and the built-in does not surface ping frames to application code.

On `ready` the transport sends one `subscriptions.set` for `chatIDs: ['*']` plus app state, and
never re-subscribes per conversation: `subscriptions.set` replaces state wholesale and the window
during a re-set is dark, so scoping it would manufacture a loss window on exactly the event you
most want to catch.

- **Silence watchdog:** 75 seconds (2.5 missed server pings) without any inbound signal tears the
  socket down and reconnects. Reconnect backoff runs from 1 s to a 60 s ceiling; after the first
  three attempts only every tenth is logged, because Beeper Desktop simply being closed is the
  common case.
- **The socket asks the sweep to run early** on the three occasions frames could have been lost:
  a reconnect, a `seq` gap, and a recovery from an actionable `app.state`. The first connection of
  a process is not a reconnect and fires nothing.
- **It is never gated on `app.state`.** A live probe caught `initializing` reported for 105
  continuous seconds while every bridged account was connected and a chat page returned in
  230 ms. It is a display input for the status card, never a gate.
- The transport arms on the feature-plus-token gate alone, without the ingestion opt-in: holding
  the socket open writes nothing, and the liveness dot it feeds is precisely the surface a user
  needs while deciding whether to turn ingestion on. With the ingestion toggle off it connects,
  subscribes and relays invalidations, and writes no conversation or message body.

**The relay to the browser is invalidation-only.** `server/services/beeperSocketEvents.js` is a
leaf event bus; `socket.js` bridges it onto Socket.IO and broadcasts to the `beeper` subscriber
set — never `io.emit`, because the peer relay opens a Socket.IO client to every online peer and a
global emit would cross the wire to other installs. Frames carry ids, kinds and transport
liveness. They never carry message bodies, display names or handles; the browser refetches from
the PortOS mirror, which is the read path.

## Sending

There is exactly one send path and it is a human one, in two steps and two routes, mirroring the
email drafts surface: `POST /api/beeper/outbox` records the approved text, `POST /api/beeper/outbox/:id/send`
performs the POST to Beeper. No scheduler, no agent, no voice tool and no Chief-of-Staff tool
reaches either — `server/services/beeperOutboxHumanGate.test.js` asserts that structurally rather
than leaving it to convention. There is no AI drafting and no AI review anywhere on this path.

Four rules the outbox exists to enforce:

1. **The durable row is written before the POST**, so intent survives a crash between the click
   and the send. The `approved → sending` transition is a conditional UPDATE, so a double-click
   cannot double-post.
2. **A send is never retried automatically.** Beeper has no idempotency key, so a retry delivers
   a second real message. A transport failure leaves exactly one row in `failed`, with its code
   and message, and no second POST. Re-sending means composing a *new* row from a new human
   action; the failed one stays visible.
3. **Confirmation is a resolve, never a re-send.** The send answers only
   `{ chatID, pendingMessageID }`, so the row confirms on the relayed `message.upserted`
   invalidation, with a 30-second fallback to `GET /v1/chats/{chatID}/messages/{messageID}`.
   Neither path sends anything.
4. **A runaway breaker, not a rate quota.** Every send is one human click, so a quota paces
   someone already paced. The breaker catches the failure this design cannot otherwise see — a
   software loop: more than 10 sends in a rolling 60 seconds, or 3 consecutive failures. Only a
   human clears it (`POST /api/beeper/outbox/breaker/clear`); a breaker that clears itself is a
   delay, not a breaker.

**A restart mid-flight** is reconciled at boot, because `sending` and `awaiting-confirmation` are
exit-only through in-memory state (the pending map, its timer, the socket listener) and no route
can move a row out of either. `reconcileOutboxOnBoot()` runs once per server start from
`bootstrap.js`, regardless of whether the Beeper feature is armed — a stranded send is stranded
either way. A row left in `sending` becomes `failed` with `SEND_INTERRUPTED`, because the POST's
outcome is genuinely unknowable and rule 2 has no crash exception: nothing re-POSTs it, and the
user's recovery is the ordinary failed-row Retry, which composes a new row. A row left in
`awaiting-confirmation` has its lookup re-armed from the row's own `chat_id`, `pending_message_id`
and `body` — a resolve on both paths, never a send. Terminal rows are untouched, and a second call
finds nothing left to do.

**First contact** to a conversation is refused with a coded 409 unless `confirmFirstContact` is
explicitly true. The composer renders that inline, naming the network and the recipient — never
a `window.confirm`. Cancelling discards the row through `DELETE /api/beeper/outbox/:id`, which
only accepts a row still in `approved` (nothing has been POSTed for it, so this is a local record
removal, never an unsend); anything further along answers 409.

**What the composer shows.** Outbox rows render inline with the mirrored messages, filtered
against the fetched messages so a confirmed send appears exactly once — as the real mirrored
message — and never twice. A failed row offers **Retry**, which composes a brand-new entry with
the same text rather than resending the failed one. A row stranded in `approved` (most often
because the breaker was tripped when the send was attempted) offers **Retry**, which re-dispatches
that same row because nothing ever touched the wire for it, and **Dismiss**, which discards it.
Send is disabled and names the reason while the breaker is tripped; the breaker's own banner
stays in the settings drawer rather than appearing a second time on the chat surface.

## Purge and disconnect

`DELETE /api/beeper/conversations/:id` purges one conversation's mirror: messages, participants,
attachment rows, and the bytes those rows were holding — with the attachment reference check run
*first*, while the rows it checks against still exist, so a photo forwarded into three other
chats survives. The conversation row and its sync cursor go together in one transaction. It is
local only: Beeper still has the chat, and the next sweep will mirror it again. The client gates
it behind a typed confirmation naming the conversation and the byte count.

Disconnecting deletes the credential (revoking it first where possible) and disarms both the
sweep and the socket. It does not purge the mirror.

## Privacy model

The Beeper mirror holds full message bodies and attachment metadata from every connected network.
It is machine-local, and that is enforced structurally rather than by convention:

- **No `beeper` kind is exposed to peer-sync subscriptions**, no `beeper` wire-schema category is
  declared, no `beeper` dataSync snapshot category exists, and no `beeper_*` table carries the
  `sync_sequence` column that federation is built on.
- **`data/beeper/` never enters the media-library federation walk.** That walk is the other way
  `data/` bytes reach a peer — it walks whole directories rather than record kinds, so none of the
  schema or subscription guards above cover it.
- All of that is pinned by `server/services/sharing/beeperNeverFederates.test.js`, which asserts
  each list is still recognizably populated (so a collapsed list cannot satisfy an empty filter),
  and carries a bypass probe that plants violations to prove the predicates actually fire.
- Attachment bytes are served from an authenticated API route with a row-level check, never a
  static directory mount.
- The realtime relay is invalidation-only and broadcast to the Beeper subscriber set alone, so no
  message content reaches Socket.IO at all — let alone the peer relay.
- The access token is AES-256-GCM ciphertext in Postgres, exposed to any client as presence,
  expiry and provenance and never as a value.

**What leaves the machine:** requests to Beeper Desktop on loopback (or on the configured base
URL), and the one `POST` per message the user explicitly sends. **What never does:** the mirror,
its attachments, the token, and anything on the Socket.IO relay.

## API surface

24 routes under `/api/beeper`, all mounted from `server/routes/beeper.js`.

| Method | Route | What it does |
| --- | --- | --- |
| `GET` | `/api/beeper/status` | The status card's read model: token presence/expiry/provenance, a cached reachability probe, the account roster, realtime state, outbox breaker |
| `POST` | `/api/beeper/status/check` | Live uncached probe with a coded error per failure mode |
| `POST` | `/api/beeper/sync` | Run one watermark-bounded sweep now; a sweep already in flight reports `skipped: true` |
| `GET` | `/api/beeper/conversations` | Rail list for one scope (network, unread-only, archived, low-priority), cursor-paginated |
| `GET` | `/api/beeper/networks` | The rail's scope list, derived from the mirror |
| `GET` | `/api/beeper/conversations/:id` | One conversation with its mirrored participant subset; 404 at `severity: 'warning'` for a stale deep link |
| `GET` | `/api/beeper/conversations/:id/messages` | Cursor-paginated messages, newest first |
| `POST` | `/api/beeper/conversations/:id/archive` | Archive control — PATCHes Beeper first, mirrors the answer second |
| `POST` | `/api/beeper/conversations/:id/low-priority` | Low priority control, same shape |
| `DELETE` | `/api/beeper/conversations/:id` | Purge one conversation's local mirror and its bytes |
| `GET` | `/api/beeper/attachments/summary` | Counts, bytes and the budget picture the consent step and the card need |
| `POST` | `/api/beeper/attachments/backfill` | Bulk-mirror reference-only attachments, stopping at the budget |
| `GET` | `/api/beeper/attachments/:messageId/:idx` | The bytes, from disk, fetched on a miss |
| `POST` | `/api/beeper/attachments/:messageId/:idx/fetch` | "Fetch anyway" for an over-cap row, and the only retry of a refused one |
| `PATCH` | `/api/beeper/attachments/:messageId/:idx` | The per-attachment `keep` lock |
| `POST` | `/api/beeper/oauth/start` | Discover, dynamically register, mint the PKCE authorization URL |
| `GET` | `/api/beeper/oauth/callback` | Browser redirect target; exchanges the code server-side and redirects back to the tab |
| `POST` | `/api/beeper/token` | Store a pasted token after verifying it |
| `DELETE` | `/api/beeper/token` | Disconnect: revoke where possible, then delete locally |
| `GET` | `/api/beeper/outbox` | One conversation's outbox history, newest first |
| `POST` | `/api/beeper/outbox` | Step one — the durable row |
| `POST` | `/api/beeper/outbox/:id/send` | Step two — the send |
| `DELETE` | `/api/beeper/outbox/:id` | Discard an `approved` row; 409 on anything further along |
| `POST` | `/api/beeper/outbox/breaker/clear` | The runaway breaker's only reset |

Socket.IO events:

| Event | Direction | Payload |
| --- | --- | --- |
| `beeper:subscribe` | client → server | Join the Beeper broadcast set (re-emitted on every socket `connect`) |
| `beeper:unsubscribe` | client → server | Leave it |
| `beeper:invalidate` | server → Beeper subscribers | `{ kind, chatID, ids, seq, ts }` — ids and kinds only, never content |
| `beeper:realtime` | server → Beeper subscribers | The transport liveness snapshot: `state`, `lastEventAt`, `lastPingAt`, `reconnectAttempts`, `appState`, `appStateActionable`, `authRejected` |

Both surfaces publish as **generated** contract entries. `/api/beeper` appears in
`server/lib/apiRouteCatalog.generated.json` (24 operations) and in `docs/API.md`'s route-domain
index, and neither `server/lib/apiOperationContracts.js` nor
`server/lib/socketEventContracts.js` models any Beeper operation or event — so the catalog and
spec endpoints listed in [API_TOOL_CONTRACT.md](../API_TOOL_CONTRACT.md) report every one of them
with `contractStatus: "generated"` (path parameters and a default response, no richer modeled
contract).

## What is not verified live

Live probing of a real Beeper Desktop (4.3.89 on the most recent pass) established the
authorization-server metadata document, `/v1/info`'s advertised introspection endpoint, the
`POST /v1/assets/download` 200-with-`{error}` shape, the 502-on-missing-asset behaviour of
`GET`/`HEAD /v1/assets/serve`, `serve` sending no `Content-Type`, the `/v1/accounts` `bridge`
object shape, and a 105-second `app.state`/ping probe of `/v1/ws`. The following have **not**
been observed against a real instance, and rest on unit, route and component tests plus static
analysis:

- **The OAuth flow end to end.** Dynamic registration and the browser consent step have not been
  round-tripped; neither has a full `introspectToken` call through the `/v1/info` endpoint
  fallback. The origin validation is proven at the unit and route boundary, but the consent
  redirect actually landing back on the UI origin has not been re-run.
- **Realtime domain frames through the shipped transport.** The arming fix was built against
  mocked transports. A live socket receiving `message.upserted` / `chat.upserted` frames after an
  in-session connect (rather than after a server restart), and the reconnect and
  reconnect-attempt advance that follow, have not been watched.
- **A live send.** `POST /v1/chats/{chatID}/messages` through PortOS's own outbox, and the
  `message.upserted` confirmation frame that resolves the row, have never been exercised against
  a real Beeper Desktop.
- **The `HEAD /v1/assets/serve` pre-flight and byte fidelity.** Whether the instance reports a
  usable `Content-Length` on `HEAD`, and whether a mirrored file is byte-identical to the source,
  have not been checked. (The 502 behaviour on both methods has.)
- **The Low priority rail control's `PATCH /v1/chats/{chatID}`** against a live instance.
- **The in-flight image placeholder in a real browser.** jsdom cannot measure layout, so the
  tests pin the declared `aspect-ratio` and width, not the reserved box. Someone should watch a
  thread with an uncached image load in Chrome and confirm nothing reflows.
- **The conversation-not-found 404's `severity: 'warning'` path** was verified by the server
  suite and by static analysis of the socket and hook chain, not observed running.

## Files

- `server/services/beeperClient.js` — the HTTP client, pagination, error mapping, asset streaming
- `server/services/beeperOAuth.js`, `beeperCredentials.js` — connect, disconnect, the vault
- `server/services/beeperSync.js`, `beeperScheduler.js`, `beeperArming.js` — the sweep and its gates
- `server/services/beeperSocket.js`, `beeperSocketEvents.js` — the realtime transport and its bus
- `server/services/beeperConversations.js`, `beeperAttachments.js`, `beeperAttachmentGc.js` — the read model, the byte mirror, the housekeeping sweep
- `server/services/beeperOutbox.js`, `beeperStatus.js`, `beeperTribe.js` — sending, the status card, identity linking
- `server/lib/db/schema/beeper.js` — the eight `beeper_*` tables
- `server/routes/beeper.js` — every route above
- `client/src/components/messages/BeeperTab.jsx` and `components/messages/beeper/` — the chat surface, thread, composer, attachments, settings drawer
- `server/services/sharing/beeperNeverFederates.test.js` — the federation guard
