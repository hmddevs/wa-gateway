# Architecture

> Companion to the build specification. Read the spec first.

## System overview

```
┌────────────────────┐   HTTPS   ┌──────────────────────────┐
│ HMD services       │──────────▶│ wa.example.com (gateway)     │
│ (Acme, Session A)│           │ Next.js 15 (Docker/Vercel)│
└────────────────────┘           └───────────┬──────────────┘
                                             │ Upstash Redis (rediss://)
                                             │ Pub/Sub + Lists + Streams
                                             ▼
                                    ┌────────────────────┐
                                    │ Mac M1 worker      │
                                    │ Baileys + launchd  │
                                    │ 127.0.0.1:7823 UI  │
                                    └────────────────────┘
                                             │
                                             ▼
                                    WhatsApp personal number
```

## Organization routing

An API key binds to an organization, not a WhatsApp number. The send route asks
`lib/org-router.ts` which member number should carry each message, filtering on
liveness, per-number send budget and an observed health score, then reserving
budget before publishing. Numbers can be attached or detached from an
organization live, with no key change and no deploy.

This supersedes session pools, whose failover only triggered on disconnect and
so missed the case that actually happens, WhatsApp throttling a number whose
socket stays open. Full design, defaults and migration: `docs/ORGANIZATIONS.md`.

## Trust boundaries

| Edge                              | Direction | Authenticity                                                |
| --------------------------------- | --------- | ----------------------------------------------------------- |
| HMD service → gateway             | inbound   | Bearer API key (argon2id + HMAC lookup hash)                |
| Admin → gateway                   | inbound   | Google OAuth + WebAuthn + IP-pinned cookie                  |
| Client → gateway (`/pair/:token`) | inbound   | Bearer token in URL (argon2id + HMAC lookup hash), no login |
| Gateway → worker                  | via Redis | HMAC-signed envelopes + nonce dedup                         |
| Worker → gateway                  | via Redis | Same as above                                               |
| Worker → WhatsApp                 | outbound  | Baileys device-link (personal number)                       |

The Mac exposes **zero** inbound network listeners. Upstash Redis is the single
ingress from it; the control UI is loopback-only.

## Client pairing links

Admins mint a shareable `/pair/:token` link so a client connects their own
WhatsApp numbers without any admin access. The link is scoped to an
ORGANIZATION and reusable up to `maxSessions` (default 5, default TTL 7 days):
one link, sent once, lets the client add several numbers over its lifetime.
Full flow and rationale in `docs/ORGANIZATIONS.md`.

The token follows the same two-hash pattern as API keys (`lib/pairing-invite.ts`,
`argon2id` verify + HMAC-SHA256 lookup, distinct `hmd_pi_` prefix) and is IP
rate-limited. `X-Robots-Tag: noindex` is applied globally by the middleware, so
pairing links are never indexed.

**The unauthenticated surface now creates sessions.** This is a deliberate
change from the previous design, where the link was read-only and the session
was provisioned up front by the WebAuthn-gated admin call. Holding a valid
link now lets its bearer call `POST /api/pair/:token/sessions`, which
provisions a session and attaches it to the organization. The exposure is
bounded by three things, all enforced server-side: the `maxSessions` cap
(claimed inside one atomic update, and the provisioning is rolled back if the
claim loses its race), the link's expiry, and revocation. A bearer can
therefore add numbers to one organization until the link fills, expires, or is
revoked, and nothing else. They cannot read messages, mint keys, or reach any
other organization.

What the public page discloses is limited to what the link's holder already
owns: the organization's label, and per number its id, state and last four
digits. Never the full phone number, the worker id, `createdBy`, or numbers
attached by any other route.

Known residual risk (accepted, tracked in `docs/SECURITY.md`): the token lives
in the URL path, so infra/CDN access logs capture it for the link's lifetime,
and a forwarded link is indistinguishable from the intended recipient.
Revoking stops the link serving QRs and adding numbers, but does not stop
sessions it already created, detach or pause those from the admin
Organizations panel. The 2026-07-13 security review covers the pre-existing
URL-token reasoning; the session-creation surface above supersedes its
"read-only" finding.

## Milestones

See `README.md` for the full list. M1 in this repo delivers:

- Monorepo skeleton (pnpm workspaces)
- Gateway: Next.js 15 App Router, security headers, `/api/health`, boot-time
  Zod env validation
- Shared `@hmddevs/protocol`, Zod schemas for DB, wire protocol, and HTTP API
- CI: lint, typecheck, gitleaks, Dependabot
- Public `SECURITY.md` and docs skeleton

## Why Next.js 15 for the gateway?

- App Router Server Actions give us CSRF-safe admin mutations without a
  bespoke endpoint per form.
- Edge middleware applies security headers uniformly.
- Co-located public API and admin UI keeps the trust boundary small.

## Why Baileys?

- Personal-number flexibility: no Meta Business verification.
- MIT-licensed and community-maintained.
- Baileys ships only a WA client; the surrounding queue, audit, and admin
  concerns are ours.

## Conversation threading (admin)

The admin Conversations tab keys threads by `(sessionId, counterparty E.164)`
and unifies three collections at read time:

- Outbound `messages` (counterparty = `to`, ts = `createdAt`), messages we
  sent through the gateway HTTP API.
- Inbound `inbound_messages` (counterparty = `from`, ts = `receivedAt`), peer-to-us DM messages received live by the worker.
- `chat_events` (counterparty = `counterpartyE164`, ts = `ts`, filtered to
  `counterpartyE164 != null`), every Baileys-observed message the legacy
  paths don't cover. Today that's outbound from the paired phone or another
  linked device (`direction: 'out_device'`) and live group inbound (kept in
  storage but excluded from the DM viewer by the `counterpartyE164 != null`
  filter). Pre-pair history sync (`direction: 'in_history' | 'out_history'`)
  will land here in a follow-up PR.

The list view runs a Mongo `$unionWith` aggregation projecting all three into
a common shape, then `$group`s by counterparty for the list and streams raw
newest-first for the per-thread view. Cursor pagination uses `(ts, id)`.
Indexes in `apps/gateway/src/lib/mongo.ts`:
`messages.{sessionId, to, createdAt: -1}`,
`inbound_messages.{sessionId, from, receivedAt: -1}`,
`inbound_messages.{sessionId, receivedAt: -1}`,
`chat_events.{sessionId, waMessageId}` (unique, dedup),
`chat_events.{sessionId, counterpartyE164, ts: -1}`,
`chat_events.{sessionId, ts: -1}`.

Webhook safety invariant: `chat_event` callbacks never trigger webhook
fan-out, opt-out keyword detection, auto-reads, or admin notifications.
`out_device` events are our own outbound (no point webhooking ourselves);
`history_sync` events would replay ancient messages as fresh notifications.
The gateway callback branch at `apps/gateway/src/app/v1/worker/callback/route.ts`
documents this rule inline.

## Full chat backup, immutable history, contact book

The admin Conversations panel acts as a WhatsApp Web alias: every message
on every paired number is persisted indefinitely, edits and deletes never
mutate originals, and the contact book is rebuilt on first pair so a
revoke-and-re-pair restores the full thread list.

Retention is **infinite** for `chat_events`, `messages`, and
`inbound_messages`, the previous TTL was dropped on 2026-05-10 (see
`scripts/drop-message-ttl.ts` for the migration on existing clusters).
Encryption at rest is Atlas storage-level AES-256; there is no app-layer
envelope encryption.

On first pair, the worker drains Baileys' `messaging-history.set` events
into batched `chat_event_batch` POSTs (size 500, with the
`HistorySyncBatchHeader` envelope marker, `historySync: true,
sessionId, batchIndex`). The gateway recognises the marker and applies
a relaxed per-session rate-limit (5,000 events/min) for history-mode
batches. The unique `(sessionId, waMessageId)` index dedupes against
re-runs, so revoke + re-pair is safe.

Edit and delete history live in `message_revisions`, append-only,
keyed by `(sessionId, messageId, revisionSeq)` unique with a
`(sessionId, waMessageId, revisionSeq)` lookup-only index for race
resolution. When a revision arrives before the original message it
references (rare, but possible during history sync), the row is
inserted with `messageId: null` and the read-side `$lookup` reconciles
via the `$or` join on `waMessageId`.

The viewer aggregation in `apps/gateway/src/lib/repositories/messages.ts`
joins `message_revisions` after `$limit` so per-page work stays
predictable, and projects derived `latestBody`, `editedAt`, `deletedAt`
fields onto each `AdminThreadMessage`. The admin UI's bubble component
expands the prior content on click, that is the entire point of the
slice; the original body of an edited or deleted message is recoverable
from the admin view.

`contacts` is per-session, replace-on-conflict on `(sessionId, e164)`,
populated from Baileys' `contacts.upsert`/`contacts.update` events. The
admin endpoint `GET /api/admin/sessions/:id/contacts` powers the
WhatsApp Web left-rail avatars and display names.

`message_reactions` is per-session, replace-on-conflict on
`(sessionId, waMessageId, fromJid)`, distinct semantic from
`message_revisions` because WhatsApp itself surfaces only the latest
emoji per peer; cleared rows are kept (with `emoji: ''`) for audit but
the read projection filters them out so empty pills never render.

The conversation viewer is rebuilt as a 3-pane WhatsApp Web visual
clone under `apps/gateway/src/app/admin/_components/ww/`:
`ConversationsLayout` orchestrates, `ThreadRail` is the left list,
`ConversationPane` is the bubble area, `Composer` is the send bar,
`InfoPane` is a slide-in third column on desktop (Dialog on mobile),
`MessageBubble` carries the revisions accordion. WW colour tokens are
in `theme.css`; light/dark follows `prefers-color-scheme`.

## What is NOT in this repo

See §16 of the build spec. In particular: no Meta Cloud API, no HA, no
templates, no multi-tenant, no marketing broadcast.
