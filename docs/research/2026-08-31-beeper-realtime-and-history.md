# Beeper: real-time delivery and history backfill

Date: 2026-08-31 · Resolves wayfinder research ticket #3 (part of #1)

> Note on placement: `docs/research/README.md` documents a flat
> `YYYY-MM-DD-<slug>.md` convention. This file sits in a `beeper/` subdirectory
> so the eleven Beeper research notes stay grouped. Same point-in-time contract:
> it records what was true at the versions cited and is not maintained after.

## Verdict

**The PortOS chat surface can be event-driven, but it must be event-driven *plus*
a reconciliation pass — it cannot be event-only.** Beeper states outright that
WebSocket delivery is at-most-once with no replay on reconnect, and it documents
a second drop condition where an event is skipped if the message is not yet
retrievable. So the WebSocket is a *latency* mechanism, not a *completeness*
mechanism. Correctness has to come from HTTP refetch: on connect, on every
reconnect, and on a slow background sweep.

Polling alone is a viable degraded mode and needs no special permission — Beeper
says read operations are local and unmetered — but polling alone gives a chat
client seconds-scale latency, so it belongs behind the WebSocket, not instead of it.

The honest-UI requirement is real and unavoidable. Beeper's own numbers show
history depth is per-network and often shallow (Discord: **5 DMs × 50 messages,
zero server-channel history**; Google Messages: 25 chats × 50 messages), keeps
filling in for hours or days after connect, and for at least one network is
*worse* on an on-device bridge than on Beeper Cloud. PortOS must not present a
Beeper thread as a complete conversation.

---

## 1. What version this describes

Two first-party surfaces disagree slightly, and both matter:

- The published Desktop API changelog's latest entry is **v4.2.808 (2026-05-06)**
  ([changelog](https://developers.beeper.com/desktop-api/changelog)).
- The OpenAPI spec that Beeper's own SDK repos are generated from declares
  `info.version: 5.0.0`, is titled **"Beeper Client API"**, and says it is
  "served by Beeper Desktop **and Beeper Server**" — i.e. a headless variant
  exists ahead of the public changelog. Spec URL is pinned in
  [`.stats.yml`](https://github.com/beeper/desktop-api-go/blob/main/.stats.yml)
  in each SDK repo.

Two spec revisions are in play. The one pinned by the Go SDK (56 endpoints) is
newer than the one pinned by the JS/Python SDKs (30 endpoints) and adds the
`app.state.updated` event and the bridges/setup surface. **Quotes below are from
the 56-endpoint spec unless noted.**

Practical consequence: version-gate. Every response carries
`X-Beeper-Desktop-Version`, `GET /v1/info` exposes `endpoints.spec` (the running
install serves its own OpenAPI document) and `endpoints.ws_events` (the WS URL),
and the spec uses an `x-beeper-available-since` extension on newer fields
(e.g. `AccountBridge` is marked "Available in Beeper Desktop v4.2.785+").
PortOS should read `/v1/info` at feature-detection time rather than hardcoding
`ws://localhost:23373/v1/ws`.

---

## 2. Real-time: the experimental WebSocket

### 2.1 Endpoint and auth

`ws://localhost:23373/v1/ws`, same `Authorization: Bearer <token>` as HTTP, sent
on the upgrade request.
([WebSocket docs](https://developers.beeper.com/desktop-api/websocket-experimental))

The spec is explicit about the browser constraint:

> Connect to `/v1/ws` with the same Bearer token in the upgrade request. Browser
> `new WebSocket()` clients are not supported yet because browsers cannot set the
> Authorization header.
> — 30-endpoint spec, `info.description`. The 56-endpoint revision softens this
> to "Use a WebSocket client that can send the Authorization header."

Combined with the fact that the API binds to localhost and **"CORS headers also
limit access to the local machine"**
([Remote Access](https://developers.beeper.com/desktop-api/advanced/remote-access)),
this settles the PortOS topology: **the PortOS Express server owns the Beeper
connection; the React client never talks to Beeper directly.** Beeper events get
relayed to the browser over PortOS's existing Socket.IO channel. That is the same
shape as other single-subscriber resources in PortOS — see the `portos-socket-ui`
skill.

The page is banner-marked **experimental** and "may change between desktop
releases", and `/v1/ws` is **not a documented path in the OpenAPI spec at all** —
it exists only in `info.description` plus the `WS*` component schemas. So it is
outside the generated-SDK contract and outside whatever stability the REST
endpoints carry.

### 2.2 No SDK support — you write the client yourself

There is no WebSocket helper in any official SDK. The TypeScript SDK
([beeper/desktop-api-js](https://github.com/beeper/desktop-api-js)) is
Stainless-generated REST only; its file tree contains no ws/socket/event module,
and a code search for `websocket` in that repo returns zero hits. Same for the
`.stats.yml`-pinned specs across the Go/Python/PHP SDKs — the WS is spec'd as
message *schemas*, never as an operation, so no generator emits a client.

PortOS therefore supplies its own `ws` client, its own reconnect loop, and its
own reconciliation. Budget for that; it is not a two-line SDK subscribe.

### 2.3 Subscription model

One command, `subscriptions.set`, which **fully replaces** current state:

```json
{ "type": "subscriptions.set", "requestID": "r1", "chatIDs": ["*"] }
```

- `["*"]` = all chats. Specific IDs = only those chats. `[]` = pause events.
- `"*"` cannot be mixed with specific chat IDs (rejected with
  `code: "INVALID_PAYLOAD"`).
- **Initial subscription state is empty.** Nothing streams until you subscribe.
- The newer spec adds an `app` field: `{"type":"subscriptions.set","chatIDs":["*"],"app":{"state":true}}`
  additionally subscribes to app/setup state.

Handshake: server sends `ready` → client sends `subscriptions.set` → server
replies `subscriptions.updated` → domain events stream.

### 2.4 Event shapes

Control frames (`WSReadyMessage`, `WSSubscriptionsUpdatedMessage`, `WSErrorMessage`):

```json
{ "type": "ready", "version": 1, "chatIDs": [], "app": { "state": false } }
{ "type": "subscriptions.updated", "requestID": "r2", "chatIDs": ["<chat-id>"] }
{ "type": "error", "requestID": "r2", "code": "INVALID_PAYLOAD", "message": "..." }
```

`error.code` enum: `INVALID_COMMAND | INVALID_PAYLOAD | NOT_SUBSCRIBED | INTERNAL_ERROR`.

Domain frames (`WSDomainEventMessage`) — one flat shape for all four events:

```json
{
  "type": "message.upserted",
  "seq": 42,
  "ts": "2026-05-06T20:20:12.497Z",
  "chatID": "<chat-id>",
  "ids": ["<message-id>"],
  "entries": [{ "id": "<message-id>", "reactions": [] }]
}
```

Required: `type`, `seq`, `ts`, `chatID`, `ids`. Optional: `entries`.
`additionalProperties: false` on every WS schema.

Event names: `chat.upserted`, `chat.deleted`, `message.upserted`,
`message.deleted` — plus `app.state.updated` in the newer spec, whose
`appState.state` enum is
`needs-login | initializing | needs-cross-signing-setup | needs-verification | needs-secrets | needs-first-sync | ready`.

Semantics the docs spell out:

- Both upsert **and update** sync mutations arrive as `<resource>.upserted`.
  There is no distinct "edited" event — an edit is an upsert, and the payload's
  `editedTimestamp` is what distinguishes it.
- Deletions arrive as `<resource>.deleted`, **IDs-only, no `entries`**. So a
  delete requires a local lookup by ID; you cannot render it from the frame.
- `message.upserted` entries are "hydrated from the local message endpoint before
  emission", so `entries` "will usually include a full message payload (including
  attachments when available)."

**A schema/example mismatch to code around:** the WebSocket doc page shows
`"ts": 1739320000000` (epoch milliseconds), while `WSDomainEventMessage.ts` in
the OpenAPI spec is `{"type":"string","format":"date-time"}`. Parse defensively —
accept both a number and an ISO string.

### 2.5 Does it cover outbound?

**Yes, explicitly.** From `info.description` under Conventions:

> Sends return a `pendingMessageID`; resolve it with
> `GET /v1/chats/{chatID}/messages/{messageID}` **or wait for `message.upserted`
> over the WebSocket**.

So a PortOS-originated send produces a `message.upserted` like any other message,
and `Message.isSender` (`"True if the authenticated user sent the message"`)
identifies it. Messages the user sends from Beeper Desktop, their phone, or any
other client land the same way — Beeper is bridging one shared conversation
state, not a per-client feed.

Two implications for the composer:

1. `POST /v1/chats/{chatID}/messages` returns a **`pendingMessageID`**, not a
   final message ID (established in v4.1.210). The optimistic bubble must be keyed
   on that and reconciled when the real message arrives, either by the WS event or
   by `GET .../messages/{messageID}`.
2. `Message.sendStatus.status` is
   `SUCCESS | PENDING | FAIL_RETRIABLE | FAIL_PERMANENT`, with `reason` and
   `message`. A send that fails at the network is reported here, arriving as a
   later `message.upserted` — the UI needs a failed state, not just sent/unsent.

### 2.6 Can events be missed? Yes, three documented ways

This is the load-bearing paragraph in the whole ticket. From `info.description`:

> **Delivery is at-most-once. There is no replay on reconnect, and `seq` is per
> connection. Refetch via HTTP after a disconnect to reconcile drift.** Initial
> subscription state is empty; `subscriptions.set` replaces previous state;
> `["*"]` cannot be combined with specific chat IDs.

The three loss paths:

1. **Disconnect.** Anything that happened while disconnected is gone. No replay,
   no resume token, no "since seq" parameter. `seq` resets per connection, so it
   detects a gap *within* one connection but is useless across connections.
2. **Hydration failure.** From the WS doc page: *"If the message is not yet
   retrievable, the event is skipped."* A message that exists but is not yet
   readable via the local message endpoint at emission time produces **no event at
   all** — not a degraded one. Nothing later re-emits it.
3. **Not subscribed yet.** Subscriptions start empty and are replaced wholesale,
   so the window between connect and `subscriptions.updated`, and any window
   during a re-`set`, is dark.

There is also **no documented ping/pong, heartbeat, or idle timeout**, so a
half-open TCP connection can look alive indefinitely. PortOS must impose its own
liveness check — an application-level watchdog (no domain event *and* no frame
within N seconds → tear down and reconnect), since the protocol offers no keepalive
to lean on.

### 2.7 Reconnect protocol PortOS has to implement

None of this is provided; all of it is required:

1. Connect with the Bearer token; wait for `ready`.
2. `subscriptions.set` with `["*"]` (or the tracked chat set); wait for
   `subscriptions.updated`.
3. Track `seq` per connection. A gap means events were dropped mid-connection →
   trigger reconciliation.
4. On every disconnect, reconnect with jittered backoff, and on success run a
   **reconciliation sweep** before trusting the stream again: page
   `GET /v1/chats` (sorted by last activity) and, for every chat whose
   `lastActivity` is newer than the stored watermark, page
   `GET /v1/chats/{chatID}/messages` forward with `direction=after` from the
   stored cursor.
5. Persist the per-chat cursor and the last-seen `lastActivity`, since the
   watermark is what survives a PortOS restart — the WS gives you nothing.

---

## 3. Polling fallback

### 3.1 What interval the API tolerates

**Beeper publishes no numeric rate limit and no interval guidance.** What it does
publish is a policy statement that reads permissively for reads
([Desktop API overview](https://developers.beeper.com/desktop-api/)):

> We recommend Beeper Desktop API for personal use only. Sending too many
> messages might result in account suspension by the networks.
> **Actions like searching or fetching existing chats or messages are always local
> and can be used without limitations.**

So the suspension risk is on *sends*, not reads, and reads never leave the
machine. Against that:

- Every operation in the spec declares a **429 `TooManyRequests`** response
  ("Too many requests - rate limit exceeded"). No `Retry-After` header is declared
  on it and no quota is documented. Treat 429 as a shape that exists rather than a
  limit you can predict — handle it with backoff, do not design around a number.
- The MCP server's default instructions note **"Individual HTTP requests to the
  API have a 30-second timeout"**
  ([instructions.ts](https://github.com/beeper/desktop-api-js/blob/main/packages/mcp-server/src/instructions.ts)),
  which is the only concrete timing figure Beeper publishes.

Verdict: a **5–15 second** poll of `GET /v1/chats` is well inside anything
suggested by the docs, and even 1–2s is defensible for a single local user given
the "without limitations" language. It is still local CPU on the user's machine
against an Electron app, so prefer the low-frequency end and let the WebSocket
carry the latency.

### 3.2 The cheapest correct poll

`GET /v1/chats` is the right primitive: *"List all chats sorted by last activity
(most recent first). Combines all accounts into a single paginated list."* Each
`Chat` carries `lastActivity` (ISO 8601), `unreadCount`, `lastReadMessageSortKey`,
and a `preview` holding the last message. So:

1. Poll page 1 of `GET /v1/chats`.
2. Stop paging as soon as `lastActivity <= storedWatermark` — the sort order makes
   this a bounded scan, usually one page.
3. For each newer chat, page `GET /v1/chats/{chatID}/messages?cursor=<stored>&direction=after`.

Pagination facts that constrain the design:

- `GET /v1/chats` and `GET /v1/chats/{chatID}/messages` take **only `cursor` and
  `direction`** (plus `accountIDs` on chats). **There is no `limit` parameter** —
  page size is server-chosen and undocumented.
- Both return `hasMore`, plus `oldestCursor` and `newestCursor`
  (added in v4.2.808). Cursors are opaque; do not parse them.
- `GET /v1/messages/search` is the filterable endpoint — `dateAfter`, `dateBefore`,
  `sender` (`me`/`others`/user ID), `chatIDs`, `accountIDs`, `mediaTypes`,
  `chatType` — but its `limit` is **capped at 20** (default 20). Good for targeted
  backfill reconciliation, bad as a firehose. Search is **literal keyword matching,
  not semantic**, per Beeper's own MCP instructions.
- `GET /v1/chats/search` allows `limit` 1–200, default 50.

---

## 4. History depth: how far back a client can actually read

### 4.1 The warning, verbatim

From the Desktop API overview's Limitations callout:

> Message history might be limited. Beeper indexes your messages from the networks
> in the background, when you first add an account, only recent messages might be
> available. **For best results, prefer using On-Device Connections instead of
> Beeper Cloud when connecting accounts.**
> iMessage is only supported on macOS.

The Desktop API surfaces whatever the local store holds. It does not fetch from
the network on demand, so **API history depth is exactly bridge import depth**.
There is no "load more from the network" call.

### 4.2 It varies enormously per network

Beeper publishes the numbers
([Chat Network History Import](https://help.beeper.com/en_US/chat-networks/history-import)):

| Network | Imported? | Initial history imported |
|---|---|---|
| WhatsApp | Yes | 1 year for all chats (sometimes up to 3 years) |
| Instagram | Normal chats yes; **E2EE chats no** | 20 most recent conversations, 100 messages each |
| Twitter/X | Yes | **On-Device Bridge: 20 most recent conversations. Cloud Bridge: all history** |
| Google Chat | **No** | — |
| LinkedIn | **No** | — |
| Facebook Messenger | Normal chats yes; **E2EE chats no** | 20 most recent conversations, 100 messages each |
| Signal | Yes | All history — *only if* "import all history" is chosen during link-a-device |
| Telegram | Yes | All history in DMs and minigroups; 1000 messages in supergroups; 100 in channels. Chats >10K members unsupported |
| Discord | Yes | 5 most recent DMs, 50 messages each; **none in server channels** |
| Slack | Yes | All history in DMs (1:1 and group); 1000 messages in channels |
| Google Messages | Yes | 25 most recent conversations, 50 messages each |
| Google Voice | Yes | 20 most recent conversations, most recent messages in chat |
| iMessage (macOS only) | Yes | All history |

Discord is the sharpest case and has its own article
([Discord channel backfill behavior](https://help.beeper.com/en_US/chat-networks/discord-channel-backfill-behavior-in-beeper)):
server channels are **listed and sendable but carry zero history**. A PortOS
thread view for a Discord server channel will legitimately be empty while the chat
is perfectly functional. That must not read as a bug or an error state.

### 4.3 On-device bridge vs Beeper Cloud

They differ, and **the Desktop API doc's blanket "prefer On-Device Connections"
is not right for history depth on every network.** The one network where Beeper
publishes both numbers is Twitter/X, and it goes the other way: on-device gets the
20 most recent conversations, Cloud gets *all history*. On-device is the better
advice for privacy and for API/bridge freshness; for history depth it is
network-by-network and the published data does not support a general rule.

The good news is that it is **machine-readable per account**. `Account.bridge`
(`AccountBridge`, available Beeper Desktop v4.2.785+) carries:

- `provider`: `cloud | self-hosted | local | platform-sdk`
- `id`: cloud accounts use the network type (e.g. `matrix`, `discordgo`);
  on-device accounts use a local bridge ID (e.g. `local-whatsapp`)
- `type`: `matrix`, `discordgo`, `slackgo`, `whatsapp`, `telegram`, `twitter`, …

So PortOS can render an accurate per-account history caveat — network **and**
provider — rather than one generic disclaimer.

---

## 5. Backfill: does history keep filling in, and how would we know?

### 5.1 Yes, it keeps filling in — for two different reasons

**Queued sequential import.** For Instagram and Messenger, Beeper documents:
*"Outside of the 20 most recent chats, once a new message is sent or received in a
chat, the history import process is queued. All chats continue to import history
sequentially in a queue, 100 messages at a time until fully imported."* Google
Messages: *"Older chats will backfill 50 messages after receiving a new message in
that thread."*

So depth is not a fixed number measured at first connect. It grows over hours or
days, and it grows *reactively* — a chat that has been quiet gets deeper history
only once it receives a new message.

**Mechanism, for context.** Beeper's bridges are mautrix-family, and the
[mautrix backfill documentation](https://docs.mau.fi/bridges/general/backfill.html)
explains the constraint that shapes all of this:

> Matrix doesn't give bridges any way to actually insert messages into the room
> history, which means backfilled messages always appear at the "end" of the room,
> even if their timestamps say they're older. In other words, historical message
> backfill only works in new empty rooms.

That page is written for self-hosted mautrix bridges rather than Beeper Desktop's
on-device bridges specifically, so treat it as mechanism, not as a Desktop API
contract. It also documents that WhatsApp history arrives as a one-time "history
sync" blob from the phone that cannot be re-requested, and that Signal's history
transfer is a one-shot at link time whose media only works for the past 45 days.
Both explain why re-linking an account is destructive to history and why depth
cannot be topped up on demand.

### 5.2 How a client detects new-old messages appearing

Three signals, in descending order of confidence:

**1. `Account.status === "backfilling"` — documented, reliable, use this.**
The `Account.status` enum is
`connected | connecting | backfilling | connection_required | reconnect_required | attention_required | disconnected | disabled`,
with a human-readable `statusText`. Poll `GET /v1/accounts` (it is cheap and
local) and while any account reports `backfilling`, PortOS knows history is
actively growing and should say so in the UI. This is the single best honest-UI
hook available, and it costs one request.

**2. `Message.sortKey` vs `Message.timestamp` — the likely detection primitive,
but verify it.** Every `Message` carries both a `timestamp` (ISO 8601, the real
send time) and a `sortKey` ("A unique, sortable key used to sort messages",
example values `"821744079"`, `"455171049984"` — monotonic-looking integers as
strings). `Chat.lastReadMessageSortKey` uses the same space. Given the Matrix
mechanism above — backfilled messages land at the *end* of the room with massaged
timestamps — a backfilled old message should carry an **old `timestamp` but a new
`sortKey`**. If that holds, then paging `direction=after` from a stored *cursor*
surfaces backfilled history as it arrives, whereas filtering on `timestamp`
(e.g. `messages/search?dateAfter=`) would silently miss it.

  **This is inference, not documentation, and it is the highest-value thing to
  confirm on a live instance.** The API says list messages is "sorted by
  timestamp", which does not settle what the cursor walks. Two facts to establish
  in the prototype ticket: (a) does `direction=after` paging return newly
  backfilled old messages, and (b) does a backfilled old message emit a
  `message.upserted` WebSocket event? The docs say "both upsert and update sync
  mutations are delivered as `<resource>.upserted`", which suggests yes, but a
  backfill write is never named as such and there is no `backfill` event type.

**3. A periodic deep sweep — the fallback that works regardless.** Because 1 and 2
are respectively coarse and unverified, PortOS should also re-walk each chat
backward from `oldestCursor` on a slow schedule (or on user request, as a
"check for older messages" affordance), and treat any message ID it has not seen
as new-old. This is the only strategy that requires no assumption about ordering
semantics.

### 5.3 App-level readiness

The newer spec's `app.state.updated` event (subscribe with `app: {state: true}`)
reports `state: needs-first-sync` before `ready`, and `appState.e2ee.firstSyncDone`
("Whether the first encrypted message sync is complete"). Where available, this
distinguishes "Beeper is still coming up" from "history is genuinely absent" —
worth wiring, gated on the field existing, since it is only in the newer spec
revision.

---

## 6. Consequences for the PortOS Beeper integration

1. **Server-owned WebSocket, Socket.IO relay to the client.** Browsers cannot set
   the Authorization header on `new WebSocket()` and CORS is locked to the local
   machine. The Express server holds exactly one Beeper WS connection —
   a single-subscriber resource in the `portos-socket-ui` sense.
2. **Every PortOS-stored message needs a durable watermark**: per-chat
   `newestCursor` plus `lastActivity`. The WS provides no resumption, so the
   watermark is the only thing that survives a restart.
3. **Reconciliation on connect, on reconnect, and on a timer** is not optional —
   Beeper's own spec instructs "Refetch via HTTP after a disconnect to reconcile
   drift."
4. **Poll `GET /v1/accounts` alongside.** It is the `backfilling` signal and the
   `bridge.provider` signal in one cheap call.
5. **The composer is three-state.** `pendingMessageID` → reconciled real message →
   `sendStatus` (which can be `FAIL_RETRIABLE`/`FAIL_PERMANENT` arriving later).
6. **The UI must be honest per chat, not globally.** "History from Beeper may be
   incomplete" is derivable from `Chat.network` + `Account.bridge.provider` +
   `Account.status`, and the numbers in §4.2 make some cases (Discord server
   channels, LinkedIn, Google Chat) categorically empty rather than merely
   shallow. An empty Beeper thread is frequently correct.
7. **Version-gate on `/v1/info` and `X-Beeper-Desktop-Version`**, not on assumed
   endpoints. The WS is experimental and outside the OpenAPI operation contract;
   `AccountBridge` needs v4.2.785+; `app.state.updated` only exists in the newer
   spec revision.
8. **Persisting full message bodies locally (map issue #1, settled item 7) is the
   right call and this research strengthens it.** Beeper's own store is partial,
   reactively backfilled, and destroyed by re-linking an account. A PortOS mirror
   is the only durable copy — which makes the machine-local, never-federated
   constraint even more load-bearing.

---

## 7. Open questions this research could not close from documentation

Each needs a live instance; they belong in the prototype ticket, not in a spec
assumption.

1. Does a **backfilled** (old) message emit `message.upserted`, or does it only
   appear on refetch? Undocumented.
2. Does `sortKey` order by arrival (so `direction=after` surfaces backfill) or by
   timestamp (so it does not)? Inference in §5.2 is untested.
3. Actual **page size** of `GET /v1/chats/{chatID}/messages` — no `limit`
   parameter exists and the default is undocumented.
4. Any real **429 threshold** for local reads, and whether a `Retry-After` header
   is sent. The spec declares the response but no quota.
5. Whether the WS sends any **ping/pong or idle timeout**, and how it behaves when
   Beeper Desktop is quit or the machine sleeps.
6. Whether events fire for chats added *after* `subscriptions.set(["*"])` — i.e.
   whether `"*"` is evaluated live or snapshot at subscribe time.
7. `ts` wire type on domain events (epoch ms per the doc example vs ISO 8601 per
   the schema).

---

## Sources

Beeper Desktop API documentation:

- <https://developers.beeper.com/desktop-api/> — overview, Limitations callout ("Message history might be limited…", "prefer On-Device Connections"), personal-use / "without limitations" policy
- <https://developers.beeper.com/desktop-api/websocket-experimental> — subscription model, control messages, domain event shape, event names, hydration-skip behavior
- <https://developers.beeper.com/desktop-api/auth> — Bearer token, OAuth PKCE, `GET /v1/info`, `POST /oauth/introspect`
- <https://developers.beeper.com/desktop-api/advanced/remote-access> — localhost binding, CORS restriction
- <https://developers.beeper.com/desktop-api/changelog> — v4.2.808 (cursors, richer message metadata), v4.2.557 (`GET /v1/ws`, `GET /v1/info`), v4.1.294 (v0→v1, search caps), v4.1.210 (`pendingMessageID`)
- <https://developers.beeper.com/desktop-api/changelog/2> — v4.1.92 initial release
- <https://developers.beeper.com/desktop-api-reference/resources/messages/methods/list> — `Message` schema, cursor/direction params, `oldestCursor`/`newestCursor`, `sortKey`, `sendStatus`
- <https://developers.beeper.com/desktop-api-reference/resources/messages/methods/search> — `dateAfter`/`dateBefore`/`sender`/`limit`
- <https://developers.beeper.com/desktop-api-reference/resources/chats/methods/list> — chats sorted by last activity, `preview`
- <https://developers.beeper.com/llms-full.txt> — full docs corpus used for verbatim quotes

OpenAPI specs (first-party, pinned by Beeper's own SDK repos):

- <https://github.com/beeper/desktop-api-go/blob/main/.stats.yml> → <https://storage.googleapis.com/stainless-sdk-openapi-specs/beeper/beeper-desktop-api-baac187842e51587134950c59c4d746bfcb59239f01919ed83b92c24c47d98f4.yml> — 56 endpoints, `info.version` 5.0.0, WebSocket at-most-once statement, `WS*` schemas, `Account.status` enum, `AccountBridge.provider`, `app.state.updated`, `ConnectInfoOutput`
- <https://github.com/beeper/desktop-api-js/blob/main/.stats.yml> → <https://storage.googleapis.com/stainless-sdk-openapi-specs/beeper/beeper-desktop-api-c08c14bb754b4cb0e02b21fabb680469368286be339dec0aaa8c69d04a1f021a.yml> — 30 endpoints, browser-`new WebSocket()`-unsupported statement

Official SDK source:

- <https://github.com/beeper/desktop-api-js> — TypeScript SDK; no WebSocket module in the tree, zero code-search hits for `websocket`
- <https://github.com/beeper/desktop-api-js/blob/main/packages/mcp-server/src/instructions.ts> — 30-second per-request timeout, "Message search is literal keyword matching, not semantic search"

Beeper first-party help documentation (history depth):

- <https://help.beeper.com/en_US/chat-networks/history-import> — per-network history import table, on-device vs cloud split for Twitter/X
- <https://help.beeper.com/en_US/chat-networks/discord-channel-backfill-behavior-in-beeper> — Discord server channels carry no history
- <https://help.beeper.com/en_US/chat-networks/google-messages-getting-started-guide> — "Older chats will backfill 50 messages after receiving a new message in that thread"

Bridge mechanism (mautrix, the bridge family Beeper develops):

- <https://docs.mau.fi/bridges/general/backfill.html> — timestamp massaging, backfilled messages land at the end of the room, WhatsApp history-sync blobs, Signal one-shot history transfer
