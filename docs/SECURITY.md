# Security model (public threat model)

> Private disclosures go to **security@hmddevs.org**. See `/SECURITY.md`.

## Principles

1. **Security first, helpfulness second, speed third.** No shortcut is worth
   a compromise.
2. **Defence in depth.** Single controls fail; layered ones degrade.
3. **Least privilege, always.** Every credential is scoped by division,
   environment, IP, and time where possible.
4. **Every failure mode has a visible surface in the admin panel.**

## Threat model

| Threat                               | Mitigation                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen API key                       | Argon2id + HMAC lookup hash, IP allowlist, scopes, anomaly detection, instant revoke, one-time display                                                                                                                                                                                                                                       |
| Stolen admin cookie                  | IP pinning, 8h expiry, WebAuthn step-up on sensitive actions                                                                                                                                                                                                                                                                                 |
| Compromised Mac                      | AES-GCM-wrapped session store with Keychain-held key                                                                                                                                                                                                                                                                                         |
| Compromised Upstash creds            | ACL-scoped to channels/lists, rotatable in minutes                                                                                                                                                                                                                                                                                           |
| Compromised MongoDB                  | PII hashed in analytics, content non-indexed, argon2id key hashes, hash-chained audit                                                                                                                                                                                                                                                        |
| Rogue admin                          | Hash-chained audit; every sensitive action records actor/IP/UA                                                                                                                                                                                                                                                                               |
| Supply chain                         | Dependabot, `--frozen-lockfile`, `.npmrc ignore-scripts=true`                                                                                                                                                                                                                                                                                |
| SSRF (webhookUrl / mediaUrl)         | HTTPS required, DNS → public IP only, 10s timeout, 5 MB cap, redirects disabled                                                                                                                                                                                                                                                              |
| DDoS / credential stuffing           | Edge/reverse-proxy firewall (self-hoster's choice), global + per-key + per-IP rate limits                                                                                                                                                                                                                                                    |
| Information disclosure in errors     | Coded errors only; no DB content, keys, or paths                                                                                                                                                                                                                                                                                             |
| Replay of worker messages            | HMAC + nonce dedup + ±60s timestamp window                                                                                                                                                                                                                                                                                                   |
| Leaked pairing link (`/pair/:token`) | Argon2id + HMAC lookup hash, default 7d TTL, IP rate limit, `noindex`, revocable. NOT read-only: a bearer can add numbers to the link's organization, capped by `maxSessions` (claimed atomically, provisioning rolled back on a lost race) and bounded by expiry/revocation. Discloses only org label + per-number state and last 4 digits. |
| Secret commit                        | `gitleaks` in CI, `.env*` gitignored                                                                                                                                                                                                                                                                                                         |
| Baileys CVE                          | Pinned, Dependabot dependency PRs                                                                                                                                                                                                                                                                                                            |

The IP allowlist and per-IP rate limit rows above both derive the client IP
from the header named by `TRUSTED_CLIENT_IP_HEADER`, which has no default:
unset, every request shares a single `0.0.0.0` identity, so the allowlist
rejects everything and the rate limit shares one bucket. That mitigation
only holds once `TRUSTED_CLIENT_IP_HEADER` names a header that a trusted
reverse proxy, not the client, sets on every request; see
`docs/SELF_HOSTING.md` before deploying.

## Secret management

Secrets are supplied by the self-hoster via environment variables (or their
own secret manager, injected as env vars at deploy time). Never committed,
never logged, never echoed. See `.env.example` for the authoritative list.

### Rotation runbook

**Worker RS256 signing key** (`WORKER_JWT_SIGNING_KEY`):

1. Generate a new keypair (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`).
2. Deploy gateway with BOTH public keys set in `WORKER_JWT_PUBLIC_KEY`
   (comma-separated during rotation). Either validates.
3. Workers refresh via `/v1/worker/bootstrap` on next poll.
4. After 7 days of no legacy traffic, remove the old public key.

**API keys:** admin issues new, grace period, revokes old. Never reused.

**Database / Redis credentials:** Atlas + Upstash UIs; update the deployment's
env vars and redeploy within the same maintenance window.

**`WEBHOOK_DELIVERY_KEY`** (master AES key for per-route signing-secret
storage): plan a window. There is no graceful re-encrypt, see "Webhook
signing" below for the full procedure. Briefly: provision new key, for each
active route create a replacement route on the new key and switch the
consumer, delete the old route, remove the old key value.

**`CRON_SECRET`:** rotate by setting a new value in the deployment's env vars
and redeploying so all running cron jobs read the new secret. Old in-flight
invocations finish under the old secret, one missed tick at most.

## Data handling

- **Phone numbers** (`to`) are hashed (`SHA-256`) for analytics; the full
  value is stored on the message doc only, never logged.
- **Message body** is not indexed in Mongo. Inbound content is encrypted at
  rest with `INBOUND_ENCRYPTION_KEY` (AES-256-GCM).
- **Retention:** 90 days default (TTL index on `messages.createdAt`).
- **Audit log:** indefinite retention, hash-chained, verified nightly by the
  `audit:verify` cron.

## Read receipts and presence

Both signals leak peer-observable activity. Document the trade-off; pick the
posture that fits the product.

- **Read receipts.** By default the worker calls `sock.readMessages([key])` on
  every inbound message, so the peer sees double blue ticks. The peer can
  infer that someone behind the HMD number opened their message, and roughly
  when. For support inboxes, automated triage queues, or any channel where
  "read at 03:14" would be embarrassing or misleading, turn the toggle off.
- **Toggle location.** Per-session, `conversation.sendReadReceipts` boolean.
  Surfaced in the admin panel under Sessions → "Send read receipts". Mutated
  via `PATCH /api/admin/sessions/:id` with `{ conversation: { sendReadReceipts: false } }`.
  Audited as `session.conversation.update`. Worker re-fetches the config every
  30 s via `GET /v1/worker/sessions/:id/config`, so changes apply within the
  refresh window without a session restart.
- **When off, the worker never marks reads.** Inbound messages still flow
  into MongoDB and into `inbound.received` webhooks; the peer just sees a
  single grey tick (delivered) instead of double blue (read).
- **Presence.** `setPresence` and `setTyping` (SDK) push `available`,
  `unavailable`, `composing`, `recording`, `paused` to WhatsApp. The peer
  observes these in real time. Presence is not gated by the read-receipt
  toggle, operators that want full radio silence should not call the
  presence API at all. Document the choice in your service's runbook so a
  later "let's add a typing indicator" change isn't slipped in without
  privacy review.
- **Audit.** `session.presence` and `message.react` / `message.unreact` log
  the actor (API key id) and the action; reading the audit chain reveals
  exactly which keys exposed presence/reactions on which messages.
- **Reactions.** Outbound reactions are visible to the peer. Inbound
  reactions are surfaced via the `inbound.reaction` webhook and behave like
  inbound content for retention purposes.

## Admin send, step-up gate

The admin dashboard can send messages directly via `POST /api/admin/sessions/:id/send`. This action is gated behind a WebAuthn step-up in addition to the standard admin session cookie:

- The step-up must have been completed within the last 5 minutes (`STEP_UP_MAX_AGE_MS = 300_000`). Older step-ups are rejected at the route level; the UI prompts the admin to re-authenticate.
- Admin-originated messages are persisted with `origin: 'admin'` and `apiKeyId: '__admin__'`. This ensures they are distinguishable from SDK/API sends in the audit log, in MongoDB queries, and in any future reporting surface.
- Every admin send appends an `message.send.admin` audit entry (hash-chained, tamper-evident) recording `{ sessionId, to, kind }`. The `to` field is normalised E.164 before storage, never the raw input.
- Opt-out enforcement applies. An admin cannot send to a number that has opted out from the session's opt-out registry.
- The channel is set to `'internal'`; scheduled sends and template bodies are not available on this endpoint.

## Compliance

- **UK GDPR + Turkish KVKK.** Lawful basis: legitimate interest for
  transactional notifications. Consent is required for marketing, not in v1.
- **Data subject rights.** Admin UI supports delete-all and export-all by
  phone hash.
- **Residency.** Atlas region is configurable; EU (Frankfurt or Ireland)
  recommended.

## Webhook signing

Outbound webhooks are signed and timestamped so consumers can prove origin and
reject replays.

- **Scheme.** `HMAC-SHA256` over the literal string `<t>.<rawBody>`, hex
  encoded. The signature header is
  `X-HMD-Signature: t=<unix-seconds>,v1=<hex>`. The event type and a stable
  delivery id ride alongside in `X-HMD-Event` and `X-HMD-Delivery-Id`.
- **Replay window.** ±300 seconds (`WEBHOOK_TOLERANCE_SECONDS`). Receivers
  reject anything outside it, even with a valid HMAC.
- **Raw body.** The HMAC covers the exact bytes the gateway POSTed. Receivers
  must verify before any JSON parser touches the body. Frameworks that auto-parse
  must expose the raw payload (Express `express.raw`, Next.js
  `await req.text()`).
- **Secret storage.** Per-route, AES-256-GCM at rest using the gateway-side
  `WEBHOOK_DELIVERY_KEY` (32 bytes, base64). The cron-driven delivery worker
  decrypts only inside the request lifecycle. Admins see the raw secret
  **once** at route creation; it is never returned again, never logged,
  and not exposed to admin UIs.
- **No in-place rotation.** Secret rotation is replaced by route lifecycle:
  create a new route, switch the consumer, delete the old route. This keeps
  the invariant simple, one secret per route, immutable for life of the
  route. The operational cost of a swap procedure is the price.
- **Master-key rotation.** Rotating `WEBHOOK_DELIVERY_KEY` makes every
  existing route's encrypted secret unrecoverable (decrypt fails, cron logs
  `secret decrypt failed`, deliveries quietly stop). The procedure is
  exactly the per-route swap, applied to every route in one window:
  (1) provision the new key in the deployment's env vars, (2) for each active route, create a
  replacement route on the new key and switch consumers, (3) delete the old
  routes, (4) remove the old `WEBHOOK_DELIVERY_KEY` value. Plan a window, there is no graceful re-encrypt today.
- **SSRF guard.** Webhook destination URLs are DNS-resolved at admin
  write time and again at delivery time; any URL that resolves to an
  RFC1918, loopback, link-local, CGNAT, or IPv4-mapped-IPv6 address is
  rejected. The connection is pinned to the resolved IP to prevent DNS
  rebinding between resolution and connect. The synthetic
  `webhook.test` endpoint surfaces only short error codes
  (`destination_private_ip_blocked`, `transport_timeout`, etc.) so it
  cannot be used as a status-or-timing oracle against internal infra; full
  upstream errors land in the audit log.
- **Replay-safe consumers.** Each event carries a stable `eventId` that is
  preserved across retries. Consumers dedupe on it. The gateway's contract is
  at-least-once with a backoff schedule of `30 s, 2 min, 10 min, 1 h, 6 h, 24 h`,
  abandoned thereafter.
- **Defence in depth.** The decrypt key alone is sufficient to forge
  signatures, so we do not stack argon2 on top, it would buy nothing here.
  Defence comes from key custody (env vars, scoped per environment) and the
  audit log (every secret-touching admin action records actor, IP, UA).

Receivers should use `verifyWebhook` from `@hmddevs/wa-sdk`, which performs
header parsing, replay-window enforcement, constant-time HMAC compare, and
`WebhookEventSchema` validation in one call. See `docs/SDK.md` and
`docs/INTEGRATION.md`.

## Reporting

Vulnerability disclosure process, SLAs, and safe-harbour terms are in
`/SECURITY.md`.
