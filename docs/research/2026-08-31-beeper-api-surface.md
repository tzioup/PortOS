# Beeper Desktop API: the surface a chat client has to build against

Date: 2026-08-31 · Resolves wayfinder research ticket [#2](https://github.com/tzioup/PortOS/issues/2) (part of [#1](https://github.com/tzioup/PortOS/issues/1))

> Point-in-time record, per `docs/research/README.md`: it captures what was true at the
> versions cited and is not maintained afterward.

## Verdict

**The API is rich enough to build a real chat client on, and precise enough to design a store against — but not through the official TypeScript SDK alone.**

Three findings change how the implementation tickets should be written:

1. **The published SDK is behind the live API, and the gap is exactly where #1 needs it most.** `@beeper/desktop-api@5.0.0` has no `Account.status`, no `Account.loginID`, no `Account.statusText`, and no `/v1/bridges` resource at all. The live server ships every one of them. Connection state — the whole "what happens when a bridge is disconnected" question — is **invisible to a pure-SDK client**. PortOS needs raw `fetch` for at least the account/bridge health surface.
2. **The two primary read endpoints have no `limit` parameter.** `GET /v1/chats` and `GET /v1/chats/{chatID}/messages` accept only `cursor` and `direction`. Page size is server-chosen and undocumented. A conversation list and a thread view cannot request a page size; they can only walk cursors.
3. **`DELETE /v1/chats/{chatID}/messages/{messageID}` defaults `forEveryone` to `true`.** Omitting the parameter unsends for every participant on networks that support it. Any PortOS delete path must pass the flag explicitly.

Two smaller ones worth carrying into the store design: sends are **asynchronous** and return only a `pendingMessageID`, so the store needs a pending/optimistic lane keyed on that ID; and **overwriting a non-empty draft is a two-call sequence** (`PATCH {draft: null}` then `PATCH {draft: {...}}`).

## 1. What this describes, and how it was verified

| Artifact | Version | How read |
|---|---|---|
| Beeper Desktop (running locally) | **4.3.73** (`com.automattic.beeper.desktop`) | `GET /v1/info`, unauthenticated |
| OpenAPI spec (**authoritative**) | **`Beeper Client API` 5.0.0**, OpenAPI 3.1.0 | fetched live from `GET /v1/spec` |
| TypeScript SDK | `@beeper/desktop-api@5.0.0` (published 2026-05-07, `latest`) | npm tarball, shipped `.d.ts` + `api.md` |
| Docs site | as of 2026-08-31 | `developers.beeper.com`, markdown twins at `<url>/index.md` |

**There is no publicly downloadable OpenAPI spec.** Every `openapi.json` / `openapi.yml` path on the docs site 404s. The spec exists only at the runtime URL that `GET /v1/info` advertises as `endpoints.spec` (`/v1/spec` on this build). Codegen against Beeper therefore requires a running instance — worth knowing before anyone proposes a generated client in CI.

Where the spec and the docs disagree, this note follows the spec.

## 2. Discovery and enablement

`GET /v1/info` is the discovery call. It is the **only unauthenticated endpoint** — the spec marks the whole API `security: [{bearerAuth: []}]`, and the SDK confirms it by passing `__security: {}` on this one route (`resources/info.js`). Live response, structure intact, values as returned by a default install:

```json
{
  "app": { "name": "Beeper", "version": "4.3.73", "bundle_id": "com.automattic.beeper.desktop" },
  "platform": { "os": "darwin", "arch": "arm64", "release": "v24.14.0" },
  "server": {
    "status": "running", "base_url": "http://127.0.0.1:23373", "port": 23373,
    "hostname": "127.0.0.1", "remote_access": false, "mcp_enabled": true
  },
  "endpoints": {
    "oauth": {
      "authorization_endpoint": "http://127.0.0.1:23373/oauth/authorize",
      "token_endpoint":         "http://127.0.0.1:23373/oauth/token",
      "introspection_endpoint": "http://127.0.0.1:23373/oauth/introspect",
      "userinfo_endpoint":      "http://127.0.0.1:23373/oauth/userinfo",
      "revocation_endpoint":    "http://127.0.0.1:23373/oauth/revoke",
      "registration_endpoint":  "http://127.0.0.1:23373/oauth/register"
    },
    "spec": "http://127.0.0.1:23373/v1/spec",
    "mcp":  "http://127.0.0.1:23373/v0/mcp",
    "ws_events": "http://127.0.0.1:23373/v1/ws"
  }
}
```

- **Default port 23373**, plain **HTTP**, loopback. Docs write `localhost`; the server reports `127.0.0.1`. Prefer `127.0.0.1` for probes — on a dual-stack host `localhost` can resolve to `::1` first.
- **Binding.** Loopback only by default, with CORS headers also restricted to the local machine. Settings → Integrations → Advanced enables Remote Access, which rebinds `0.0.0.0` and derives the base URL from `X-Forwarded-Host` / `X-Forwarded-Proto`.
- **Custom port.** Confirmed to exist ("or the custom port you set") but **the docs never say where the setting lives**, and there is no documented discovery mechanism — you must already know the port to call `/v1/info`. For PortOS's instance-feature auto-detection this means: probe `127.0.0.1:23373/v1/info` as the default, and expose a configurable port override rather than trying to discover one.
- **Availability.** Stable channel since Beeper Desktop v4.1.169 (2025-09-02); no beta/nightly requirement. iMessage support is macOS-only.
- **Version floors that matter:** `Account.bridge` needs v4.2.785+; `POST /v1/chats/start` needs v4.2.808+. Authenticated responses carry `X-Beeper-Desktop-Version`, which is the cheapest capability probe.

### Beeper Desktop is no longer strictly required

The spec's own description says the API is "served by Beeper Desktop **and Beeper Server**". That is primary-source confirmation of what ticket [#3/#4 research](./open-source-and-bridges.md) found independently, and it softens the assumption in #1 that "it requires Beeper Desktop to be running". PortOS should detect *the API*, not *the desktop app*.

## 3. Authentication

### The path that actually works: an in-app token

Settings → Integrations → **Approved connections** → **+**, then follow the prompts. This is the documented default and the only path the docs fully specify. Every request then carries:

```
Authorization: Bearer <token>
```

### OAuth 2.0, from the server's own metadata

`GET /.well-known/oauth-authorization-server` is unauthenticated and returns RFC 8414 metadata. Live, from this install:

```json
{
  "issuer": "http://127.0.0.1:23373",
  "authorization_endpoint": "http://127.0.0.1:23373/oauth/authorize",
  "token_endpoint": "http://127.0.0.1:23373/oauth/token",
  "revocation_endpoint": "http://127.0.0.1:23373/oauth/revoke",
  "userinfo_endpoint": "http://127.0.0.1:23373/oauth/userinfo",
  "registration_endpoint": "http://127.0.0.1:23373/oauth/register",
  "grant_types_supported": ["authorization_code"],
  "token_endpoint_auth_methods_supported": ["none"],
  "response_types_supported": ["code"],
  "scopes_supported": ["read", "write"],
  "code_challenge_methods_supported": ["S256"],
  "service_documentation": "http://127.0.0.1:23373/v1/spec"
}
```

Read off that: **public client, authorization-code + PKCE `S256`, two scopes (`read`, `write`), dynamic client registration available** at `/oauth/register`. The spec's `securitySchemes.oauth2` names the scopes — `read`: "Read access to messages, chats, and accounts"; `write`: "Send messages, edit messages, react to messages, archive chats, and set reminders".

**`grant_types_supported` contains only `authorization_code`. There is no `refresh_token` grant.** So there is no refresh flow to implement — when a token stops working, the only recovery is re-running the authorization flow or pasting a new in-app token.

### Token lifetime — the one genuine gap

Nothing in the docs or the spec states a token lifetime, and there is no `expires_in` documented on the token response. The only signal is `GET /oauth/userinfo` (deprecated), whose `exp` field is **optional** while `iat` and `scope` are required — consistent with tokens that need not expire, but that is inference, not a documented guarantee. `POST /oauth/introspect` (`application/x-www-form-urlencoded`, body `token=<token>&token_type_hint=access_token`) returns `{"active": true|false}` plus metadata and is the correct liveness probe.

**Design consequence for PortOS:** treat the token as opaque and indefinite, verify it with `/oauth/introspect` or a cheap authenticated call on boot, and handle `401` as "re-authorize", never as "refresh". Behaviour across a Beeper Desktop restart or user sign-out is **undocumented** — an integration test on a real install is the only way to settle it.

### SDK caveat

**The SDK ships no OAuth helper at all** — no authorization-URL builder, no PKCE helper, no token exchange, no refresh. Its custom-code directory (`src/lib/`) contains only a `.keep`. The client's only auth surface is a static bearer token from the `accessToken` option or the `BEEPER_ACCESS_TOKEN` environment variable.

## 4. The data model

Field lists below are from the live spec's `components.schemas`. **Required** means required by the spec; everything else may be absent.

### Account

```
Account                       required: accountID, bridge, user, status
  accountID    string         route key for account-scoped actions.
                              e.g. "matrix", "discordgo", "slackgo.TEAM-USER",
                                   "local-whatsapp_ba_<fingerprint>"
  bridge       AccountBridge  { id: string, provider: "cloud"|"self-hosted"|"local"|"platform-sdk",
                                type: string }        (v4.2.785+)
  user         User
  status       enum           connected | connecting | backfilling | connection_required
                              | reconnect_required | attention_required | disconnected | disabled
  loginID      string?        bridge login ID. One login can contain multiple accounts.
  statusText   string?        human-friendly status text
  network      string?        display name; omitted when unknown
  capabilities object?        runtime chat/message capabilities
```

`GET /v1/accounts` returns a **bare JSON array**, not a paginated envelope. Note the identifier is `accountID`, **not** `id` — inconsistent with `Chat.id` and `Message.id`.

> **`status`, `loginID` and `statusText` do not exist in `@beeper/desktop-api@5.0.0`.** Its `Account` has exactly four fields: `accountID`, `bridge`, `user`, `network?`. This is the SDK-drift problem from the Verdict.

### Chat

```
Chat                          required: id, accountID, network, title, type, participants, unreadCount
  id                     string    unique across Beeper
  localChatID            string?   install-specific; accepted on input routes
  accountID              string    → Account.accountID
  network                string    display-only network/account name
  title                  string
  type                   "single" | "group"
  participants           object    { hasMore: bool, items: Participant[], total: int }
  unreadCount            integer
  unreadMentionsCount    integer?
  lastActivity           string?   timestamp
  lastReadMessageSortKey string?
  draft                  ChatDraft | null
  preview                Message?  ← only on GET /v1/chats (ChatWithPreview), not on search
  description            string?   group topic
  imgURL                 string?   LOCAL FILESYSTEM PATH to the avatar
  isReadOnly             boolean?  true if messages cannot be sent
  isArchived / isMuted / isPinned / isLowPriority / isMarkedUnread   boolean?
  reminder               object | null    { remindAt?, dismissOnIncomingMessage? }
  snooze                 object | null    { snoozeUntil?, userSnoozedAt? }
  messageExpirySeconds   integer | null   disappearing-message timer
  capabilities           ChatCapabilities?
```

`participants` is **always an object**, never a bare array. `GET /v1/chats` and `/v1/chats/search` cap it at **20 per chat**; `GET /v1/chats/{chatID}` defaults to **100** (`maxParticipantCount`, range 0–500, or `-1` for all). A group-chat participant list is therefore a per-chat fetch, not something the list endpoint gives you.

`Chat.capabilities` is the per-chat feature gate — `edit`, `editMaxAge`, `editMaxCount`, `delete`, `deleteMaxAge`, `deleteForMe`, `reaction`, `allowedReactions`, `customEmojiReactions`, `reply`, `archive`, `markAsUnread`, `readReceipts`, `typingNotifications`, `maxTextLength`, `attachments`, and more. Support levels are the numeric union `-2 | -1 | 0 | 1 | 2` (`-2` rejected, `-1` dropped, `0` unsupported, `1` partial, `2` full). **This is how a network-agnostic composer decides which buttons to render** — do not hardcode per-network behaviour.

### Message

```
Message                       required: id, chatID, accountID, senderID, timestamp, sortKey
  id               string
  chatID           string
  accountID        string
  senderID         string     fully qualified; usually network prefix + homeserver
  senderName       string?    resolved display name
  timestamp        string     date-time
  sortKey          string     "a unique, sortable key used to sort messages"
  type             enum?      TEXT | NOTICE | IMAGE | VIDEO | VOICE | AUDIO
                              | FILE | STICKER | LOCATION | REACTION
  text             string?    RICH TEXT (Matrix HTML), not plain text
  editedTimestamp  string?    date-time — presence marks an edit
  isDeleted        boolean?   tombstone, not removal
  isHidden         boolean?   hidden from normal display
  isSender         boolean?
  isUnread         boolean?   "may be omitted"
  linkedMessageID  string?    ← THE REPLY-TO FIELD
  mentions         string[] | null    user IDs, "@room", or null for legacy
  links            LinkPreview[]?
  attachments      Attachment[]?
  reactions        Reaction[]?
  seen             boolean | date-time string | { [participantID]: boolean | date-time }
  sendStatus       SendStatus?
```

Five traps for the store design:

- **`text` is rich text (Matrix HTML), not plain.** Rendering it needs sanitizing; storing it means storing markup. This matters directly for #1's writing-style-analysis goal — that pipeline wants plain text, so the store should keep both or strip at read time.
- **`sortKey`, not `timestamp`, is the ordering key.** It is the field `Chat.lastReadMessageSortKey` compares against.
- **Reply-to is `linkedMessageID`**, an unhelpful name for a foreign key to another message.
- **`mentions: null` is meaningful** — "legacy message, scan the text" — and is distinct from absent. This is exactly the absent-vs-empty distinction the root `AGENTS.md` calls out; gate on `Array.isArray(...)`.
- **`seen` is a three-way union.** A schema needs all three shapes or it will drop read receipts on some networks.

Deletions arrive as `isDeleted: true` on an otherwise-normal message, and edits as a populated `editedTimestamp`. Both are **mutations of an existing row**, so the store must upsert by `id`, never append-only.

### Attachment, Reaction, User

```
Attachment                    required: type
  type          "unknown" | "img" | "video" | "audio"     ← note: NOT the send-side union
  id            string?   usually an mxc:// URL
  srcURL        string?   public URL or local file path — "may be temporary or local-only
                          to this device; download promptly if durable access is needed"
  posterImg     string?   video poster frame (same warning)
  mimeType / fileName / fileSize / duration
  size          { width?, height? }
  isGif / isSticker / isVoiceNote   boolean?
  transcription { engine, transcription, language? }?

Reaction                      required: id, participantID, reactionKey
  id            string   participantID, or participantID+reactionKey where multi-react is allowed
  participantID string
  reactionKey   string   emoji, network-specific key, or shortcode ("smiling-face")
  emoji         boolean? true if reactionKey is an emoji
  imgURL        string?

User                          required: id
  id            string   "stable Beeper user ID. Use as the primary key when referencing a person"
  fullName / username / email / phoneNumber (E.164)   string?
  imgURL        string?
  isSelf        boolean?
  cannotMessage boolean?  Beeper cannot initiate to this user; they may still message you
```

`Participant` extends `User` with `isAdmin?`, `isNetworkBot?`, `isPending?`.

**This is the Tribe-identity join surface.** #1's settled point 9 (network-scoped handles) is confirmed necessary and now has concrete fields: `User.id` is the stable key, with `phoneNumber` (E.164) and `email` as the *sometimes* present bridges to Tribe's existing keys, and `username` as a network-scoped, explicitly **not globally unique** handle.

The inbound `Attachment.type` union (`unknown|img|video|audio`) differs from the outbound send-side hint (`image|video|audio|file|gif|voice-note|sticker`). Read and write are not symmetric; neither are drafts (see §6).

## 5. Read endpoints and pagination

| Operation | Method + path |
|---|---|
| List chats | `GET /v1/chats` |
| Search chats | `GET /v1/chats/search` |
| Get chat | `GET /v1/chats/{chatID}` |
| List messages in chat | `GET /v1/chats/{chatID}/messages` |
| Get message | `GET /v1/chats/{chatID}/messages/{messageID}` |
| Search messages | `GET /v1/messages/search` |
| Unified search | `GET /v1/search` |
| List accounts | `GET /v1/accounts` |
| Get account | `GET /v1/accounts/{accountID}` |
| List bridges | `GET /v1/bridges` |
| Search contacts | `GET /v1/accounts/{accountID}/contacts` |
| List contacts | `GET /v1/accounts/{accountID}/contacts/list` |

### Pagination contract

Every paginated response is the same envelope:

```json
{ "items": [...], "hasMore": true, "oldestCursor": "...", "newestCursor": "..." }
```

- `cursor` is **opaque — "do not inspect"**. (The spec's example is `"1725489123456|c29tZUltc2dQYWdl"`, i.e. a timestamp and an encoded page token, but relying on that shape is not supported.)
- `direction` is `"before"` (older) or `"after"` (newer), and **defaults to `"before"` when only `cursor` is given**.
- `oldestCursor` / `newestCursor` are both nullable.
- The SDK's auto-pagination **only ever walks backwards** — `nextPageRequestOptions()` reads `oldestCursor` and ignores `newestCursor` entirely. Catching up on *new* messages via `direction: "after"` means driving the cursor by hand.

### Page-size table — the asymmetry that matters

| Endpoint | `limit` | Default | Max |
|---|---|---|---|
| `GET /v1/chats` | **absent** | server-chosen | — |
| `GET /v1/chats/{chatID}/messages` | **absent** | server-chosen | — |
| `GET /v1/chats/search` | yes | 50 | 200 |
| `GET /v1/messages/search` | yes | 20 | **20** |
| `GET /v1/accounts/{accountID}/contacts/list` | yes | 50 | 200 |

The SDK encodes this in its two page classes: `CursorNoLimit<T>` (chats list, messages list — no `limit` in its params type) and `CursorSearch<T>` (everything else). Message search is hard-capped at 20 per page, so any "search my history" UI is a many-round-trip walk.

### Ordering guarantees

- `GET /v1/chats`: "Chats ordered by last activity timestamp (**most recent first**)", combining all accounts into one list.
- `GET /v1/chats/{chatID}/messages`: "**Sorted by timestamp**." Sort on `sortKey` in the store regardless — it is the field the API's own read-position marker compares against.
- Search endpoints document no ordering.

### Filters worth knowing

`GET /v1/chats/search` takes `query`, `scope` (`titles`|`participants`, default `titles`), `inbox` (`primary`|`low-priority`|`archive`), `type` (`single`|`group`|`any`), `unreadOnly`, `includeMuted` (default `true`), `lastActivityBefore`/`lastActivityAfter`, `accountIDs`.

`GET /v1/messages/search` takes `query`, `chatIDs`, `accountIDs`, `chatType`, `mediaTypes` (`any|video|image|link|file`), `sender` (`me`|`others`|a user ID), `dateAfter`/`dateBefore` (**strictly** after/before), `excludeLowPriority` (default `true`), `includeMuted` (default `true`).

Search is **literal word matching**, all words must match, case-insensitive — not semantic. `GET /v1/messages/search` returns an extra `chats` map keyed by chat ID alongside `items`, so a search result view gets its chat context in one call.

### Attachments

| Operation | Method + path |
|---|---|
| Download to disk | `POST /v1/assets/download` — body `{ url }` (`mxc://` or `localmxc://`) → `{ srcURL?, error? }`, a **local file URL** |
| Stream | `GET /v1/assets/serve?url=` — accepts `mxc://`, `localmxc://`, `file://`; downloads if uncached; **supports Range requests**; declares `304` and `416` |
| Upload multipart | `POST /v1/assets/upload` |
| Upload base64 | `POST /v1/assets/upload/base64` — `{ content, fileName?, mimeType? }`, ~500 MB decoded max → `{ uploadID?, srcURL?, ... }` |

Both upload routes return an **`uploadID`**, which is the required handle for sending an attachment or setting a draft attachment.

Every media URL field (`Attachment.srcURL`, `posterImg`, `User.imgURL`, `LinkPreview.img`/`favicon`) carries the same standing warning: *may be temporary or available only on this device; download promptly if durable access is needed.* That is a direct input to #1's open "attachment and media handling" question — these URLs are **not durable references** and cannot be stored as if they were.

## 6. Write endpoints

| Operation | Method + path | Success |
|---|---|---|
| Send message | `POST /v1/chats/{chatID}/messages` | `200` `SendMessageOutput` |
| Edit message | `PUT /v1/chats/{chatID}/messages/{messageID}` | `200` `EditMessageOutput` |
| Delete message | `DELETE /v1/chats/{chatID}/messages/{messageID}` | **`204` no body** |
| Add reaction | `POST /v1/chats/{chatID}/messages/{messageID}/reactions` | `200` `AddReactionOutput` |
| Remove reaction | `DELETE /v1/chats/{chatID}/messages/{messageID}/reactions/{reactionKey}` | `200` `RemoveReactionOutput` |
| Update chat / **set draft** | `PATCH /v1/chats/{chatID}` | `200` `Chat` |
| Archive | `POST /v1/chats/{chatID}/archive` | **`204` no body** |
| Mark read | `POST /v1/chats/{chatID}/read` | `200` `Chat` |
| Mark unread | `POST /v1/chats/{chatID}/unread` | `200` `Chat` |
| Notify anyway | `POST /v1/chats/{chatID}/notify-anyway` | `200` `Chat` |
| Create chat | `POST /v1/chats` | `200` `CreateChatOutput` |
| Start DM | `POST /v1/chats/start` | `200` (v4.2.808+) |
| Set / clear reminder | `POST` / `DELETE /v1/chats/{chatID}/reminders` | `204` |
| Focus the app | `POST /v1/focus` | `200` `{ success: true }` |

### Send — asynchronous, no idempotency key

```
POST /v1/chats/{chatID}/messages
body (every field optional):
  text              string?   plain text or Markdown → converted to Beeper rich text
  replyToMessageID  string?
  attachment        { uploadID (REQUIRED), type?, fileName?, mimeType?, duration?,
                      size?: { width, height } }
```

The 200 returns **only**:

```json
{ "chatID": "<chat id>", "pendingMessageID": "<pending id>" }
```

> "Pending ID assigned to the message **before the network confirms the send**. Pass it to `GET /v1/chats/{chatID}/messages/{messageID}` to resolve, or wait for the matching `message.upserted` over the WebSocket."

**There is no idempotency key on send.** A retried `POST` sends a second message. The only idempotency-adjacent field anywhere is `transactionID` on *reactions* ("optional transaction ID for deduplication and send tracking"), and it has no send-message counterpart. Any retry logic PortOS writes must be application-level and conservative — and note that the SDK **retries `409` and `>=500` automatically** (§8), which on a write path means a duplicate send. **Set `maxRetries: 0` on the client used for sends**, or use raw `fetch` there.

### How a failed send surfaces

Not in the send response — it surfaces later, on the resolved `Message.sendStatus`:

```
SendStatus                    required: status, timestamp
  status            "SUCCESS" | "PENDING" | "FAIL_RETRIABLE" | "FAIL_PERMANENT"
  timestamp         date-time
  reason            string?   machine-readable; "present when the send status is a failure"
  message           string?   human-readable
  deliveredToUsers  string[]?
  internalError     string?   "Do not show directly to users"
```

So the composer's state machine is: `POST` → hold `pendingMessageID` → resolve by polling `GET /v1/chats/{chatID}/messages/{pendingMessageID}` or by the `message.upserted` WebSocket event → branch on `sendStatus.status`. `GET .../messages/{messageID}` explicitly accepts "a final message ID, **`pendingMessageID`**, or Matrix event ID", which is what makes the resolve step work.

### Edit and delete

Edit takes `{ text }` (required, `minLength: 1`) and returns the full updated `Message` plus deprecated compat fields `messageID` and `success: true`. **Messages with attachments cannot be edited.**

Delete is where the sharp edge is:

```
DELETE /v1/chats/{chatID}/messages/{messageID}?forEveryone=<bool>
  forEveryone   boolean, nullable, DEFAULT true
```

**Omitting `forEveryone` unsends for every participant.** The docs prose does not state the default; only the spec does. Pass it explicitly on every call. Pending message IDs are rejected — "messages cannot be deleted while sending".

### Drafts — the two-call rule

Drafts are not a resource; they are a field on `PATCH /v1/chats/{chatID}`.

> "Non-empty drafts are accepted only when the current draft is empty. Send `draft=null` to clear text and attachments together before setting a new draft."

So overwriting an existing draft is **`PATCH {draft: null}` then `PATCH {draft: {...}}`**. A composer that syncs drafts on every keystroke will fight this; debounce, and always clear first.

Write and read draft shapes are **not symmetric**:

| | Write (`ChatDraftInput`) | Read (`Chat.draft`) |
|---|---|---|
| text | required | required, rich text |
| attachment key | `uploadID` (required) | `id` + `filePath` |
| type union | `image\|video\|audio\|file\|gif\|voice-note\|sticker` | `file\|gif\|recorded_audio` |

### Everything else

- **Archive**: body `{ archived?: boolean }`, **default `true`**; returns `204`. Also reachable as `PATCH {isArchived}` — which returns the updated `Chat`, so prefer `PATCH` if the store wants the new state back without a re-read.
- **Mark read / unread**: optional `{ messageID }` to mark read *through* / unread *from* a specific message. Both return the **full `Chat`**, so the unread badge updates from the response with no follow-up call.
- **Notify anyway**: no body, returns `Chat`. "Currently intended for iMessage on macOS; unsupported networks return an error."
- **Create chat**: `{ accountID, participantIDs[], type }` required, `messageText?`, `title?`. **Start DM**: `{ accountID, user: {id?|email?|phoneNumber?|username?|fullName?} }`, resolves the best identifier and reuses an existing DM when one is found — this is the right call for "message this Tribe contact".

## 7. Errors

One shape, everywhere:

```
Error                         required: message, code
  message  string   human-readable
  code     string   machine-readable
  details  ?        validation_details { issues: [{ code, message, path: (string|number)[] }] }
                    | context (arbitrary object)
                    | arbitrary
                    | null
```

Verified live against an unauthenticated request:

```
GET /v1/chats  →  401
{"message":"Unauthorized: Invalid or missing token","code":"unauthorized"}
```

Note this is **not** the v0 shape (`{ error, code?, details? }`) that the deprecated docs still show — v1 uses `message`, and both `message` and `code` are required.

**All 57 v1 operations declare the same set: `400, 401, 403, 404, 409, 422, 429, 500, 502.`** (`GET /v1/assets/serve` adds `304` and `416` for Range requests.) Descriptions:

| Status | Meaning |
|---|---|
| 400 | Invalid request parameters |
| 401 | Access token is missing or invalid |
| 403 | Access token does not have the required scope |
| 404 | Resource not found |
| 409 | Request conflicts with the current resource state |
| 422 | Unprocessable entity — validation error |
| 429 | Too many requests — rate limit exceeded |
| 500 | Internal server error |
| **502** | **Upstream dependency returned an invalid response** |

`502` is the interesting one for a chat client: it is the bridge/network failing behind the local server, distinct from `500`. Treat `502` as "the network is having a moment, retry later", not as a client bug.

**The `code` enum is never published.** Observed: `unauthorized` (401) and `INVALID_PAYLOAD` (WebSocket). Match on HTTP status; treat `code` as a log field, not a control-flow key, until an enum is documented.

## 8. Rate limits and the suspension policy

**No numeric rate limit is documented anywhere** — no requests/sec, no burst, no `Retry-After` or `X-RateLimit-*` headers in the spec. Only the `429` response exists.

The one policy statement, verbatim from the docs landing page:

> "We recommend Beeper Desktop API for **personal use only. Sending too many messages might result in account suspension by the networks.** Actions like searching or fetching existing chats or messages are always local and can be used **without limitations**."

Note the asymmetry, which matters for #1's settled point 3: **reads are explicitly unlimited and local**; the suspension risk is from the **upstream networks**, applied to sends, not from Beeper. Normal human-paced sending from a chat UI is squarely the sanctioned use. Bulk/automated outbound — already out of scope in #1 — is the actual risk.

### SDK client behaviour (not server policy)

`@beeper/desktop-api@5.0.0`, from `client.js`:

- `maxRetries` default **2**.
- Retries on: `x-should-retry` header override, then **408, 409, 429, >=500**, plus connection errors and timeouts.
- Backoff: `min(0.5s * 2^n, 8s)` with up to 25% jitter reduction; `retry-after-ms` then `retry-after` headers win over the computed delay.
- `DEFAULT_TIMEOUT` = **30000 ms**, and timeouts are themselves retried.
- Error classes: `BeeperDesktopError` → `APIError` → `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `UnprocessableEntityError` (422), `RateLimitError` (429), `InternalServerError` (>=500), plus `APIConnectionError` / `APIConnectionTimeoutError` / `APIUserAbortError`.
- `APIError` has **no `code` property** — the machine code lands in `err.error.code`.

Restating the §6 warning because it is a correctness bug waiting to happen: **the default retry policy applied to `POST /v1/chats/{chatID}/messages` can duplicate a sent message**, since there is no idempotency key. Sends need `maxRetries: 0`.

## 9. Behaviour when a bridge is disconnected

`Account.status` is the answer, and it is an eight-value enum, not a boolean:

```
connected | connecting | backfilling | connection_required
| reconnect_required | attention_required | disconnected | disabled
```

`backfilling` deserves its own UI state — the account is up but history is still filling in, which is a different message to the user than "disconnected". `statusText` carries Beeper's own human-friendly wording; use it rather than inventing labels.

`GET /v1/bridges` gives the bridge-level view: `{ id, network, statusText, supportsMultipleAccounts, accounts: Account[], status }` where bridge status is `available | connected | limit_reached | temporarily_unavailable | disabled`. Reconnection is a real flow, not just a link — `GET /v1/bridges/{bridgeID}/login-flows`, `POST /v1/bridges/{bridgeID}/login-sessions`, then `POST .../steps/{stepID}`. PortOS almost certainly should **not** implement bridge login; it should detect the bad status and send the user to Beeper.

**What the docs do not say**, and what an integration test on a real install must settle:

- Whether `GET /v1/chats` still returns chats for a `disconnected` account (probably yes, since reads are local and cached — but unverified).
- What exactly `POST .../messages` returns when the target account is down: a `502`, or a `200` with a `pendingMessageID` that later resolves to `FAIL_RETRIABLE`. The second is more likely given the async design, and it is the harder case for the UI.

**The blocking constraint: none of this is reachable through the SDK.** `@beeper/desktop-api@5.0.0` has no `bridges` resource and no `status` on `Account`. Its `api.md` contains no Bridges section at all. Any PortOS surface that shows connection health must call `GET /v1/accounts` and `GET /v1/bridges` with raw `fetch` and its own types.

## 10. SDK drift: use it, but not exclusively

The SDK is Stainless-generated from the same spec, zero runtime dependencies, MIT. It is genuinely good — typed pages, sane retries, a clean resource layout — and worth using for the bulk of the read/write surface.

But `@beeper/desktop-api@5.0.0` was published 2026-05-07, and the live spec on this build (also labelled 5.0.0) has moved:

| In the live API | In the SDK |
|---|---|
| `Account.status`, `Account.loginID`, `Account.statusText` | absent |
| `/v1/bridges` + 9 bridge login/session routes | absent |
| `/v1/app/setup/**` (setup, verification, recovery key, QR, SAS) | absent |
| `/_matrix/client/v3/**` passthrough (9 routes) | absent |
| `DELETE .../messages/{id}` → `204` | `void`, default of `forEveryone` not surfaced |

`CHANGELOG.md` covers only 4.4.0 → 5.0.0 and describes the 5.0.0 changes as two opaque "api update" commits — it does not say what broke. **Pin an exact SDK version**, and expect the deprecation pattern to keep appearing (`ChatCreateResponse.chatID`, `ChatStartResponse.chatID`, `MessageUpdateResponse.messageID`, `success: true` are all legacy aliases — prefer `id` everywhere).

Recommended split for the implementation tickets: **SDK for chats/messages/assets, raw `fetch` for `/v1/accounts` + `/v1/bridges` + `/v1/info`**, with hand-written types for the latter checked against `GET /v1/spec` at dev time.

## 11. Real-time

`ws://<host>:23373/v1/ws`, same bearer token, **explicitly experimental** ("may change between desktop releases"), and **not supported by the SDK** — you write the client. Events are `chat.upserted`, `chat.deleted`, `message.upserted`, `message.deleted`.

Covered in depth by ticket #3's note, [`realtime-and-history.md`](./realtime-and-history.md), including the at-most-once delivery, the no-replay-on-reconnect behaviour, and the reconciliation pass a store needs on top. Not repeated here.

## 12. What this changes for #1

Nothing in #1's "Settled at charting" list is overturned. Confirmations and amendments:

- **Point 3 (read and send both in scope) is confirmed correct.** The suspension warning is explicitly about send volume against upstream networks; reads are documented as local and unlimited.
- **Point 5 (auto-detected optional feature) is straightforward**: unauthenticated `GET /v1/info` on `127.0.0.1:23373` is the probe, and it returns app version and server status without a token.
- **Point 8 (one Beeper account, chats tagged by network) is well supported** — `Chat.accountID` + `Chat.network`, with `Account.bridge.type` as the stable machine-readable network key (`network` itself is documented "display-only").
- **Point 9 (network-scoped handles in Tribe) is confirmed necessary**, and §4 names the exact fields.
- **Amend the "requires Beeper Desktop to be running" note** — the spec says the API is served by Beeper Desktop *and Beeper Server*.
- **Add to "Not yet specified":** whether PortOS stores `Message.text` as the rich text Beeper returns, plain text, or both. Writing-style analysis wants plain; fidelity wants rich. This is a store-shape decision that #1 does not currently list.

## Open questions this could not close from documentation

1. **Token lifetime**, and whether a token survives a Beeper Desktop restart or user sign-out. Requires a real install over time.
2. **Where the custom-port setting lives** in the Beeper UI, and whether anything advertises a non-default port.
3. **Actual page sizes** returned by `GET /v1/chats` and `GET /v1/chats/{chatID}/messages`, which have no `limit`.
4. **Send-to-a-dead-bridge behaviour**: `502` at send time, or `200` + a later `FAIL_RETRIABLE`.
5. **Whether cached chats/messages still list for a `disconnected` account.**
6. **The `Error.code` value set.** Only `unauthorized` and `INVALID_PAYLOAD` observed.
7. **Any real rate limit.** `429` exists in the spec but is never quantified.

Items 3, 4 and 5 are cheap to settle with a scripted probe against a live install and would materially de-risk the store design. They are the natural content of a prototype ticket.

## Sources

Primary, all retrieved 2026-08-31.

**Live instance** (Beeper Desktop 4.3.73, unauthenticated endpoints only; no chat data was read)
- `GET http://127.0.0.1:23373/v1/info`
- `GET http://127.0.0.1:23373/.well-known/oauth-authorization-server`
- `GET http://127.0.0.1:23373/v1/spec` — the OpenAPI 3.1.0 spec, `Beeper Client API` 5.0.0 (**authoritative source for every schema, parameter, default and status code in this note**)
- `GET http://127.0.0.1:23373/v1/chats` without a token — for the observed error shape

**TypeScript SDK** — `@beeper/desktop-api@5.0.0`, read from the npm tarball
- <https://registry.npmjs.org/@beeper/desktop-api> · <https://github.com/beeper/desktop-api-js>
- <https://raw.githubusercontent.com/beeper/desktop-api-js/main/api.md>
- Shipped files read: `package.json`, `README.md`, `CHANGELOG.md`, `client.d.ts`, `client.js`, `core/pagination.d.ts`, `core/pagination.js`, `core/error.d.ts`, `resources/shared.d.ts`, `resources/messages.d.ts`, `resources/chats/chats.d.ts`, `resources/chats/messages/reactions.d.ts`, `resources/accounts/accounts.d.ts`, `resources/assets.d.ts`, `resources/info.d.ts`, `resources/top-level.d.ts`
- <https://raw.githubusercontent.com/beeper/desktop-api-js/main/packages/mcp-server/src/auth.ts>

**Documentation** — `developers.beeper.com`, markdown twins at `<url>/index.md`
- <https://developers.beeper.com/desktop-api/> — landing page, "Personal use recommended" callout
- <https://developers.beeper.com/desktop-api/auth/> — token creation, OAuth/PKCE, introspection
- <https://developers.beeper.com/desktop-api/advanced/remote-access/> — binding, CORS, custom port
- <https://developers.beeper.com/desktop-api/changelog/> — version floors, v0→v1 migration table
- <https://developers.beeper.com/desktop-api/websocket-experimental/>
- <https://developers.beeper.com/desktop-api/mcp/>
- <https://developers.beeper.com/desktop-api-reference> and its per-method pages under `/resources/{chats,messages,accounts,assets,bridges,info,$client,$shared}/…`
- <https://developers.beeper.com/desktop-api-reference/typescript/> — SDK error-class table, retry defaults
- <https://developers.beeper.com/llms.txt> · <https://developers.beeper.com/llms-full.txt>
- <https://developers.beeper.com/sitemap-0.xml> — used to enumerate the reference pages
- <https://developers.beeper.com/desktop-api/v0/> — deprecated v0 spec, cited only for the older error shape

**Confirmed absent**: no public OpenAPI spec. `/openapi.json`, `/openapi.yml`, `/desktop-api/openapi.json`, `/desktop-api-reference/openapi.json` and `/desktop-api-reference/openapi.yml` all 404.

**Sibling research**: [`realtime-and-history.md`](./realtime-and-history.md) (#3), [`open-source-and-bridges.md`](./open-source-and-bridges.md) (#4).
