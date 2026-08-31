# Beeper: what is open source, what is self-hostable, and what it means for PortOS

Research for [#4](https://github.com/tzioup/PortOS/issues/4), part of the Beeper-in-Comms map ([#1](https://github.com/tzioup/PortOS/issues/1)).
Point-in-time record, 2026-08-31. Every claim below is tagged to a primary source in [Sources](#sources).

## Verdict

**The scope call in #1 stands: self-hosting Beeper bridges inside PortOS stays out of scope.** Confirmed, not overturned.
The bridges genuinely are open source (AGPL-3.0) and genuinely are self-hostable — but not into anything PortOS could
consume. Beeper's self-hosting tool `bbctl` refuses to work with any homeserver except `beeper.com`, the homeserver
itself (`hungryserv`) has no public source, and Beeper's own recommended bridge mode (on-device) is architecturally
invisible to Matrix. Self-hosting bridges gets you a *cheaper Beeper account*, never a Beeper-free stack.

**One assumption in #1 does need amending.** "Beeper Desktop must be running" is no longer strictly true: Beeper ships a
headless **Beeper Server** that serves the same API on the same port. It is real but immature — undocumented on the
developer site, forced to the staging channel by a `TODO` in Beeper's own CLI, and unavailable on Windows. See
[§4](#4-does-beeper-desktop-have-to-be-running). The practical answer for PortOS today is still yes, but the wording
should say "a Beeper API endpoint must be running locally", not "Beeper Desktop must be running".

---

## 1. What is actually open source

Beeper's open-source page **lists components but states no licence for any of them**. Every licence below was read from
the actual `LICENSE` file or GitHub's licence API on the linked repo, not inferred.

Note the careful scoping in Beeper's own wording. The FAQ says *"Integrations that power all of our connections are open
source"* and *"we've open sourced privacy-critical portions of our codebase"*; the open-source page closes with *"This
page represents a selection of our open source work."* Nowhere does Beeper claim the product is open source.

### Open

| Component | Licence | Notes |
|---|---|---|
| 13 official bridges (WhatsApp, Telegram, Signal, Discord, Slack, Meta, X, LinkedIn, Google Messages / Chat / Voice, Bluesky, iMessage) — `github.com/mautrix/*` | **AGPL-3.0** | Verified from raw `LICENSE` on whatsapp, telegram, signal, discord, slack, meta |
| `mautrix/go` — the bridge framework, incl. `bridgev2` | **MPL-2.0** | File-level copyleft, linkable from proprietary code. The split from AGPL is deliberate |
| `mautrix/python`, `mautrix/go-util` | MPL-2.0 | |
| `beeper/bridge-manager` (`bbctl`) | **Apache-2.0** | Active: v0.15.0, 2026-07-16 |
| Desktop API SDKs — `desktop-api-js` / `-python` / `-go` / `-php` / `-openapi` / `-mcp` | **MIT** | All Stainless-generated from a private spec; mechanical clients, not the implementation |
| `beeper/cli` (`beeper-cli` on npm) | **MIT** at package level; **no root `LICENSE`** | Repo top level is unlicensed; the published npm artifact declares MIT |
| `beeper/synapse` ("Synapse with Beeper customizations"), `beeper/babbleserv` (FoundationDB homeserver) | AGPL-3.0 | Historical / experimental. Neither is confirmed to be what runs in production |
| `beeper/platform-imessage`, `beeper/barcelona` | MIT / Apache-2.0 | macOS iMessage libraries |
| Community bridges: GroupMe (AGPL-3.0), Heisenbridge/IRC (MIT) | | KakaoTalk and LINE live on a self-hosted git host — licence **not confirmed** |

### Not open

- **Beeper Desktop, iOS, and Android clients.** No client repo exists in the `beeper` org. The archived `beeper/self-host`
  README states it plainly — *"closed source forks of Element iOS and Android"*, *"closed source forks of Element
  Web/Desktop"*. That repo is obsolete and describes a superseded generation, so cite it for *closed*, not for
  *fork of Element*. Corroborating signal: `beeper/themes` exists so the community can restyle Desktop with CSS,
  which is what you publish instead of source.
- **`hungryserv`**, the production homeserver. Named first-party and current in the `bbctl` README; `beeper/hungryserv`
  404s. The only public trace is a conference talk repo by a Beeper engineer describing *"a homeserver optimized for
  unfederated use-cases"*.
- **The Desktop API server.** It ships inside the closed Desktop binary. Absent from the open-source page, no repo.
- **The account/identity system.** `bbctl`'s own source authenticates against it with the header constant
  `"BEEPER-PRIVATE-API-PLEASE-DONT-USE"`.
- **The `beeper-server` binary** (see §4) — downloaded prebuilt from Beeper's API, no public source.
- **Beeper Push Notification Service.**

### Licence exposure for PortOS

PortOS is MIT. Nothing here changes that, under either integration shape:

- **Talking to a local HTTP API** (the planned design) touches no bridge code at all. Zero exposure.
- Even a hypothetical bundled-bridge design would run AGPL bridges as **separate processes** over a socket, which is
  aggregation rather than a derived work. The exposure would be operational, not legal — but see §5 for why that design
  is dead anyway.

The one licence worth noting for a future maintainer is that `mautrix/go` is **MPL-2.0, not AGPL**. If PortOS ever wanted
to write its own bridge in Go, the framework is permissively linkable. That is a different project from this one.

---

## 2. Bridge architecture

**Matrix is the substrate, and it is real.** *"Beeper is built on top of the Matrix protocol. When you use Beeper to
message someone on WhatsApp, Telegram, or any other supported network, you're using a Matrix bridge."* A Beeper account
is a Matrix account with an MXID that can chat with the wider Matrix federation.

**The homeserver is `hungryserv`, on `beeper.com`.** Not Synapse in production. The `bbctl` README carries the caveat
that matters most here: *"hungryserv does not implement the entire Matrix client-server API, so it's possible some
bridges won't work."* `bbctl` hardcodes the homeserver domains `beeper.com` / `beeper-staging.com` / `beeper-dev.com`.

**The bridge protocol is the standard Matrix Application Service API**, carried over Beeper's appservice-websocket
transport. There is no bespoke "Beeper Bridge API". From the `bbctl` README: *"You can connect any spec-compliant Matrix
application service to your Beeper account"* and *"All bridgev2 bridges support appservice websockets, so using
`bbctl proxy` is not necessary."* Third-party bridges that don't speak the websocket protocol go through `bbctl proxy`,
which turns websocket frames into HTTP requests.

**`bridgev2` (aka "Megabridge") is the current framework**, living in `mautrix/go` under MPL-2.0. Its own docs describe
the split that explains the whole architecture: *"Matrix connectors are responsible for connecting to Matrix. Initially
there will be two Matrix connectors: one for the standard setup that connects to a Matrix homeserver as an application
service, **and another for Beeper's local bridge system**."* Twelve mautrix bridges are on `bridgev2`; Discord and
iMessage are still v1.

**Cloud versus on-device is the load-bearing distinction.** On-device: *"the chat account … is connected only to the
device you're using to set it up … Your messages never leave your device … No storage on Beeper servers."* Cloud: the
account is linked to your Beeper account and *"your data passes through our servers securely."*

Only five networks are cloud-only — **Google Messages, Google Chat, Line, Discord, Slack**. Everything else can run
on-device, and **Beeper's own developer docs recommend it**: *"For best results, prefer using On-Device Connections
instead of Beeper Cloud."* On-device also allows multiple accounts per network; cloud allows one.

---

## 3. Could a client talk to the bridges directly?

**No. Not with a workaround, not at a cost — the architecture forecloses it.** Three independent blockers, any one of
which would be sufficient:

1. **On-device bridges never touch the homeserver.** Beeper's engineering blog, on the local Signal bridge: *"Since this
   bridge is not connected in any way to your Matrix homeserver, bots or other integrations built against the Matrix
   HTTP API won't be able to interact with your chats."* A Matrix client would therefore see only cloud-connected
   networks — five of them — and Beeper actively steers users away from cloud. The Matrix path would show a shrinking
   minority of a user's chats, and *which* minority would change based on how they set each account up. That is worse
   than useless for a chat client: it is a client that silently omits conversations.

2. **There is no documented client-server surface.** No CS-API base URL, no `/login`, no token flow anywhere on
   `developers.beeper.com`. The Desktop API's own resource list — `accounts`, `bridges`, `chats`, `messages`, `assets`,
   `app/setup`, `info` — contains no Matrix resource of any kind. And the token surface was deliberately withdrawn:
   the changelog records *"**Breaking** - `client.token.*` removed"*.

3. **hungryserv doesn't implement the full CS-API anyway**, per Beeper's own caveat above, so even a reverse-engineered
   client would be building against a partial and undocumented server.

The nearest thing to a credential is `bbctl register <name> --json`, which returns an **application-service**
registration (`as_token`/`hs_token` scoped to one bridge's namespace) — not a user access token. And `bbctl login`
obtains a Beeper account token from an API that self-labels as private and asks you not to use it.

Beeper does document that your account is a Matrix account and that you can talk to Matrix users *from inside Beeper*.
It documents nothing about logging a third-party Matrix client *into* a Beeper account, and does not endorse it.

**Cost of trying anyway:** reverse-engineering an undocumented private API and a partial homeserver, against a vendor
that has already removed the token surface once, to reach a strict subset of the user's chats. There is no version of
this that is cheaper or more robust than the local HTTP API that Beeper documents, supports, and ships four SDKs for.

---

## 4. Does Beeper Desktop have to be running?

**This is the finding that amends #1.**

The developer docs are unambiguous and still say yes: *"Beeper Desktop API runs inside Beeper Desktop and requires
Beeper Desktop to be running to be accessible."* No headless mode appears anywhere on `developers.beeper.com` — the
site's sitemap contains no page mentioning a server or headless operation at all.

But `beeper/cli` documents a **local Beeper Server**: *"For a headless long-running setup on this machine, install and
adopt a local Beeper Server. The CLI manages the process — `targets start/stop/restart/logs/enable`."* It is installed
with `beeper setup --server --install`, it starts on **the same `http://127.0.0.1:23373`**, and it runs bridges itself —
the README's worked example shows `beeper accounts add` scanning a WhatsApp QR against a server target with no Desktop
in the picture. The CLI generalises the whole idea into *targets*: local Desktop, local Server, or either one remote
over OAuth/PKCE.

That would be a clean answer for PortOS — a headless Beeper on the same box, no GUI session required. Four caveats say
"not yet":

- **Forced to staging.** `beeper/cli`'s own source carries `// TODO: switch Server installs back to production once the
  production download endpoint returns a beeper-server artifact instead of the Desktop app bundle`, and the line below
  it hard-codes `kind === 'server'` to `staging`, which in turn forces the `nightly` channel and points downloads at
  `api.beeper-staging.com`. Today, `beeper install server` cannot install a production build.
- **Closed prebuilt binary.** `installServer` downloads and symlinks `beeper-server` from Beeper's download endpoint.
  No public repo, no licence — proprietary, and it does not appear in the open-source listing.
- **Not on Windows.** `installServer` throws: *"Beeper Server install is not available on Windows."*
- **Undocumented officially.** It exists in a 37-star repo whose root has no `LICENSE`, not in the developer docs.

**What this means for PortOS.** Don't design against the Server, but don't hard-code the Desktop either. The API surface,
port, and auth are identical, so a base-URL setting plus feature detection through `GET /v1/info` costs almost nothing
now and buys the headless path for free when it stabilises. Concretely: PortOS's Beeper feature detection should probe a
**configurable base URL** defaulting to `http://127.0.0.1:23373` and describe what it found as "a Beeper API endpoint",
not "Beeper Desktop". Beeper's own env var for this is `BEEPER_DESKTOP_BASE_URL`.

Worth flagging for the federation ticket: Beeper also supports **remote** targets over OAuth/PKCE, and PortOS already
has a multi-machine story. Beeper's remote-access docs are emphatic that exposing the API is risky — *"Exposing it to
the internet can expose chat history and might allow others to send messages on your behalf… Beeper is not responsible
for any consequences"* — but a tailnet is a materially different threat model from the internet. That is a question for
the federation ticket, not this one.

---

## 5. Self-hosting: what `bbctl` actually buys you

`bbctl` is real, Apache-2.0, actively maintained, and does something genuinely useful — just not the thing #1 was
worried about. *"You can connect any spec-compliant Matrix application service to your Beeper account without having to
self-host a whole Matrix homeserver"*, and *"You can also self-host the official bridges for maximum security … so that
message re-encryption happens on a machine you control rather than on Beeper servers."*

The disqualifying sentence, verbatim from the same README:

> **This tool can not be used with any other Matrix homeserver, like self-hosted Synapse instances. It is only for
> connecting self-hosted bridges to the beeper.com server.** For self-hosting the entire stack, refer to the official
> documentation of the various projects (Synapse, mautrix bridges).

So the arrow points *into* Beeper. `bbctl login` is step two of the quickstart; a Beeper account is mandatory. Its
sweeteners are real — self-hosted accounts are **free and don't count against account limits**, and you get
end-to-bridge encryption on your own hardware — but they are sweeteners on a Beeper subscription, not an exit from it.

The full-stack path Beeper redirects you to is *upstream Synapse plus mautrix bridges plus a third-party Matrix client*.
That is not a Beeper integration; it is a different product, with a homeserver to operate, and Beeper says of it:
*"We do not provide technical support for self-hosting."* Self-hosted bridges are also *"not entitled to the usual level
of customer support."* The old full-stack guide is archived and self-declares obsolete, and even it warned that Beeper's
clients can't connect to a self-hosted system.

For a single-user life dashboard whose entire value here is *fewer surfaces*, adopting a homeserver, N bridge processes,
and their upgrade treadmill to replace one local HTTP call is a straightforwardly bad trade.

---

## 6. Account requirements and pricing

- **A Beeper account is required.** The terms: *"You must create a Beeper account with us before accessing and using
  Beeper."*
- **No paid tier gates the API.** Beeper Plus ($9.99/mo) and Plus Plus ($49.99/mo) list their full feature sets and
  neither mentions the Desktop API, MCP, developer access, or automation. The tiers gate **account counts only**.
- **Free tier: 1 account per network, 5 total.** Plus: 10 total, 3 per network. Plus Plus: unlimited.
  *This is the real constraint on PortOS's usefulness* — a free-tier user sees at most five bridged networks, and it is a
  Beeper-side limit PortOS cannot work around. Self-hosted bridges via `bbctl` are the documented escape valve, since
  they are free and don't count.
- **Public beta, no waitlist.** The API is *"An experimental, locally hosted API and MCP server"*, enabled by a settings
  toggle. Note the two first-party sources disagree on the menu name (Settings → Developers vs Settings → Integrations);
  expect the onboarding copy PortOS writes to need checking against the shipped app.
- **Auth:** bearer token for every endpoint, obtained either in-app or via OAuth 2.0 + PKCE, with RFC 8414 metadata at
  `/.well-known/oauth-authorization-server`. `GET /v1/info` works pre-auth and is the natural feature-detection probe.
- **No numeric rate limits are documented anywhere.** What exists is a use posture: *"We recommend Beeper Desktop API for
  personal use only. Sending too many messages might result in account suspension by the networks. Actions like searching
  or fetching existing chats or messages are always local and can be used without limitations."* Note the suspension risk
  is attributed to the **upstream networks**, not Beeper — consistent with #1's settled position that read-and-send for
  normal personal use is fine.
- **Terms caveat worth recording.** Beeper's ToS prohibits using *"any robot, spider, scraper, deep link, or other
  similar automated data gathering or extraction tools"* to access Beeper, with no carve-out for the Desktop API, and
  reserves termination *"for any reason at our sole discretion"*. The ToS appears not to have been updated for the API's
  existence. This does not block the planned integration — a user-driven local client reading their own data is what the
  API is for — but it is one more argument for the human-in-the-loop constraint #1 already settled on, and against
  anything that looks like bulk extraction.

**Stability risk to plan around:** the API is beta with a live history of breaking changes — v0 → v1, SSE removed from
MCP, `client.token.*` removed. `bbctl` carries an analogous warning that *"the homeserver URL is not guaranteed to be
stable forever, it has changed in the past, and it may change again."* PortOS should pin the SDK version, surface the
API version from `/v1/info`, and expect to chase changes.

---

## 7. What changes in the map

Nothing structural. Three amendments:

1. **Keep self-hosting out of scope**, and record it as *decided on evidence* rather than assumed. The reason is not
   "too much work" — it is that `bbctl` points into Beeper by design and there is no homeserver to self-host.
2. **Restate the running-process assumption.** "Beeper Desktop must be running" → "a Beeper API endpoint must be
   reachable at a configurable base URL, default `http://127.0.0.1:23373`." Detect the endpoint, don't assume the app.
   The headless Server is a staging-channel preview today; design so it costs nothing to adopt later.
3. **Add the free-tier account cap (5 networks) to the ticket on onboarding/limits.** It bounds what a new user
   actually sees in the PortOS Comms tab, and PortOS should read the account list rather than promising every network.

---

## Sources

Beeper developer docs (note: prose pages serve markdown at `<path>/index.md`; top-level `.md` URLs 404):

- <https://developers.beeper.com/open-source/>
- <https://developers.beeper.com/bridges/>
- <https://developers.beeper.com/bridges/self-hosting/>
- <https://developers.beeper.com/bridges/self-hosting/deploy-to-flyio>
- <https://developers.beeper.com/desktop-api/>
- <https://developers.beeper.com/desktop-api/auth/>
- <https://developers.beeper.com/desktop-api/mcp/>
- <https://developers.beeper.com/desktop-api/websocket-experimental/>
- <https://developers.beeper.com/desktop-api/changelog/>
- <https://developers.beeper.com/desktop-api/advanced/remote-access/>
- <https://developers.beeper.com/desktop-api-reference/>
- <https://developers.beeper.com/sitemap-0.xml>

Beeper product, help, and legal:

- <https://www.beeper.com/faq>
- <https://www.beeper.com/desktop-api>
- <https://www.beeper.com/plus> · <https://www.beeper.com/plus-plus> (`/pricing` returns 404)
- <https://www.beeper.com/terms>
- <https://help.beeper.com/en_US/chat-networks/using-on-device-chat-network-connections-in-beeper>
- <https://help.beeper.com/en_US/beeper-plus/account-limits-everything-you-need-to-know>
- <https://help.beeper.com/en_US/quick-references/using-matrix-chats-in-beeper>
- <https://blog.beeper.com/2024/04/09/how-beeper-android-works/>
- <https://blog.beeper.com/2025/10/28/build-a-beeper-bridge/>

Source repositories:

- <https://github.com/beeper/bridge-manager> (Apache-2.0; README and `api/beeperapi/login.go`, `cmd/bbctl/whoami.go`)
- <https://github.com/beeper/cli> (README; `packages/cli/package.json`, `packages/cli/src/lib/installations.ts`, `packages/cli/src/commands/install/server.ts`, `packages/cli/docs/setup.md`, `packages/cli/docs/targets.md`)
- <https://github.com/beeper/self-host> (archived, self-declared obsolete — cited only for closed-source status of clients)
- <https://github.com/beeper/synapse> · <https://github.com/beeper/babbleserv> · <https://github.com/beeper/libserv>
- <https://github.com/beeper/desktop-api-js> · `-python` · `-go` · `-php` · `-openapi` · `-mcp`
- <https://github.com/beeper/themes> · <https://github.com/beeper/platform-imessage> · <https://github.com/beeper/barcelona>
- <https://github.com/mautrix> — whatsapp, telegram, signal, discord, slack, meta (AGPL-3.0 confirmed from raw `LICENSE`)
- <https://github.com/mautrix/go> (MPL-2.0) and <https://github.com/mautrix/go/blob/main/bridgev2/unorganized-docs/README.md>
- <https://github.com/sumnerevans/hungryserv-presentation> (only public trace of hungryserv)
- npm: `@beeper/desktop-api` (MIT), `@beeper/desktop-mcp`, `beeper-cli`

Unverified, recorded so it isn't re-chased: a search snippet attributed to Beeper's help site claimed *"As of Beeper
desktop client v4, the Matrix Access Token is no longer available client-side."* No live first-party page carries this.
It is consistent with the documented `client.token.*` removal, but treat it as unconfirmed.
