# API reference

Public HTTP API for the HMD WhatsApp Gateway. JSON request bodies, JSON responses, bearer-token auth. Production base URL is `https://wa.example.com`. The `/v1` prefix is a stability guarantee, fields will only be added, never removed or repurposed.

For onboarding (issuing a key, receiving webhooks, environment layout), read [`INTEGRATION.md`](./INTEGRATION.md). For the typed client, read [`SDK.md`](./SDK.md).

## Conventions

- Content type: `application/json; charset=utf-8` on every request and response.
- Every response carries an `X-Request-Id` header. Echo it back in support requests; the gateway logs the same id alongside every operation it performs.
- Field names match the Zod schemas in [`packages/protocol/src/api.ts`](../packages/protocol/src/api.ts) and [`packages/protocol/src/webhook.ts`](../packages/protocol/src/webhook.ts). Those files are the source of truth.
- All timestamps are ISO 8601 with offset (e.g. `2026-04-28T12:34:56.000Z`).

## Authentication

Send the API key as a bearer token:

```
Authorization: Bearer hmd_sk_<division>_<env>_<43-char-secret>
```

Keys are admin-issued only, there is no self-service signup. The format is `hmd_sk_<division>_<env>_<secret>` where:

- `division` identifies the HMD division (`developments`, `payments`, `core`, …).
- `env` is `test` or `live`. Test keys must only be used against test sessions.
- The secret is 32 random bytes encoded as base64url (43 characters, no padding).

Keys are shown to the admin **once** at creation. After that, only the argon2id hash and an HMAC lookup hash are stored. To rotate, ask an admin to issue a new key, swap your environment variable, then revoke the old key. See [`INTEGRATION.md`](./INTEGRATION.md) for the procedure.

Each key is bound to:

- A WhatsApp **session** (one phone number per service). All sends go to that session; you cannot pick.
- A set of **scopes** that govern which channels and read paths it may use:
  - `send:notification`, send messages on the `notification` channel.
  - `send:transactional`, send messages on the `transactional` channel.
  - `send:internal`, send messages on the `internal` channel.
  - `send:new_recipients`, defined in the protocol; the new-recipient gate is not currently enforced.
  - `read:status`, call `GET /v1/worker/status`.
  - `read:groups`, call `GET /v1/groups`.
- An optional **IP allowlist** (CIDRs) and a **per-minute rate limit**.

Missing or wrong scope returns `403 SCOPE_DENIED`. IP not in the allowlist returns `403 IP_NOT_ALLOWED`.

## Project and purpose metadata

Every API key is stamped at issuance with a `projectId` slug (regex `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, 1 to 64 lowercase kebab characters). The slug is immutable once the key is created; rotating it means revoking the key and issuing a new one. Callers never pass `projectId` on a send: it is read from the authenticated key and persisted on every resulting `MessageDoc`. The slug drives multi-tenant audit grouping, billing roll-ups, and downstream routing for the inbound reply agent (paused service). Admin-originated sends through the dashboard are stamped with the sentinel `projectId: 'admin-console'`.

Every send also declares a `purpose` (required, enum: `otp | magic_link | transactional | notification | support | marketing | campaign | newsletter | announcement | other`). `purpose` is distinct from `channel`: `channel` gates scope and worker-side throttling, `purpose` records caller intent for compliance routing, retention, and audit categorisation. There is no default; omitting it returns `400 INVALID_BODY`.

Short-lived secrets (one-time codes, magic links) are a server-side concern: enforce a short TTL and single-use semantics on the issuing side. The WhatsApp transport itself does not provide ephemerality on this stack, and treating disappearing-mode as a security control would be misleading, it does not prevent screenshots, forwarding, or notification previews.

## Rate limiting

Three fixed-window tiers run on every authenticated request, evaluated in order. Any tier rejecting the request returns `429 RATE_LIMITED`:

| Tier        | Limit                                         | Key                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global      | 10 000 requests / minute                      | `all`                                                                                                                                                                                                                      |
| Per IP      | 1200 requests / minute (env-configurable)     | client IP, derived from the configured `TRUSTED_CLIENT_IP_HEADER` (or `CF-Connecting-IP` once Cloudflare-fronted). `X-Forwarded-For` is never trusted for this decision: it is fully client-controlled once past the edge. |
| Per API key | `apiKey.rateLimitPerMin` (configured per key) | `keyId`                                                                                                                                                                                                                    |

The global tier is a hard ceiling on the gateway as a whole. Healthy production keys should never see it. The per-IP tier protects against credential stuffing.

In addition, `POST /v1/messages` enforces a **per-recipient cap of 5 sends per 10 minutes**, global across all API keys. The cap is keyed on the normalised E.164 recipient number, so spreading sends across multiple keys does not bypass it. This is OTP-bomb / abuse protection: a legitimate flow should never need to send more than a handful of messages to one number in 10 minutes. Breaching it returns `429 RATE_LIMITED`. The check is fail-closed: a Redis error on the hot send path returns `503` rather than letting an unbounded flood through.

For a key bound to an **organization**, `POST /v1/messages` additionally enforces a per-number send budget. Each WhatsApp number has its own per-minute / per-hour / per-day caps, because WhatsApp rate-limits a phone number rather than an API key. The router spreads sends across the organization's numbers and only returns `429 RATE_LIMITED` once _every_ number is out of budget, at that point the organization is genuinely over capacity, not broken. This is the one 429 that carries a `Retry-After` header, set to the next minute-bucket rollover.

Apart from that case the gateway emits no `X-RateLimit-*` or `Retry-After` headers on a 429. The SDK retries 429s with capped exponential backoff. If you call the API directly, treat a 429 as transient: back off and retry, honouring `Retry-After` when present.

## Idempotency

`POST /v1/messages` accepts an `idempotencyKey` field in the body (8–128 characters). The pair `(apiKeyId, idempotencyKey)` is uniquely indexed in MongoDB.

- First call with a given key inserts a `MessageDoc` and returns `202` with `messageId`.
- A replay (same `apiKey` + same `idempotencyKey`) returns `200` with the original `messageId` and `idempotent: true`. No new message is enqueued.
- The window is effectively the message TTL (default 30 minutes, max 24 hours). Choose a stable key tied to your domain object, order id, ticket id, alert hash.

The SDK forwards the same key on every retry, so transient 429/5xx never produce duplicates.

## Error envelope

Every non-2xx response uses the same flat shape:

```json
{
  "error": "Missing scope: send:transactional",
  "code": "SCOPE_DENIED",
  "requestId": "req_01HG…"
}
```

- `error`, human-readable, may change without notice. Do not match on this.
- `code`, stable identifier. Always match on `code`.
- `requestId`, included in every error and in the `X-Request-Id` response header. Quote it in support tickets.

Some endpoints add a `details` object with structured context. Treat it as informational.

## Error codes

Defined in [`packages/protocol/src/errors.ts`](../packages/protocol/src/errors.ts). Match on the constant, never on the message.

| Code                     | Typical HTTP | Meaning                                                                                                                                               |
| ------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_PHONE`          | 400          | `to` could not be normalised to E.164.                                                                                                                |
| `INVALID_CONTENT`        | 400          | An `image` or `document` `url` failed host validation (non-HTTPS, unresolvable, or resolves to a private/loopback/link-local/CGNAT/metadata address). |
| `INVALID_BODY`           | 400 / 404    | JSON parse failure, schema violation, or path resource not found.                                                                                     |
| `UNAUTHORIZED`           | 401          | Missing, malformed, revoked, or unrecognised bearer token.                                                                                            |
| `SCOPE_DENIED`           | 403          | Key authenticated but lacks the required scope, or the path-positional `sessionId` does not match the key's bound session.                            |
| `IP_NOT_ALLOWED`         | 403          | Client IP not in the key's CIDR allowlist.                                                                                                            |
| `WEBAUTHN_REQUIRED`      | 403          | Reserved, not currently emitted. Intended for admin WebAuthn step-up flows.                                                                           |
| `RECIPIENT_NOT_FOUND`    | 404          | A `replyTo` target or reaction target is unknown to this session (foreign, deleted, or owned by a different session).                                 |
| `IDEMPOTENCY_CONFLICT`   | 409          | Reserved for replay collisions where the body differs from the original.                                                                              |
| `PAYLOAD_TOO_LARGE`      | 413          | Request body exceeded 64 KiB.                                                                                                                         |
| `UNSUPPORTED_MEDIA_TYPE` | 415          | Reserved, not currently emitted. Content-type enforcement is not active.                                                                              |
| `INVALID_REACTION`       | 422          | Reaction body fails the schema (empty emoji on POST, non-emoji string), or the target message is not yet sent (no `waMessageId`).                     |
| `INVALID_PRESENCE_STATE` | 422          | Presence body fails `PresenceStateSchema`.                                                                                                            |
| `SEND_AT_PAST`           | 422          | `sendAt` is in the past, less than 30 s in the future, or more than 30 days away.                                                                     |
| `OPTED_OUT`              | 422          | Recipient is on this session's opt-out registry.                                                                                                      |
| `RATE_LIMITED`           | 429          | One of the three rate-limit tiers tripped.                                                                                                            |
| `VELOCITY_EXCEEDED`      | 429          | Reserved, not currently emitted. The only active per-recipient mechanism is the 5/10-min cap, which returns `RATE_LIMITED`.                           |
| `NEW_RECIPIENT_BLOCKED`  | 429          | Reserved, not currently emitted. The new-recipient gate has been removed.                                                                             |
| `WORKER_UNAVAILABLE`     | 503          | The bound session (or, for an organization key, none of its numbers) is not currently connected, offline, mid-pairing, or stopped.                    |
| `MAINTENANCE`            | 503          | Reserved, not currently emitted. Intended for gateway maintenance mode.                                                                               |
| `INTERNAL`               | 500          | Unhandled server error; the request id is the only useful artefact.                                                                                   |

## Endpoints

### `GET /api/health`

Public liveness. No auth, no data-store traffic.

```
curl https://wa.example.com/api/health
```

Response `200`:

```json
{
  "ok": true,
  "service": "hmd-wa-gateway",
  "time": "2026-04-28T12:34:56.000Z"
}
```

### `POST /v1/messages`, enqueue an outbound message

- **Auth:** API key.
- **Scope:** one of `send:notification`, `send:transactional`, `send:internal`, picked from the request's `channel`.
- **Body limit:** 64 KiB.

Request body (`SendMessageRequestSchema`):

| Field              | Type                                                                                                                                                | Required                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `to`               | string (6–40 chars)                                                                                                                                 | yes                            | Recipient phone in E.164 (`+447700900123`) or any form the gateway can normalise, **or** a WhatsApp group JID (`120363XXXXXXXXXXXX@g.us`) for a standalone group send. See [Sending to a group](#sending-to-a-group).                                                                                                                                                                                                                                                                                                                            |
| `channel`          | `'notification' \| 'transactional' \| 'internal'`                                                                                                   | no (default `'transactional'`) | Drives the scope check and the worker's per-category throttle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `purpose`          | `'otp' \| 'magic_link' \| 'transactional' \| 'notification' \| 'support' \| 'marketing' \| 'campaign' \| 'newsletter' \| 'announcement' \| 'other'` | yes                            | Caller intent for audit, retention, and compliance routing. No default; omitting returns `400 INVALID_BODY`. Pick the narrowest value: `otp` for one-time codes, `magic_link` for sign-in links, `transactional` for receipts/order updates, `notification` for non-urgent state changes, `support` for human-to-customer replies, `marketing`/`campaign`/`newsletter`/`announcement` for promotional or bulk content (requires opt-in), `other` only when nothing else fits. See [Project and purpose metadata](#project-and-purpose-metadata). |
| `body`             | discriminated union on `kind`                                                                                                                       | yes                            | One of the three kinds below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `idempotencyKey`   | string (8–128)                                                                                                                                      | no                             | Replay-safe; see [Idempotency](#idempotency).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ttlSeconds`       | integer (30–86 400)                                                                                                                                 | no (default 1800)              | Drop the message if still queued after this many seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `replyTo`          | `{ messageId: string }`                                                                                                                             | no                             | Quote a prior outbound message we sent on this session. The recipient's WhatsApp client renders the quote inline. The `messageId` is the gateway UUID returned from a previous `POST /v1/messages`. Foreign or cross-session ids return `404 RECIPIENT_NOT_FOUND`. Inbound replies (quoting a peer's message) are reserved for a later slice.                                                                                                                                                                                                    |
| `sendAt`           | string (ISO 8601 UTC)                                                                                                                               | no                             | Schedule the send for a future minute. Minimum 30 s in the future, maximum 30 days. Returns `status: 'scheduled'`; a per-minute cron dispatches it. See [Scheduled Sends](#scheduled-sends).                                                                                                                                                                                                                                                                                                                                                     |
| `confirm`          | boolean                                                                                                                                             | no (default `false`)           | Wait for a terminal worker ack and return `'sent' \| 'failed' \| 'queued'` synchronously. See [Synchronous confirm](#synchronous-confirm). Cannot be combined with `sendAt` (returns `422 INVALID_BODY`).                                                                                                                                                                                                                                                                                                                                        |
| `confirmTimeoutMs` | integer (300–30 000)                                                                                                                                | no (default 5000)              | Maximum time the gateway waits for the ack before returning `status: 'queued'`. Only meaningful when `confirm` is true.                                                                                                                                                                                                                                                                                                                                                                                                                          |

Body kinds:

```ts
{ kind: 'text', text: string }                                              // text up to 4096 chars
{ kind: 'image', url: string, caption?: string }                            // caption up to 1024
{ kind: 'document', url: string, filename?: string, caption?: string }
```

For `image` and `document`, `url` must be `https://` and is host-validated at send time: the
gateway resolves the hostname and rejects it, before any DB or session work, if the scheme is not
HTTPS or any resolved address is loopback, link-local, private (RFC 1918), CGNAT, or a cloud
metadata address, returning `400 INVALID_CONTENT`. This is resolve-time host validation only; the
gateway does not fetch or inspect the media content itself, that happens later when the paired
WhatsApp client retrieves the URL.

Response `202` (`SendMessageResponseSchema`):

```json
{
  "messageId": "8e8f3a26-…",
  "status": "queued"
}
```

Or `202` with `status: 'scheduled'` when `sendAt` is supplied:

```json
{
  "messageId": "8e8f3a26-…",
  "status": "scheduled"
}
```

Or `200` on idempotent replay:

```json
{
  "messageId": "8e8f3a26-…",
  "status": "queued",
  "idempotent": true
}
```

`status` values on this response: `queued` (immediate dispatch) or `scheduled` (parked until `sendAt`). Poll `GET /v1/messages/:messageId` to observe the transition once the cron picks it up. With `confirm: true` the response is `200` and the status set widens, see [Synchronous confirm](#synchronous-confirm).

Errors: `INVALID_BODY` (also fires when `purpose` is missing), `INVALID_PHONE`, `SCOPE_DENIED`, `RECIPIENT_NOT_FOUND` (replyTo target), `OPTED_OUT`, `SEND_AT_PAST`, `PAYLOAD_TOO_LARGE`, `WORKER_UNAVAILABLE`, `RATE_LIMITED`.

Example `400 INVALID_BODY` for a missing `purpose`:

```json
{
  "error": "Required field 'purpose' is missing.",
  "code": "INVALID_BODY",
  "requestId": "req_01HG…",
  "details": { "path": ["purpose"], "issue": "required" }
}
```

#### Synchronous confirm

Pass `confirm: true` when the caller needs to know whether the message reached the worker before deciding to fall back to another channel (email for OTP, SMS for password reset, etc.). The gateway subscribes to a per-message Redis channel before publishing the outbound, awaits the worker's terminal ack, and returns within `confirmTimeoutMs`.

Response `200`:

```json
{
  "messageId": "8e8f3a26-…",
  "status": "sent",
  "requestId": "req_…"
}
```

```json
{
  "messageId": "8e8f3a26-…",
  "status": "failed",
  "errorCode": "SEND_FAILED",
  "requestId": "req_…"
}
```

```json
{
  "messageId": "8e8f3a26-…",
  "status": "queued",
  "requestId": "req_…"
}
```

`status: 'queued'` means the gateway timed out waiting for the ack, the message MAY still arrive on WhatsApp later. Treat anything other than `'sent'` as a fall-back trigger; pair every confirm-mode call with an `idempotencyKey` so a downstream retry on the same key does not double-send.

Idempotent replay with `confirm: true` short-circuits without subscribing: a prior message in a terminal status returns immediately with `idempotent: true`, mapping `delivered`/`read` to `'sent'` and `expired` to `'failed'` with `errorCode: 'EXPIRED'`. A prior message still `queued` falls through to a subscribe-only wait (no republish).

When to use:

- Auth-critical flows where missing the message is more expensive than waiting up to `confirmTimeoutMs` (login alerts, OTP, password reset, payment confirmations).
- Anything that fans out to many recipients (notifications, marketing), stay on the default async path; webhooks carry the receipt.

```
curl -X POST https://wa.example.com/v1/messages \
  -H "Authorization: Bearer $HMD_WA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+447700900123",
    "channel": "transactional",
    "purpose": "transactional",
    "body": { "kind": "text", "text": "Order #4711 confirmed." },
    "idempotencyKey": "order-4711-confirm"
  }'
```

A short-lived OTP send is just a normal text send with `purpose: 'otp'`. Confidentiality of the code is the issuer's responsibility, short TTL, single-use, server-side:

```
curl -X POST https://wa.example.com/v1/messages \
  -H "Authorization: Bearer $HMD_WA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+447700900123",
    "channel": "transactional",
    "purpose": "otp",
    "body": { "kind": "text", "text": "Your code is 482913." }
  }'
```

#### Sending to a group

Pass a WhatsApp group JID (`120363XXXXXXXXXXXX@g.us`) as `to` to send to a group instead of a DM. The gateway validates the JID shape and dispatches it through the same publish path as a DM send, no other field changes.

**Finding a group's JID.** The paired number must be a member of the group; the gateway can only see and send to groups its own session belongs to. A group JID is not shown anywhere in the WhatsApp app, so read it from the API: call [`GET /v1/groups`](#get-v1groups--list-groups) (requires the `read:groups` scope) and take `jid` from any entry. Inbound webhooks do not carry the group JID (their `from` is an E.164 phone), so `GET /v1/groups` is the way to discover it.

Caveats:

- Group quoting (`replyTo`) is not supported yet; a group send with `replyTo` returns `422 INVALID_BODY`. Quoting a group message needs the original sender's `participantJid`, which the gateway does not yet resolve.
- The opt-out registry does not apply to groups (it is keyed on phone number); a group send is never blocked by `OPTED_OUT`.
- `sendAt` (scheduled sends) works normally for groups.

```
curl -X POST https://wa.example.com/v1/messages \
  -H "Authorization: Bearer $HMD_WA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "120363012345678901@g.us",
    "channel": "notification",
    "purpose": "notification",
    "body": { "kind": "text", "text": "Standup in 10 minutes." }
  }'
```

### `GET /v1/messages`, list messages

- **Auth:** API key.
- **Scope:** none beyond authentication.

Query parameters:

| Param    | Type    | Default | Notes                                                          |
| -------- | ------- | ------- | -------------------------------------------------------------- |
| `limit`  | integer | 50      | Capped server-side at 200.                                     |
| `before` | string  | ,       | Cursor: `messageId` of the oldest item from the previous page. |

Response `200` (`ListMessagesResponseSchema`):

```json
{
  "messages": [
    {
      "messageId": "8e8f3a26-…",
      "to": "+447700900123",
      "channel": "transactional",
      "purpose": "transactional",
      "status": "delivered",
      "createdAt": "2026-04-28T12:34:56.000Z",
      "body": { "kind": "text" }
    }
  ]
}
```

The body is intentionally summarised (`{ kind }` only) to avoid leaking content in list views. `purpose` echoes the value supplied on the original send.

```
curl "https://wa.example.com/v1/messages?limit=20" \
  -H "Authorization: Bearer $HMD_WA_API_KEY"
```

### `GET /v1/messages/:messageId`, single message detail

- **Auth:** API key.
- **Scope:** none beyond authentication. The key must own the message.

Response `200` (`GetMessageResponseSchema`):

```json
{
  "messageId": "8e8f3a26-…",
  "to": "+447700900123",
  "channel": "transactional",
  "purpose": "transactional",
  "status": "delivered",
  "statusHistory": [
    { "status": "queued", "at": "2026-04-28T12:34:56.000Z" },
    { "status": "sent", "at": "2026-04-28T12:34:57.120Z" },
    { "status": "delivered", "at": "2026-04-28T12:34:59.480Z" }
  ],
  "createdAt": "2026-04-28T12:34:56.000Z",
  "ttlExpiresAt": "2026-04-28T13:04:56.000Z",
  "errorCode": null,
  "body": { "kind": "text" }
}
```

`purpose` is the value supplied on the send call, persisted on the `MessageDoc` alongside the API key's `projectId`. A foreign or unknown `messageId` returns `404 INVALID_BODY`.

### `GET /v1/groups`, list groups

- **Auth:** API key.
- **Scope:** `read:groups`.

Discover the WhatsApp group JIDs the calling API key's bound session belongs to, so one can be passed as `to` on `POST /v1/messages` (see [Sending to a group](#sending-to-a-group)). Results are strictly scoped to the calling key's own session, a key can never see another session's groups. A group only appears once the session has seen at least one message in it (live or history-synced); there is no way to enumerate a session's groups before any traffic has flowed.

Beyond `jid` and `lastActivityAt`, each entry may also carry group metadata (`subject`, `subjectOwner`, `subjectTime`, `creation`, `owner`, `desc`, `descId`, `announce`, `restrict`, `size`, `ephemeralDuration`, `inviteCode`, `participants`, `metadataFetchedAt`) when the gateway has captured it. The worker fetches this metadata on connect (`groupFetchAllParticipating()`) and refreshes it on group and participant-change events, pushing it to the gateway to be cached. All of these fields are optional: a group with chat activity but no captured metadata still appears in the list, simply without them, and older or unrefreshed groups may be missing individual fields. `metadataFetchedAt` is the point-in-time the gateway last captured this group's metadata, so treat it as potentially briefly stale. The endpoint stays DB-only and keeps working when the worker is offline, serving whatever metadata was last captured. `jid` and `lastActivityAt` are unchanged in shape and meaning, so existing integrations keep working untouched.

> **Privacy note.** `participants` lists every group member's JID (their phone number, in effect) together with their admin role (`'admin' | 'superadmin' | null`), for every member of the group, not only those who have messaged the bound session directly. This is exposed to any API key holding the `read:groups` scope. Previously that scope revealed only group JIDs; issuing `read:groups` now also hands out group membership. Bear this in mind before granting the scope to a key.

Response `200` (`ListGroupsResponseSchema`):

```json
{
  "groups": [
    {
      "jid": "120363012345678901@g.us",
      "lastActivityAt": "2026-07-15T09:12:00.000Z",
      "subject": "Ops Team",
      "subjectOwner": "447700900123@s.whatsapp.net",
      "subjectTime": "2026-06-01T10:00:00.000Z",
      "creation": "2026-01-10T08:30:00.000Z",
      "owner": "447700900123@s.whatsapp.net",
      "desc": "Internal operations coordination.",
      "descId": "ABCDEF123456",
      "announce": false,
      "restrict": false,
      "size": 3,
      "ephemeralDuration": 0,
      "inviteCode": "AbCdEfGhIjKlMnOp",
      "participants": [
        { "jid": "447700900123@s.whatsapp.net", "admin": "superadmin" },
        { "jid": "447700900456@s.whatsapp.net", "admin": null }
      ],
      "metadataFetchedAt": "2026-07-15T09:00:00.000Z"
    }
  ]
}
```

An empty `groups` array is returned (never an error) when the session has no persisted group activity yet.

For a key bound to an `orgId`, this listing reflects the key's statically bound session only, whereas `POST /v1/messages` routes each send to whichever number the organization picks. If a send is routed to a number that is not a member of the listed group, that send fails at the WhatsApp layer. Listing the union across an organization's numbers is a possible future change; for now, prefer a single-session key when working with groups.

```
curl https://wa.example.com/v1/groups \
  -H "Authorization: Bearer $HMD_WA_API_KEY"
```

### `POST /v1/messages/:messageId/reactions`, set a reaction

- **Auth:** API key.
- **Scope:** `send:transactional`.

Sets (or replaces) the reaction this session has on a prior outbound message. WhatsApp's protocol allows one reaction per `(sender, message)` pair; a second call replaces the first. The path-positional `messageId` is the gateway UUID returned by a previous `POST /v1/messages`; the message must belong to the same session as the calling key.

Request body (`ReactionRequestSchema`):

| Field   | Type               | Required | Notes                                                                                                       |
| ------- | ------------------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `emoji` | string (1–8 chars) | yes      | Must contain at least one Extended Pictographic codepoint. Empty string is rejected, use `DELETE` to clear. |

Response `202` (`ReactionResponseSchema`):

```json
{
  "messageId": "1f0a4c…",
  "emoji": "👍",
  "status": "queued"
}
```

The `messageId` returned is the gateway-side id of the reaction operation, not the original message.

Errors: `INVALID_BODY` (path id not a UUID, malformed JSON), `INVALID_REACTION` (empty emoji, non-emoji string, or target not yet sent), `RECIPIENT_NOT_FOUND` (target unknown or in another session), `SCOPE_DENIED`, `WORKER_UNAVAILABLE`.

Audited as `message.react`.

```
curl -X POST https://wa.example.com/v1/messages/8e8f3a26-…/reactions \
  -H "Authorization: Bearer $HMD_WA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "emoji": "👍" }'
```

### `DELETE /v1/messages/:messageId/reactions`, clear a reaction

- **Auth:** API key.
- **Scope:** `send:transactional`.

Clears the reaction this session set on the message. No request body. Idempotent, calling against a message with no current reaction is a no-op as far as the recipient sees.

Response `202` (`ReactionResponseSchema`):

```json
{
  "messageId": "1f0a4c…",
  "emoji": "",
  "status": "queued"
}
```

Errors: same set as the POST, minus `INVALID_REACTION` from body parsing (the schema is not consulted, there is no body).

Audited as `message.unreact`.

```
curl -X DELETE https://wa.example.com/v1/messages/8e8f3a26-…/reactions \
  -H "Authorization: Bearer $HMD_WA_API_KEY"
```

### `POST /v1/sessions/:sessionId/presence`, push a presence update

- **Auth:** API key.
- **Scope:** `send:transactional`.

Push a presence indicator for this session. Fire-and-forget: there is no pending-queue entry. If the worker is offline at dispatch time the update is silently dropped, which is the right semantics for an ephemeral indicator. The path `sessionId` MUST match the API key's bound session, otherwise `403 SCOPE_DENIED`.

Request body (`PresenceRequestSchema`):

| Field   | Type                                                                     | Required | Notes                                                                                                                                  |
| ------- | ------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `state` | `'available' \| 'unavailable' \| 'composing' \| 'recording' \| 'paused'` | yes      | `available`/`unavailable` set the session's overall presence; `composing`/`recording`/`paused` are per-chat indicators (require `to`). |
| `to`    | string (6–20 chars)                                                      | no       | Recipient phone in E.164. When present, the indicator is scoped to that chat.                                                          |

Response `200` (`PresenceResponseSchema`):

```json
{ "status": "queued" }
```

Returns 200 whether or not the worker is currently online.

Errors: `INVALID_BODY` (malformed JSON), `INVALID_PRESENCE_STATE` (body fails the schema), `INVALID_PHONE` (`to` cannot be normalised), `SCOPE_DENIED` (path session doesn't match the key, or scope missing), `WORKER_UNAVAILABLE`.

Audited as `session.presence`.

> **Privacy.** Presence leaks identity and activity to the recipient (online status, "typing…"). Treat it like read receipts when reasoning about disclosure. See [`SECURITY.md`](./SECURITY.md#read-receipts-and-presence) and the per-session toggle below.

```
curl -X POST https://wa.example.com/v1/sessions/session-a/presence \
  -H "Authorization: Bearer $HMD_WA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "state": "composing", "to": "+447700900123" }'
```

### `GET /v1/worker/status`, session / worker health

- **Auth:** API key.
- **Scope:** `read:status`.

Returns the bound session's view. Heartbeats older than 60 seconds map `status` to `offline` regardless of the underlying row.

Response `200` (`WorkerStatusResponseSchema`):

```json
{
  "workerId": "wa-m1-bursa-01",
  "sessionId": "session-a",
  "status": "connected",
  "lastHeartbeatAt": "2026-04-28T12:34:55.500Z",
  "connectedAt": "2026-04-28T08:00:01.000Z",
  "phoneE164": "+447700900123",
  "version": "0.5.2",
  "queueDepth": 0
}
```

`status` values: `initialising`, `pairing`, `connected`, `degraded`, `offline`, `stopped`. Only `connected` accepts new sends.

### Admin endpoints

All `/v1/admin/*` and `/api/admin/*` endpoints require an active admin session cookie. They are **not** intended for service-to-service use; the SDK exposes them only for HMD ops tooling running with admin credentials.

#### `GET /api/admin/sessions/:id/threads`, list conversations for a session

- **Auth:** admin session cookie. **No** WebAuthn step-up required (read-only).
- **Rate limit:** 120 requests/min per admin session.

Lists distinct counterparties the session has exchanged messages with, newest activity first. Threads are derived by union-aggregating outbound (`messages`) and inbound (`inbound_messages`) collections per session, no separate "threads" collection exists.

Query parameters:

| Name     | Type   | Notes                                                                                                                                                                                                                                                                  |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor` | string | Opaque base64 cursor returned by the previous page. Omit on first call.                                                                                                                                                                                                |
| `search` | string | Case-insensitive substring match on counterparty E.164 OR the truncated 120-char preview of the latest message. Inputs shorter than 2 chars are ignored at the repo layer. Hits in long messages past the first 120 characters of the most recent body will not match. |
| `limit`  | int    | Default 50, clamped to `[1, 100]`.                                                                                                                                                                                                                                     |

Response (200):

```json
{
  "items": [
    {
      "counterparty": "+447700900123",
      "lastMessageAt": "2026-04-29T12:34:56.000Z",
      "lastMessagePreview": "Your booking is confirmed.",
      "lastMessageDirection": "out",
      "lastMessageStatus": "delivered",
      "unreadCount": 0
    }
  ],
  "nextCursor": "eyJ0cyI6Ii4uLiIsImlkIjoiKzQ0Li4uIn0"
}
```

`unreadCount` is a heuristic: inbound messages from this counterparty whose timestamp is later than the most recent outbound. There is no admin "mark read" yet. `lastMessageStatus` is present only when `lastMessageDirection === 'out'`.

`nextCursor` is `null` when the page is the last one. Pagination is by `(lastMessageAt, counterparty)` and stable across pages.

Errors: 401 / 403 (admin guard), 400 `INVALID_BODY` on bad cursor / limit / session id, 404 `INVALID_BODY` when the session does not exist, 429 `RATE_LIMITED` on per-session limiter exhaustion.

#### `GET /api/admin/sessions/:id/threads/:e164`, list messages within a thread

- **Auth:** admin session cookie. **No** WebAuthn step-up required (read-only).
- **Rate limit:** 120 requests/min per admin session.

The `:e164` path segment is the counterparty E.164 (the `+` may be percent-encoded as `%2B`). Returns newest-first; the admin UI reverses for display.

Query parameters:

| Name     | Type   | Notes                                                                   |
| -------- | ------ | ----------------------------------------------------------------------- |
| `cursor` | string | Opaque base64 cursor returned by the previous page. Omit on first call. |
| `limit`  | int    | Default 50, clamped to `[1, 100]`.                                      |

Response (200):

```json
{
  "items": [
    {
      "messageId": "9c2e...-uuid",
      "direction": "out",
      "ts": "2026-04-29T12:34:56.000Z",
      "body": { "kind": "text", "text": "Hello." },
      "status": "delivered"
    },
    {
      "messageId": "01J7...-inboundId",
      "direction": "in",
      "ts": "2026-04-29T12:33:01.000Z",
      "body": { "kind": "text", "text": "Hi." }
    }
  ],
  "nextCursor": null
}
```

Body kinds: `text` carries `text`; `image` and `document` may carry `caption` and `mediaFileName`; `audio | video | sticker | other` carry only the kind tag. `status` is set on outbound items only (`queued | scheduled | sent | delivered | read | failed | expired`).

**Edit / delete history.** When a message has been edited or deleted on WhatsApp, the response item carries an additional `revisions[]` array (chronological), plus the derived fields `latestBody`, `editedAt`, `deletedAt`. Originals are never mutated; the admin UI expands the accordion on click to recover prior content. Each revision row carries `{ revisionSeq, kind: 'edit' | 'delete', body?, deletedBy?, ts }`.

**Quoted replies + reactions.** Items may also carry `replyTo` (`{ messageId | null, waMessageId, fromMe, bodyPreview? }`) and `reactions[]` (`{ fromJid, fromE164 | null, emoji, ts }`). Inbound `replyTo` is currently outbound-only, Baileys' `contextInfo.stanzaId` capture for inbound is a worker-side follow-up; until it lands, inbound items render the quote chrome only when a peer has replied to one of our outbound messages.

Errors: 401 / 403 (admin guard), 400 `INVALID_BODY` on invalid `:e164`, cursor, or limit, 404 `INVALID_BODY` when the session does not exist, 429 `RATE_LIMITED` on per-session limiter exhaustion. An empty thread returns `200 { items: [], nextCursor: null }`, there is no separate "thread not found" status.

#### `GET /api/admin/sessions/:id/contacts`, per-session contact book

- **Auth:** admin session cookie. **No** WebAuthn step-up required (read-only).
- **Rate limit:** 120 requests/min per admin session.

Returns the contacts captured during history sync on first pair plus any live `contacts.upsert`/`contacts.update` events since. Used by the WhatsApp Web admin viewer's left rail to render avatars and display names.

Response (200):

```json
{
  "contacts": [
    {
      "sessionId": "acme",
      "e164": "+447777777777",
      "waJid": "447777777777@s.whatsapp.net",
      "displayName": "Jane Doe",
      "pushName": "Jane",
      "profilePictureUrl": "https://...",
      "isBusiness": false,
      "lastSeenAt": "2026-05-09T18:21:00.000Z",
      "capturedAt": "2026-04-30T10:00:00.000Z",
      "source": "history"
    }
  ]
}
```

Sessions paired before the 2026-05-10 worker rollout will have an empty contacts list until either the worker re-emits or a backfill script runs, clients should fall back to deriving avatars from threads (initials).

#### `POST /api/admin/sessions/:id/send`, send a message from the admin dashboard

- **Auth:** admin session cookie. **WebAuthn step-up required** (step-up must be fresh within 5 minutes; returns `403` if absent or expired).
- Rate-limited via the per-admin sliding window (120 req/min).
- Scheduled sends are not supported on this endpoint; use the public API for those.

Request body:

```json
{
  "to": "+447700900000",
  "body": { "kind": "text", "text": "Hello from the dashboard." },
  "purpose": "transactional",
  "replyTo": { "messageId": "uuid-of-prior-message" }
}
```

`purpose` is required and follows the same enum and semantics as the public `POST /v1/messages` endpoint. `replyTo` is optional. `body.kind` must be one of `text`, `image`, or `document`; image and document bodies follow the same shape as the public API. The `to` field is normalised (leading `+` required).

Response `201`:

```json
{
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued"
}
```

The message is persisted with `origin: 'admin'`, `apiKeyId: '__admin__'`, and sentinel `projectId: 'admin-console'`, distinguishing it from SDK-originated sends in the audit log. It is published immediately on the worker's outbound channel; if the worker is offline the message sits in the pending list until reconnection.

Errors: `401` / `403` (admin guard or expired step-up), `400 INVALID_BODY`, `400 INVALID_PHONE`, `404 INVALID_BODY` (session or reply target not found), `422 OPTED_OUT`, `503 WORKER_UNAVAILABLE` (session not connected), `429 RATE_LIMITED`, `413 PAYLOAD_TOO_LARGE`.

Audited as `message.send.admin` (records `{ sessionId, to, kind }`).

#### `GET /api/admin/sessions/:id/metrics`, 24-hour session metrics

- **Auth:** admin session cookie. No WebAuthn step-up required.
- Rate-limited via the per-admin sliding window (120 req/min).
- Results are cached in Redis for 30 seconds keyed by session id.

Response `200`:

```json
{
  "sessionId": "session-a",
  "window": { "from": "2026-04-28T14:00:00.000Z", "to": "2026-04-29T14:00:00.000Z" },
  "messages": {
    "sent24h": 142,
    "received24h": 37,
    "failed24h": 2,
    "sentSparkline": [{ "hour": 0, "count": 4 }, "…23 points total…"],
    "receivedSparkline": [{ "hour": 0, "count": 1 }, "…"]
  },
  "webhooks": { "delivered24h": 138, "failed24h": 0 },
  "workerStatus": "connected",
  "cachedAt": "2026-04-29T14:00:12.000Z"
}
```

`sentSparkline` and `receivedSparkline` are 24 points. `hour: 0` is the oldest bucket (24 h ago), `hour: 23` is the most recent full hour. Webhook figures reflect only routes scoped to this session; API-key-scoped routes are excluded. `workerStatus` mirrors the session's current `status` field from MongoDB.

Errors: 401 / 403 (admin guard), 400 `INVALID_BODY`, 404 (session not found), 429 `RATE_LIMITED`.

#### `PATCH /api/admin/sessions/:id`, update conversation config

- **Auth:** admin session cookie. **No** WebAuthn step-up required.
- Note the prefix: this endpoint lives under `/api/admin`, not `/v1/admin`. It is part of the admin UI surface, not the versioned public API.

Updates the per-session conversation toggles under `conversation`: `sendReadReceipts` (boolean): when `false`, the worker stops calling `sock.readMessages([key])` on inbound messages, so the peer sees only a single grey tick; default is `true`. `optOutKeywords` (array of trimmed strings, 1–32 chars each, up to 10 entries): see [`optOutKeywords` session config](#optoutkeywords-session-config). Unknown top-level keys are tolerated (passthrough), so future fields can land without breaking older admin clients.

Request body:

```json
{
  "conversation": {
    "sendReadReceipts": false
  }
}
```

Response `200`:

```json
{
  "session": {
    "sessionId": "session-a",
    "...": "…",
    "conversation": { "sendReadReceipts": false }
  }
}
```

Errors: `INVALID_BODY` (schema violation, session not found), `PAYLOAD_TOO_LARGE` (>16 KiB), `UNAUTHORIZED`.

Audited as `session.conversation.update` (records `{ before, after }`).

#### `GET /v1/admin/webhooks`, list routes

Query: `?apiKeyId=…` or `?sessionId=…` filters. `?includeRevoked=1` includes revoked rows.

Response `200`:

```json
{
  "routes": [
    {
      "routeId": "rt_01HG…",
      "scope": { "kind": "session", "sessionId": "session-a" },
      "url": "https://hooks.example.com/wa",
      "events": ["message.delivered", "message.failed", "inbound.received"],
      "active": true,
      "description": "session-a primary",
      "secretFingerprint": "Yk3vQ1pXfA",
      "createdAt": "2026-04-28T08:00:00.000Z",
      "createdBy": "admin@example.com",
      "lastDeliveryAt": "2026-04-28T12:34:56.000Z",
      "lastDeliveryStatus": "sent",
      "lastDeliveryHttpStatus": 204,
      "revokedAt": null
    }
  ]
}
```

#### `POST /v1/admin/webhooks`, create route

Requires a fresh WebAuthn step-up. Returns the raw secret **once**.

Request:

```json
{
  "scope": { "kind": "session", "sessionId": "session-a" },
  "url": "https://hooks.example.com/wa",
  "events": ["message.delivered", "message.failed", "inbound.received"],
  "description": "session-a primary"
}
```

The `scope` discriminator is `apiKey` (`{ kind: 'apiKey', apiKeyId }`) or `session` (`{ kind: 'session', sessionId }`). `url` must be HTTPS. `events` is a non-empty subset of `WebhookEventTypeSchema`.

Response `201`:

```json
{
  "route": { "routeId": "rt_…", "secretFingerprint": "Yk3vQ1pXfA", "...": "…" },
  "secret": "8b3a…"
}
```

The `secret` field is the raw HMAC key. Store it in your secrets manager and put it on the receiving service's `HMD_WA_WEBHOOK_SECRET` env var. The gateway never returns it again.

#### `PATCH /v1/admin/webhooks/:routeId`, update route

Requires WebAuthn step-up. At least one field must be present:

```json
{
  "url": "https://hooks.example.com/wa-v2",
  "events": ["message.delivered", "message.failed"],
  "active": true,
  "description": "session-a primary, post-migration"
}
```

In-place secret rotation is not supported. To rotate a webhook secret, create a new route, switch the consumer, then delete the old route.

#### `DELETE /v1/admin/webhooks/:routeId`, revoke route

Requires WebAuthn step-up. Sets `revokedAt` and `active=false`. Pending deliveries against the route are abandoned on the next cron tick.

Response `200`:

```json
{ "revoked": true }
```

#### `POST /v1/admin/webhooks/:routeId/test`, send a synthetic event

Requires WebAuthn step-up. Signs and POSTs a `webhook.test` event to the route's URL synchronously, then returns the upstream response. Bypasses the cron queue.

Response `200`:

```json
{
  "ok": true,
  "httpStatus": 204,
  "durationMs": 137,
  "error": null
}
```

`ok` is `true` only when the upstream returned 2xx. Non-2xx, timeouts (5 s), and transport errors all set `ok: false`.

### `GET /v1/worker/sessions/:id/config`, worker-internal (not public)

Listed for completeness. **This endpoint is for the Mac worker, not for HMD service teams.** It is gated by a worker JWT (different auth path from API keys) and refuses any caller whose JWT subject doesn't match the session's `workerId`. The worker polls it to apply per-session conversational toggles (currently `sendReadReceipts`) at the Baileys layer.

Response `200`:

```json
{ "sendReadReceipts": true, "syncFullHistory": false }
```

Don't write integration code against this endpoint. Flip the toggle through `PATCH /api/admin/sessions/:id` and let the worker pick it up on its next refresh.

## Scheduled Sends

Pass `sendAt` (ISO 8601 UTC) on `POST /v1/messages` to park a message for later dispatch. The response carries `status: 'scheduled'` instead of `'queued'`, with the same `messageId`.

Constraints:

- `sendAt` MUST be at least **30 seconds** in the future. Anything earlier (including the past) returns `422 SEND_AT_PAST`.
- `sendAt` MUST be at most **30 days** in the future. Beyond that horizon also returns `422 SEND_AT_PAST`.
- Always send UTC. Local-time offsets work as long as the parsed instant satisfies the bounds, but UTC is the canonical form and avoids DST surprises.

Dispatch is driven by a per-minute cron sweep on the gateway. A scheduled message is picked up at the first cron tick after its `sendAt`, then handed to the worker like any other send. Expect up to ~60 s of additional latency between `sendAt` and the WhatsApp send. Validation that runs at send time (opt-out check, scope check, worker availability) runs again at dispatch time, not at scheduling time, a recipient who opts out between scheduling and dispatch will see the message fail with `OPTED_OUT`.

Poll `GET /v1/messages/:messageId` to observe the transition: `scheduled` → `queued` → `sent` → `delivered`. The `statusHistory` array records each step with timestamps. Webhooks fire on the same lifecycle.

There is currently no API to cancel a scheduled message. If you need that capability, raise it with the gateway admin.

## Opt-out Registry

Each session keeps a per-session blocklist of E.164 numbers. The gateway consults it at send time:

- `POST /v1/messages` with a `to` on the registry returns `422 OPTED_OUT`. The check runs after `INVALID_PHONE` normalisation, so the registry stores normalised E.164 only.
- `replyTo` does not waive the check. If a recipient has opted out, we do not message them, period.
- For scheduled sends, the registry is checked at dispatch time, not at scheduling time. A recipient who opts out between `POST` and `sendAt` will see the message fail with `OPTED_OUT`.

Numbers join the registry in two ways:

1. **Inbound STOP keyword: two-step handshake.** A lone keyword does NOT opt the sender out immediately. When the worker receives an inbound text message whose normalised, upper-cased body matches one of the session's `optOutKeywords` (default `["STOP"]`, case-insensitive), the gateway opens a 30-minute confirmation window (`OPTOUT_CONFIRM_TTL_SECONDS`) and replies asking the sender to repeat the keyword. Only a second matching keyword within that window commits the opt-out; the first message writes no registry entry and fires no webhook. Both messages are genuine inbound from the sender's own WhatsApp number, so the handshake cannot be forged. On commit, a `contact.opted_out` webhook fires with `source: 'keyword'`.
2. **Admin action.** A request to `POST /api/admin/sessions/:id/optouts`. Fires a `contact.opted_out` webhook with `source: 'admin'`.

### Admin: Opt-outs

#### `GET /api/admin/sessions/:id/optouts`, list

Response `200`:

```json
{
  "optOuts": [
    {
      "phone": "+447700900123",
      "createdAt": "2026-04-28T12:34:56.000Z",
      "source": "keyword",
      "keyword": "STOP"
    }
  ]
}
```

#### `POST /api/admin/sessions/:id/optouts`, add

Request body: `{ "phone": "+447700900123" }`. Idempotent: adding an already-listed number is a no-op. Response `201` `{ "phone": "+447700900123", "source": "admin" }` either way.

Fires `contact.opted_out` with `source: 'admin'`.

#### `DELETE /api/admin/sessions/:id/optouts/:phone`, remove

Path positional `phone` is the URL-encoded E.164 string. Removes the entry; subsequent sends to that recipient are allowed again. Response `204`.

Use this for genuine re-opt-in (the user explicitly asks to be re-enabled). Do not bulk-remove keyword-driven opt-outs without a documented compliance reason.

### `optOutKeywords` session config

The set of inbound keywords that auto-opt-out is configurable per session through `PATCH /api/admin/sessions/:id`, nested under `conversation`:

```json
{ "conversation": { "optOutKeywords": ["STOP", "UNSUBSCRIBE", "ARRÊT"] } }
```

Up to 10 keywords, each trimmed to 1–32 characters. Matching is case-insensitive against the trimmed inbound text, and is still subject to the two-step confirmation handshake described above. The keyword is stored on the resulting opt-out entry as `keyword`. Setting an empty array reverts to the default `["STOP"]`; there is no way to disable keyword-driven opt-outs entirely, so the registry must be managed by hand for numbers that don't send the default keyword.

### `contact.opted_out` webhook

Fires when a number is added to the registry. Subscribe by including `contact.opted_out` in the webhook route's `events` list.

```json
{
  "type": "contact.opted_out",
  "at": "2026-04-28T12:34:56.000Z",
  "eventId": "11111111-2222-3333-4444-555555555555",
  "sessionId": "session-a",
  "phone": "+447700900123",
  "source": "keyword",
  "keyword": "STOP"
}
```

`source` is `'keyword'` (inbound STOP-style match, after the two-step confirmation) or `'admin'` (admin add). `keyword` is set only when `source === 'keyword'`. Re-opt-in via the DELETE route does **not** fire a webhook; there is intentionally no `contact.opted_in` event yet.

## Webhooks

The gateway delivers events asynchronously to consumer URLs registered on a webhook route. Delivery is signed, retried, and idempotent.

### Headers

| Header              | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| `X-HMD-Signature`   | `t=<unix-seconds>,v1=<hex-sha256>`                                                   |
| `X-HMD-Event`       | event type (e.g. `message.delivered`)                                                |
| `X-HMD-Delivery-Id` | UUID v4, unique per delivery attempt; same value across retries of the same delivery |
| `Content-Type`      | `application/json`                                                                   |
| `User-Agent`        | `hmd-wa-gateway-webhook/1`                                                           |

### Signing scheme

`v1 = HMAC-SHA256(secret, "<t>.<rawBody>")`, hex-encoded. `rawBody` is the exact request bytes, receivers must verify against the unmodified payload, not against re-stringified JSON. Frameworks that auto-parse JSON must expose the raw body (Express: `express.raw({ type: 'application/json' })`; Next.js App Router: `await req.text()` before any parsing).

Verification steps:

1. Parse `t` and `v1` from `X-HMD-Signature`.
2. Reject if `Math.abs(now - t) > 300` (the `WEBHOOK_TOLERANCE_SECONDS` constant).
3. Recompute the HMAC over `<t>.<rawBody>` and compare in constant time.

Use [`@hmddevs/wa-sdk`'s `verifyWebhook`](./SDK.md#webhook-verification) to do this in one call.

### Retry schedule

Delivery is fired by a per-minute cron sweep. Each attempt has a 5-second hard timeout. Non-2xx responses, timeouts, and transport errors are failures.

Backoff (seconds after the previous attempt): `30, 120, 600, 3600, 21600, 86400`. After the seventh failure (initial + 6 retries), the delivery is marked `abandoned` and is not retried again.

Deliveries expire from MongoDB after 14 days regardless of status.

### Replay-safe consumers

Each event carries a stable `eventId` (UUID v4) which is preserved across retries of the same delivery. Use it as the dedupe key on your side. The gateway's contract is at-least-once.

### Event payload schemas

All events share:

```ts
{
  type: WebhookEventType,
  at: string,         // ISO 8601 UTC
  eventId: string,    // UUID v4, dedupe key
  sessionId: string,  // session that produced the event
  // …event-specific fields
}
```

Event types and their additional fields:

| `type`              | Additional fields                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message.queued`    | `messageId`, `to` (E.164), `category` (`'notification' \| 'transactional' \| 'internal'`)                                                                                                        |
| `message.sent`      | `messageId`, `waMessageId`                                                                                                                                                                       |
| `message.delivered` | `messageId`, `waMessageId`                                                                                                                                                                       |
| `message.read`      | `messageId`, `waMessageId`                                                                                                                                                                       |
| `message.failed`    | `messageId`, `status` (terminal `MessageStatus`), `error: { code, message, retryable }`                                                                                                          |
| `inbound.received`  | `waMessageId`, `from` (E.164), `content` (discriminated on `type`: `text`, `image`, `document`)                                                                                                  |
| `inbound.reaction`  | `waMessageId`, `from` (E.164), `targetFromMe` (boolean), `emoji` (string, empty when reaction was cleared), `messageId?` (gateway UUID, set only when the reacted-to message was authored by us) |
| `contact.opted_out` | `phone` (E.164), `source` (`'keyword' \| 'admin'`), `keyword?` (the matched STOP keyword when `source === 'keyword'`); fires when a number is added to the opt-out registry                      |
| `webhook.test`      | `message: 'This is a test webhook from HMD WA Gateway.'`, emitted by the admin "test" endpoint; treat as a no-op heartbeat                                                                       |

Inbound `content` shapes:

```ts
{ type: 'text', text: string }
{ type: 'image', mediaUrl: string, mediaMimeType?: string, caption?: string }
{ type: 'document', mediaUrl: string, mediaFileName: string, mediaMimeType?: string, caption?: string }
```

The full Zod definitions live in [`packages/protocol/src/webhook.ts`](../packages/protocol/src/webhook.ts).

## Versioning

- The `/v1` prefix is stable. New optional fields may be added; existing fields will not be removed or repurposed.
- Error codes will not be repurposed. New codes may be added.
- Webhook event types may be added. Consumers should ignore types they do not recognise rather than rejecting the request.
- Breaking changes will arrive under a new prefix (`/v2`) with overlap.
