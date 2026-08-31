# Beeper contact and cross-network identity model

Research for #5 (part of #1). Point-in-time record, 2026-08-31. Beeper Desktop API spec
version `5.0.0`; `@beeper/desktop-api` npm `5.0.0`; mautrix-go `main` @ `e01382ec`.

**Bottom line.** Beeper gives one flat identity object (`User`) that is always scoped to a
single account/network, with optional `phoneNumber` / `email` / `username` / `fullName` /
`imgURL` hanging off it. Beeper does **no** cross-network merging and exposes **no** linking
field of any kind — the same human is N unrelated `User.id` values. Self-vs-other is
unambiguous, but only via boolean flags, never by comparing ID strings. Roughly half the
networks we care about hand us a phone number that Tribe can already match on today; the
other half hand us nothing Tribe understands.

---

## 1. How Beeper represents a contact

There is exactly one identity type. **There is no `Contact` type** — the contacts endpoints
return `User` objects. `Participant` is `User` plus three chat-membership booleans.

`components.schemas.User`, verbatim from the OpenAPI spec:

| Field | Type | Spec description |
|---|---|---|
| `id` | string | **"Stable Beeper user ID. Use as the primary key when referencing a person."** — the only required field |
| `username` | string | "Human-readable handle if available (e.g., '@alice'). **May be network-specific and not globally unique.**" |
| `phoneNumber` | string | "User's phone number in E.164 format. Omit if unknown." |
| `email` | string | "Email address if known. Not guaranteed verified." |
| `fullName` | string | "Display name as shown in clients. May include emojis." |
| `imgURL` | string | "Avatar image URL if available… **May be temporary or available only on this device; download promptly if durable access is needed.**" |
| `cannotMessage` | boolean | "True if Beeper cannot initiate messages to this user (e.g., blocked, network restriction, or no DM path)." |
| `isSelf` | boolean | "True if this user represents the authenticated account's own identity." |

`Participant` = `allOf: [User, { isAdmin, isPending, isNetworkBot }]`, described as "A chat
participant. Extends User with chat membership metadata."

Two consequences worth writing down:

- **Everything except `id` is optional.** Any consumer must treat all five enrichment fields
  as absent-by-default, not empty-by-default. (This is the root-`AGENTS.md` sentinel rule in
  its natural habitat: `phoneNumber` absent ≠ `phoneNumber: ""`.)
- **`User` carries no `accountID`.** No `accountID`/`accountId` field exists on `User` or
  `Participant` in the spec or the SDK. The network is implied by *where you fetched the
  object from* — the `{accountID}` path segment on contacts endpoints, or `Chat.accountID` on
  the enclosing chat. A bare `User` lifted out of context does not say which network it is
  from. Anything PortOS persists has to carry that scope alongside it.

### ID shapes

Beeper is built on Matrix, and `User.id` is a Matrix user ID in every observed case. The
spec's own examples (identifiers below genericised):

| Source | Shape | Example |
|---|---|---|
| Cloud bridge | `@<bridgetype>_<networkid>:beeper.com` | `@discord_<snowflake>:beeper.com` |
| Local bridge | `@<networkid>:local-<network>.localhost` | `@15550100:local-whatsapp.localhost` |
| Native Beeper/Matrix | `@<localpart>:beeper.com` | `@example-user:beeper.com` |

Chat IDs are Matrix room IDs (`!<opaque>:beeper.com`).

`accountID` is documented as: "Examples include `matrix` for Beeper/Matrix, `discordgo` for a
cloud bridge, `slackgo.TEAM-USER` for workspace-scoped cloud bridges, and
`local-whatsapp_ba_...` for local bridges." `Account` also carries `loginID` — "Bridge login
ID for this account, when known. One bridge login can contain multiple chat accounts." The
local-bridge `accountID` visibly composes as `{bridgeID}_{loginID}`.

### ⚠️ `Account.user.id` is NOT the same string as `Participant.id` / `Message.senderID`

The same self-identity renders two different ways depending on where you read it:

```jsonc
// GET /v1/accounts  →  accounts[].user
{ "id": "ba_XXXXXXXX", "phoneNumber": "+15550100", "isSelf": true }

// GET /v1/chats/{id} →  participants.items[]
{ "id": "@ba_XXXXXXXX:local-whatsapp.localhost", "isSelf": true }
```

Discord is the same: the account's `user.id` is the bare snowflake, the participant form is
`@discord_<snowflake>:beeper.com`. Only the native Matrix account uses one string in both
places. **Never derive self-vs-other by comparing `accounts[].user.id` to `senderID` or
`participants[].id`** — it fails silently on every bridged network. Use the flags (§5). This
is read off the spec's examples; the spec states no rule about it either way.

---

## 2. Cross-network merging: not performed, not exposed

The docs use the word "merged" in a way that is easy to misread. **"Merged" means merged
within one account, not across networks.**

The decisive line is the Contacts tag description in the spec:

> "Per-account contacts and network lookup. **The same person can appear under multiple
> accounts.**"

and the search endpoint's own description — "Search contacts on a specific account using
merged account contacts, network search, and exact identifier lookup" — i.e. three *sources
inside one account* are merged into one result list. `ListContactsOutput.items` is documented
as "Merged contacts for **the selected account**."

Structural confirmation:

- Both contact endpoints are account-scoped: `GET /v1/accounts/{accountID}/contacts` and
  `GET /v1/accounts/{accountID}/contacts/list`. **There is no `GET /v1/contacts`.** Confirmed
  against the full 51-path list in the spec.
- Grepping the spec for every plausible linking field — `otherIdentities`, `identities`,
  `linkedUsers`, `mergedFrom`, `networkIDs`, `aliases`, `sameAs`, `contactID`, `globalID` —
  returns **zero occurrences of each**. No array of network identities under one contact, no
  canonical person ID, no merge pointer.
- `SearchContactsOutput` / `ListContactsOutput` are `{ items: User[] }` (plus cursors on the
  list form). Nothing wraps or groups them.

The spec's own examples show one human as three unrelated `User.id` values with no linking
field: a WhatsApp entry carrying `phoneNumber` and no `username`, a Discord entry carrying
`username` and no `phoneNumber`, and a Matrix entry carrying a Matrix-style `username`.

**Whether the Beeper desktop app merges contacts internally is not documented** on
developers.beeper.com (checked: Getting Started, API Reference index, both contacts reference
pages, changelog, MCP page). What is settled is that the API does not expose any such merge.
**Cross-network identity resolution is entirely the caller's job.** That is the whole of
ticket #10's problem statement, confirmed rather than assumed.

The underlying bridge layer agrees, for the same reason: nothing in mautrix's `Ghost` or
`UserInfo` links one network's ghost to another's. The only field that could ever serve as a
join key is `Identifiers` (§4), which is sparse and phone-stripped by default.

---

## 3. Identifier stability

### What Beeper documents

`User.id` — "**Stable** Beeper user ID." That is the entire stability claim. **No scope is
given** — nothing about restarts, sessions, reinstall, device, or relogin. The contacts
outputs attach a hedge to the fields rather than the id: "Values are **best-effort and can
vary by network**."

**Bridge relogin is not documented.** No warning that IDs change, and no promise that they
don't. Checked: the changelog (whose breaking-change entries cover a reaction-removal URL, a
chat-creation split, and response envelopes — nothing about identifier churn), a full keyword
walk of the spec for `relogin` / `re-login` / `logged out` / `may change` / `not stable` /
`ghost` (zero hits), and both contacts reference pages.

The closest primary evidence is that the API models reconnect as *preserving* the login.
`POST /v1/bridges/{bridgeID}/login-sessions`: "Start a temporary bridge login session to
connect a new chat account **or reconnect an existing bridge login**. Omit loginID and
accountID to connect a new account," with `loginID` ("Existing bridge login ID to reconnect")
and `accountID` request fields. So there is a first-class reconnect path distinct from
connect-new.

**Inference, flagged as inference:** since a local-bridge `accountID` and the self ghost's
localpart both embed the `loginID`, a relogin producing a *new* login ID would necessarily
change both. A reconnect carrying the old `loginID` plausibly would not. Unverified — treat
cross-relogin stability of `User.id` as **unknown** until tested against a live instance.

### What the bridge layer actually guarantees (this is the real answer)

Beeper does not fork the mautrix bridges — it runs branches of the upstream repos
("These bridges are the same bridges we run with On-Device Connections and also on Beeper
Cloud"). So mautrix's behaviour is Beeper's behaviour, and it is knowable from source.

The ghost MXID is a **pure function** of the network-native user ID plus static config —
`FormatGhostMXID(userID)` → `username_template` (`<networkid>_{{.}}`) → localpart encoding.
No randomness, no session input, no login input. And ghosts are keyed on `(bridge_id, id)`
with **no login column**; `UserLogin.Delete` removes the login row and space room but never
touches the ghost table.

**So a relogin does not by itself change anyone's ID.** What changes an ID is the *network*
changing its own identifier — and there is **no ghost re-ID mechanism**. `bridgev2` has
`ReIDPortal` for portals; there is no ghost equivalent. A remote ID change produces a
genuinely different ghost with a different MXID, not a renamed one.

| Network | Embedded native ID | Stable across relogin? |
|---|---|---|
| WhatsApp | phone digits, or `lid-<n>`, or `bot-<n>` | Yes — login ID *is* the phone number, deterministic; re-scanning the QR does not change ghost MXIDs. **But see LID below.** |
| Discord | snowflake | Yes — permanent |
| Telegram | decimal user id, or `channel-<id>` | Yes — permanent |
| Signal | ACI UUID, or `pni_<uuid>` | Yes — permanent (PN→UUID migration completed 2022) |
| Instagram / Messenger | FBID as decimal int64 | Yes — permanent |
| X/Twitter | numeric user id (**not** the `@handle`) | Yes — permanent |
| Slack | `<teamid>-<userid>`, lowercased | Yes — permanent per workspace |
| Google Messages / RCS | `<loginPrefix>.<participantID>` | **⚠️ Conditional — see below** |

#### The two real instability hazards

**WhatsApp's LID migration is happening right now and it IS an identifier change.** WhatsApp
is moving from `<phone>@s.whatsapp.net` to `<lid>@lid`. mautrix-whatsapp v26.08: "Switched
direct chats to use LIDs instead of phone numbers." The release blog: "**Phone number ghosts
will automatically be replaced with LID ghosts in all DM portal rooms after upgrading.**" The
mechanism is a membership swap between two distinct ghosts, not a rename —
`@whatsapp_<phone>:…` becomes `@whatsapp_lid-<n>:…`, a different Matrix user in the same
room. During the transition the bridge deliberately maintains **both** ghosts in parallel and
copies profile data between them. Real user-visible fallout exists (same person showing
different MXIDs in DMs vs groups; invalid-localpart errors on migration).

**Practical rule: never key a WhatsApp person on the Beeper `User.id` or on anything
phone-derived at the ID layer. Both are mid-migration.** Key on the `phoneNumber` *field*
instead, which is what Tribe already does.

**Google Messages is genuinely login-scoped.** Its user ID embeds a `loginPrefix` that is a
serial DB row id (or a hash of the login ID when the undocumented
`deterministic_id_prefix` config is on). Stable for a given phone pairing, so a plain
reconnect is fine — but **not portable across installs**, and a re-pairing that yields a new
phone ID produces new IDs for every contact.

Signal already went through the same shape of migration (phone → UUID) in 2022 and has
settled; a PNI-only contact still gets a separate `pni_<uuid>` ghost until resolved to an ACI.

---

## 4. Does display name, avatar, phone, or email travel with the handle?

**Yes for name and avatar, sometimes for phone, essentially never for email.** All five sit
flat on `User` next to `id` — not nested under a per-network sub-object — and all five are
optional and per-network ("best-effort and can vary by network"). There is no global profile.

Observed population across the spec's own examples:

| Network (source) | `phoneNumber` | `username` | `email` | `fullName` | `imgURL` |
|---|---|---|---|---|---|
| WhatsApp participant | ✅ | — | — | ✅ | — |
| Discord participant | — | ✅ | — | ✅ | — |
| X/Twitter participant | — | ✅ | — | ✅ | — |
| Matrix/Beeper participant | — | ✅ | — | ✅ | — |
| Matrix account **self** | — | ✅ | ✅ | ✅ | — |
| WhatsApp account **self** | ✅ | — | — | ✅ | ✅ (`file://`) |
| Discord account **self** | — | ✅ | — | ✅ | ✅ (`file://`) |

**Is phone or email ever populated for a non-phone network (Discord, Instagram, X)? Not
documented, and never shown in any example.** The schema permits it; no primary source states
a network for which it happens. The only `email` anywhere in the examples is on the user's own
native Matrix identity.

### Why, from the bridge layer

This is not an API omission — the data does not exist below. The canonical "what a bridge
knows about a remote user" type is five fields total:

```go
type UserInfo struct {
	Identifiers  []string
	Name         *string
	Avatar       *Avatar
	IsBot        *bool
	ExtraProfile database.ExtraProfile
	ExtraUpdates ExtraUpdater[*Ghost]
}
```

No email field. No phone field. What phone data exists rides in `Identifiers`, as
URI-scheme-prefixed strings, and only on some networks:

| Bridge | Identifier emitted |
|---|---|
| WhatsApp | `tel:+<E164>` |
| Signal | `tel:<E164>` |
| Google Messages | `tel:<phone>` |
| Telegram | `telegram:<username>` **and** `tel:+<n>` (phone only for mutual contacts) |
| X/Twitter | `twitter:<ScreenName>` |
| Slack | `slack-internal:<userID>` |
| Discord (v2) | `discord:<user>` |
| **Instagram / Messenger** | **none — the field is never set** |

**No bridge emits `mailto:`.** Email exists in exactly one place in the whole system —
`RemoteProfile`, which hangs off `UserLogin`, i.e. **your own** account:

```go
type RemoteProfile struct {
	Phone    string
	Email    string
	Username string
	Name     string
	Avatar   id.ContentURIString
	AvatarFile *event.EncryptedFileInfo
}
```

Slack populates `Email` there from your own boot response — never a coworker's.

Also note: at the *Matrix profile* layer, phone identifiers are **stripped by default**
(`phone_numbers_in_profile: false` deletes every `tel:` entry). That gate governs the
`com.beeper.bridge.identifiers` profile field, which is a different channel from the Desktop
API's first-class `User.phoneNumber` — and the Desktop API spec's examples do populate
`phoneNumber` for WhatsApp. **Whether a live instance populates it is worth confirming
empirically before anything depends on it** (see Open questions).

`imgURL` deserves its own warning: the spec says it "may be a remote URL, media URL, data URL,
or local file URL depending on the source" and "may be temporary or available only on this
device." Do not persist it as a stable avatar reference.

---

## 5. Chat participants, and self vs other

### Where participants live

`Chat.participants` is an object, not a bare array — `{ items, hasMore, total }`, all three
required. **`items` is routinely a subset**: `GET /v1/chats/{chatID}` takes
`maxParticipantCount` ("Use -1 for all; otherwise 0-500. Defaults to 100. **List and search
endpoints return up to 20 participants per chat**"). So `chats.list` and `chats.search` cap at
20 regardless of what you ask for; a full roster needs `chats.retrieve` with
`maxParticipantCount: -1`. Always check `hasMore` / `total`.

### Self vs other is unambiguous — via flags, never via string comparison

Three mechanisms, all first-class:

1. **`User.isSelf`** — "True if this user represents the authenticated account's own
   identity." Present on participants.
2. **`Message.isSender`** — "True if the authenticated user sent the message."
3. **`sender` query param** on `GET /v1/messages/search` — `'me'` | `'others'` | a specific
   `user.id` string.

Prefer all three over comparing IDs, for the `Account.user.id` mismatch in §1.

### How a message identifies its sender

`Message` required fields: `id`, `chatID`, `accountID`, `senderID`, `timestamp`, `sortKey`.

- `senderID` — "Fully qualified sender user ID. Network-backed IDs usually include the network
  prefix and homeserver." The SDK's slightly older wording is more explicit: "Matrix-style
  fully-qualified sender user ID, usually including a bridge prefix and homeserver."
- `senderName` — "Resolved sender display name (impersonator/full name/username/participant
  name)."
- `isSender` — boolean.

**`senderID` matches `Participant.id` in format**, so joining a message to a chat participant
by string equality is the intended path. The message carries no embedded `User` object — only
an ID and a resolved name — so any enrichment (phone, avatar, username) requires the
participant join. Note also `Message.mentions`: "Mentioned user IDs, `@room`, or **null** for
legacy messages that require text scanning" — `null` and `[]` mean different things here,
which is the root-`AGENTS.md` absent-vs-empty rule again.

Related identity-keyed fields: `Reaction.participantID`, `MessageSeenByParticipant` ("keyed by
participant ID"), `Message.sendStatus.deliveredToUsers`.

Bridges also support **double puppeting** (replacing your own ghost with your real Matrix
account for messages sent from other clients). Your ghost still exists either way; double
puppeting only changes which MXID *sends*. Not something the Desktop API surfaces directly,
but it is why `isSelf` rather than ID identity is the correct test.

---

## 6. Contact search — what you can actually query by

Two endpoints, different semantics.

**`GET /v1/accounts/{accountID}/contacts`** (search): `accountID` required in path; `query`
**required**, `minLength: 1`, "Text to search contacts by. **Matching behavior depends on the
network.**" Returns `{ items: User[] }` — no cursor, no `limit`, no `hasMore`, no documented
result cap.

**`GET /v1/accounts/{accountID}/contacts/list`**: `query` optional; `limit` **1–200, default
50**; `cursor` ("Opaque… do not inspect"); `direction` `after`|`before`. Returns
`{ items, hasMore, oldestCursor, newestCursor }`. This is the only documented numeric limit in
the contacts surface.

**There is no typed `phone=` / `email=` / `username=` parameter anywhere.** One free-text
`query`, with behaviour explicitly deferred to the network. The description's "exact
identifier lookup" implies exact phone/email/username match works where the network supports
it, but the docs do not say which networks those are.

**The capability map is discoverable per network**, which is the real answer to "can I look
this network up by phone?" — `ResolveIdentifierCapabilities`, reachable via
`GET /v1/bridges/{bridgeID}/capabilities`, all required booleans:

```json
{ "create_dm": bool, "lookup_phone": bool, "lookup_email": bool,
  "lookup_username": bool, "any_phone": bool, "contact_list": bool, "search": bool }
```

**`POST /v1/chats/start`** is the one place the API accepts typed identifiers, and it is the
closest thing to a resolver (Beeper Desktop v4.2.808+):

```jsonc
"user": {
  "id":          "Known user ID when available.",
  "username":    "Username/handle candidate.",
  "phoneNumber": "Phone number candidate (E.164 preferred).",
  "email":       "Email candidate.",
  "fullName":    "Display name hint used for ranking only."
}
```

"Resolve a user/contact and open a direct chat. Reuses and returns an existing direct chat
when one is found." Still `accountID`-scoped and required — it resolves **within one network**,
not across them.

Adjacent surfaces: `GET /v1/chats/search` has `scope` = `titles` | `participants`, where
participants matches **participant names only** — not handles, phones, or emails. All text
search is literal and non-semantic ("Use words the user actually typed, not inferred
concepts").

---

## 7. How PortOS resolves identity today, and what would have to change

*Facts only — the design is ticket #10.*

### Today: two axes, email and phone

`server/lib/tribeMatch.js` is 125 lines and has exactly two normalizers and two index maps.
`buildPersonMatchIndex(people)` reads only `person.emails` and `person.phones`; `matchPerson`
tries email → phone → exact-unique-name, in that order. `matchPeople` accepts bare strings and
routes them through `identityFromHandle`.

Persistence is two Postgres array columns with GIN indexes
(`server/lib/db/schema/tribe.js:25-33`):

```sql
ALTER TABLE tribe_people ADD COLUMN IF NOT EXISTS emails TEXT[] DEFAULT '{}';
ALTER TABLE tribe_people ADD COLUMN IF NOT EXISTS phones TEXT[] DEFAULT '{}';
```

validated at `server/routes/tribe.js:28,32` (`emails: z.array(z.string().max(320)).max(100)`,
`phones: z.array(z.string().max(40)).max(100)`), normalized and written by `normalizeEmails` /
`normalizePhones` and the INSERT/UPDATE column lists in `server/services/tribe.js`.

`server/services/identityResolve.js` layers Tribe over the macOS Contacts cache
(`server/services/contactsSync.js`) and returns a fixed shape:
`{ handle, phone, email, displayName, organization, personId, contactId, source }`. Consumers
of one or both: `imessageSync.js`, `signalSync.js`, `imessageManage.js`, `humanActivity.js`,
`tribeContacts.js`, `contactsSync.js`.

### The load-bearing collision: `identityFromHandle`'s `@` test

```js
export function identityFromHandle(handle) {
  const raw = handle == null ? '' : String(handle).trim();
  if (!raw) return {};
  if (raw.includes('@')) return { email: normalizeIdentifier(raw) };
  const phone = normalizePhone(raw);
  return phone ? { phone } : {};
}
```

Every Beeper `User.id` contains `@`. Fed to this function, `@example:local-whatsapp.localhost`
is classified as an **email** and looked up in the email index, where it matches nothing. It
does not throw; it silently returns no match. Six call sites share that behaviour.

The mirror-image hazard is worse because it can produce a *wrong* match rather than no match.
`normalizePhone` rejects anything containing `@`, then strips non-digits and prefixes `+`. A
bare Discord snowflake or Telegram numeric ID passed as a handle becomes a plausible-looking
E.164 key (`+<18 digits>`), which lands in the phone index and can collide with a real number.
Any Beeper wiring must never pass a raw network ID down the bare-string path.

### What would have to change, concretely

1. **A third identifier axis in `tribeMatch.js`.** Neither existing normalizer accepts a
   network-scoped handle: `normalizePhone` rejects `@` outright, and `normalizeIdentifier`
   lowercases unconditionally. A third normalizer plus a third index map, and a third branch
   in `matchPerson`'s precedence order.
2. **A discriminator that survives the bare-string path.** `identityFromHandle` cannot tell an
   email from a Matrix ID by `@` alone. Either the four sync services stop passing bare
   strings (moving to `{ network, handle }` objects), or the shape test gets sharper — a
   Matrix ID both *starts with* `@` and contains `:`, an email does neither. The first option
   changes four call sites; the second changes one function but leaves the ambiguity latent.
3. **Storage carries the network, not just the handle.** A bare third `TEXT[]` is not enough:
   a handle is meaningless without its network/account scope (§1 — `User` has no `accountID`).
   Values would need namespacing (`whatsapp:+15550100`, `discord:<snowflake>`) or a real
   child table. Either way this is `db-primary` under `docs/STORAGE.md`, needs a migration in
   `scripts/migrations/`, and — per root `AGENTS.md` — must not be skipped on
   "there's only one install" grounds.
4. **Schema parity in three places at once**, per `server/AGENTS.md`: the Zod schema in
   `server/routes/tribe.js`, the INSERT/UPDATE column lists in `server/services/tribe.js`, and
   the row mapper that projects `emails`/`phones` onto the person object.
5. **`resolveHandle`'s return shape grows a slot.** It has `phone` and `email` and nothing
   else; that shape is consumed by iMessage, Signal, humanActivity, and tribeContacts.
6. **Store IDs alongside stability caveats, not as the sole key.** §3 says a WhatsApp person's
   Beeper `User.id` is mid-migration (phone → LID) and a Google Messages person's ID is not
   portable across installs. Anything that keys long-lived Tribe rows on `User.id` alone will
   silently detach.

### The good news, and the size of the gap

Half the work may already be done. Beeper hands us `User.phoneNumber` in E.164 on WhatsApp,
Signal, and Google Messages participants — and `normalizePhone` already normalizes E.164 to
exactly the key Tribe indexes. **A WhatsApp participant can be matched to a Tribe person today
with zero schema change**, provided the code reads `User.phoneNumber` and never `User.id`.

The gap is the networks with no phone and no email at all: Discord, Instagram, X, Slack,
Telegram (phone only for mutual contacts). Those match nothing Tribe currently understands and
are the entire reason the third axis has to exist. Note that the fallback the matcher already
has — exact unique name — will opportunistically catch some of these via `User.fullName`,
since `matchPerson` tries name last and refuses ambiguous names. That is a real partial path,
and also a real false-match surface worth thinking about at #10.

---

## Open questions this research could not close

Each was actively searched, not merely unaddressed:

1. **Does `User.id` survive a bridge relogin?** Not documented anywhere. The spec models a
   reconnect flow that carries an existing `loginID`, but never states the identifier
   consequence. The bridge-layer analysis says ghosts are login-independent (§3), which is
   strong evidence, but Beeper's own `User.id` is not proven to be the ghost MXID in all
   cases. **Testable against a live instance.**
2. **What does the scope of "stable" in "Stable Beeper user ID" actually mean?** No qualifier
   anywhere — restart, session, reinstall, device, all unstated.
3. **Are `phoneNumber` / `email` ever populated for Discord, Instagram, or X in practice?**
   The schema permits it, no example shows it, and the bridge layer has no field to carry it.
   Near-certainly no, but formally unverified.
4. **Does a live instance actually populate `phoneNumber` for WhatsApp participants?** The
   spec examples do; the underlying mautrix profile layer strips `tel:` by default, though
   that is a different channel. **Cheap to verify against a live instance and worth doing
   first**, because it decides whether the "zero schema change for WhatsApp" claim above holds.
5. **Does the Beeper app merge contacts internally (in its own UI)?** Not documented. Only the
   API-level answer is settled: no merge is exposed.
6. **Beeper Cloud's ghost-localpart prefix** is not stated in any public source. The
   self-hosted (bbctl) form is documented as `@<name>_.+:beeper.local` with names required to
   start `sh-`; the cloud form is consistent-with-but-not-confirmed-as `@<bridgetype>_<id>`.

---

## Sources

**Beeper Desktop API (primary)**

- Getting started — https://developers.beeper.com/desktop-api/
- API reference index — https://developers.beeper.com/desktop-api-reference/
- Search contacts — https://developers.beeper.com/desktop-api-reference/resources/accounts/subresources/contacts/methods/search
- List contacts — https://developers.beeper.com/desktop-api-reference/resources/accounts/subresources/contacts/methods/list
- Changelog — https://developers.beeper.com/desktop-api/changelog
- MCP server — https://developers.beeper.com/desktop-api/mcp (server at `http://localhost:23373/v0/mcp`; note `/v0` vs REST `/v1`; the page lists no tool schemas)
- Open source page — https://developers.beeper.com/open-source
- OpenAPI spec, 56 endpoints, `info.version: 5.0.0` — https://storage.googleapis.com/stainless-sdk-openapi-specs/beeper/beeper-desktop-api-baac187842e51587134950c59c4d746bfcb59239f01919ed83b92c24c47d98f4.yml
  (no spec is published on developers.beeper.com — all of `/openapi.json`, `/desktop-api/openapi.json`, `/desktop-api-reference/openapi.json` 404. The URL above is named by `.stats.yml` in the Go SDK repo; `GET /v1/info` also returns an `endpoints.spec` served by the local app.)
- Older 30-endpoint spec named by the JS SDK's `.stats.yml` — https://storage.googleapis.com/stainless-sdk-openapi-specs/beeper/beeper-desktop-api-c08c14bb754b4cb0e02b21fabb680469368286be339dec0aaa8c69d04a1f021a.yml
- Spec mirror repo — https://github.com/beeper/desktop-api-openapi
- TypeScript SDK — https://github.com/beeper/desktop-api-js (`src/resources/shared.ts` for `User`; `src/resources/chats/chats.ts` for `Participant`; `src/resources/info.ts`)
- npm `@beeper/desktop-api` 5.0.0 — https://www.npmjs.com/package/@beeper/desktop-api

**mautrix / Matrix (primary, explains what the bridges can supply)**

- Matrix spec, user identifiers — https://spec.matrix.org/latest/appendices/#user-identifiers
- mautrix bridge docs — https://docs.mau.fi/bridges/
- Double puppeting — https://docs.mau.fi/bridges/general/double-puppeting.html
- `bridgev2` `UserInfo` — https://github.com/mautrix/go/blob/main/bridgev2/ghost.go
- `bridgev2` `Ghost` record — https://github.com/mautrix/go/blob/main/bridgev2/database/ghost.go
- `UserLogin` — https://github.com/mautrix/go/blob/main/bridgev2/database/userlogin.go
- `RemoteProfile` — https://github.com/mautrix/go/blob/main/bridgev2/status/bridgestate.go
- `FormatGhostMXID` — https://github.com/mautrix/go/blob/main/bridgev2/matrix/connector.go
- Localpart encoding — https://github.com/mautrix/go/blob/main/id/userid.go
- `username_template` / `phone_numbers_in_profile` defaults — https://github.com/mautrix/go/blob/main/bridgev2/matrix/mxmain/example-config.yaml
- `BeeperProfileExtra` wire format — https://github.com/mautrix/go/blob/main/event/beeper.go
- Portal re-ID (and the absence of a ghost equivalent) — https://github.com/mautrix/go/blob/main/bridgev2/portalreid.go
- WhatsApp ID builders — https://github.com/mautrix/whatsapp/blob/main/pkg/waid/id.go
- WhatsApp LID migration — https://github.com/mautrix/whatsapp/blob/main/pkg/connector/lidmigrate.go and https://github.com/mautrix/whatsapp/blob/main/CHANGELOG.md
- mautrix release blog (LID ghost replacement) — https://mau.fi/blog/2026-08-mautrix-release/
- Signal IDs — https://github.com/mautrix/signal/blob/main/pkg/signalid/ids.go ; changelog — https://github.com/mautrix/signal/blob/main/CHANGELOG.md
- Telegram IDs — https://github.com/mautrix/telegram/blob/main/pkg/connector/ids/ids.go
- Discord v2 IDs — https://github.com/mautrix/discord/blob/megadiscord/pkg/discordid/id.go
- Meta (Instagram/Messenger) IDs and `UserInfo` — https://github.com/mautrix/meta/blob/main/pkg/metaid/ids.go , https://github.com/mautrix/meta/blob/main/pkg/connector/userinfo.go
- X/Twitter IDs — https://github.com/mautrix/twitter/blob/main/pkg/connector/ids.go
- Slack IDs and own-email — https://github.com/mautrix/slack/blob/main/pkg/slackid/id.go , https://github.com/mautrix/slack/blob/main/pkg/connector/client.go
- Google Messages login prefix — https://github.com/mautrix/gmessages/blob/main/pkg/connector/login.go
- Beeper bridge-manager (self-hosted namespace) — https://github.com/beeper/bridge-manager
- Beeper bridge deploy tool (branch pinning) — https://github.com/beeper/bridge-cd-tool

**PortOS (local)**

- `server/lib/tribeMatch.js`
- `server/services/identityResolve.js`
- `server/services/contactsSync.js`
- `server/services/tribe.js`
- `server/lib/db/schema/tribe.js`
- `server/routes/tribe.js`
