# Organization routing

> How an outbound send picks a WhatsApp number. Supersedes session pools.

## The problem this solves

An API key used to bind to one `sessionId`, i.e. one WhatsApp number. When
WhatsApp rate-limited that number, outbound stopped for that customer. The fix
was to provision a new session, mint a new key, and redeploy the caller, minutes to hours of downtime for a problem that lasts as long as it takes to
attach a second number.

Session pools were the first attempt. They gave an API key a `poolId` and
failed over to the next member when the primary went `offline`. That solved
_worker died_ but not _number got throttled_: WhatsApp restricts a number long
before the socket drops, so the pool's `status === 'connected'` check kept
routing sends to a number that was no longer delivering.

Organizations replace pools with a router that models the thing that actually
runs out: **per-number send capacity over time**.

## Model

```
API key ──▶ organization ──▶ router ──▶ session ──▶ WhatsApp number
                                │
                                └─ budget · health · affinity
```

The consumer names neither a session nor a number. It holds one API key bound
to one `orgId`, forever. Attaching or detaching a number is an admin operation
against the organization; no key changes, no deploy, and it takes effect on the
next send.

### Organization

One doc per organization in `organizations`. Replaces `session_pools`.

| Field      | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| `orgId`    | Slug, e.g. `org-a`. Unique.                                   |
| `label`    | Human name.                                                   |
| `sessions` | Member session ids. Order is priority order under `priority`. |
| `strategy` | `weighted` (default), `priority`, or `round-robin`.           |

`strategy` is now read by the router. Under pools it was stored and ignored,
which is why one number took all the traffic and hit its limit first.

### Session

Sessions gain four routing fields (all optional; absent means "use the
defaults", so existing session docs keep working):

| Field             | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| `orgId`           | The organization this number belongs to.                    |
| `budget`          | `{ perMinute, perHour, perDay }` send caps for this number. |
| `warmupStartedAt` | When the number was first paired, for the ramp.             |
| `paused`          | Admin kill-switch; the router skips a paused session.       |

Budget defaults live in `session-state.ts` and are deliberately conservative.
They are a guess at WhatsApp's unpublished limits, not a measurement, tune per
number from real delivery data.

## The router

`lib/org-router.ts`. One entry point:

```ts
routeSend(orgId, recipientE164) → { session } | { reason: 'no_sessions' | 'all_exhausted' | ... }
```

Four steps, in order.

### 1. Eligibility

A session may take a send only if **all** of these hold:

- `status === 'connected'`
- `lastHeartbeatAt` is within 35s (a hard-crashed worker leaves `status` stuck
  at `connected`; only the heartbeat catches that)
- not `paused`
- health score ≥ `HEALTH_MIN`
- budget remaining in all three windows

The last two are the new ones, and the reason the router survives a throttle
that the pool picker did not.

### 2. Affinity

If this recipient has been messaged before within the affinity TTL, prefer the
number that messaged them. Stored in Redis at
`wa:affinity:<orgId>:<e164>`, 24h TTL, refreshed on each send.

This is not an optimisation, it is a correctness requirement. A customer who
receives five messages from five different numbers reads as spam to the
recipient and to WhatsApp, and their replies fragment across sessions so
threading breaks. Affinity is skipped only when the pinned number is no longer
eligible, and the new choice re-pins.

### 3. Selection

- **`weighted`** (default), pick proportionally to _remaining hourly budget_.
  A number at 50/500 is nine times likelier than one at 450/500. This spreads
  load smoothly and self-corrects: as one number fills, it naturally sheds
  traffic to the others.
- **`priority`**, first eligible in list order. The old pool behaviour, kept
  for the case where one number is genuinely preferred (a verified business
  number, say) and the others are overflow.
- **`round-robin`**, even rotation via a Redis counter. Cheapest to reason
  about when all numbers are equivalent.

### 4. Reservation

The chosen session's budget is decremented **before** the message is published,
in one Redis `MULTI` across the three windows. If the reservation loses a race
it is refunded and the router retries with the next candidate.

Reserve-then-send, rather than send-then-count, is what makes the cap hold
under concurrency. The cost is that a send which later fails has consumed
budget it did not use, deliberate, because WhatsApp counts attempts, not
successes.

## Health scoring

A single integer per session in Redis (`wa:health:<sessionId>`), 0–100,
defaulting to 100.

- A failed `send_ack` subtracts `HEALTH_PENALTY` (20). Four consecutive
  failures take a number below the eligibility floor.
- A successful `send_ack` adds `HEALTH_REWARD` (5), capped at 100.
- The key has a 6h TTL, so a number that stops being used recovers to full
  health rather than staying condemned forever.

Health is deliberately cheap and approximate. It is a circuit breaker, not a
metric, its only job is to take a misbehaving number out of rotation fast and
let it back in gradually.

## Warm-up ramp

A newly paired number that immediately sends at full volume is the fastest way
to get it restricted. `effectiveBudget()` scales the configured budget by the
number's age, measured from the first time it completed pairing (stamped by the
worker callback, and never restarted by a re-pair):

| Age     | Share of configured budget |
| ------- | -------------------------- |
| day 1   | 10%                        |
| day 7   | ~50%                       |
| day 14+ | 100%                       |

Linear between those points. A session with no `warmupStartedAt` (every
existing session) is treated as fully warmed, the ramp applies to numbers
attached from here on, not retroactively to numbers already in production.

## What the consumer sees

Nothing changed in the request. The response and webhook payloads no longer
carry a meaningful session identity: `sessionId` on a webhook is normalised to
the organization's canonical head session so a failover does not leak a
different number's id to the caller.

When every number in an organization is exhausted, the send returns
`429 RATE_LIMITED` with `Retry-After` set from the soonest budget window to
reopen. That is the honest answer, the organization is genuinely over its
capacity, and a queue would only defer the same truth while removing the
caller's ability to react.

## Opt-outs

Opt-out is enforced **organization-wide**. A recipient who sent STOP to any
number in the organization is suppressed for all of them. Without this, a
failover to a second number silently resurrects a contact who opted out, a
compliance failure, not a routing inconvenience.

## Pairing links

An organization pairs its own numbers through a shareable link. One link,
handed to the client once, lets them add several numbers themselves, no admin
access, nothing to install, and no operator in the loop at the moment a number
actually needs replacing.

`POST /api/admin/pairing-invites` with `{ orgId, maxSessions?, ttlHours? }`
mints one and returns the URL **once**. Defaults: 5 numbers, 7 days. The raw
token is never stored, only an HMAC lookup hash and an argon2id verify hash,
the same two-hash pattern as API keys.

What the client sees at `/pair/<token>`: the organization's name, the numbers
already added through the link, and an "Add a number" button. Each press
provisions the next session (`org-a-01`, `org-a-02`, …), attaches it to the
organization, and shows its QR. Nothing is provisioned when the link is
minted, so an unused link leaves no half-built sessions behind.

The `maxSessions` cap is enforced inside a single atomic update, so two people
opening the same link cannot both take the last slot. The session is
provisioned before the slot is claimed and rolled back if the claim loses that
race, an over-cap number would silently widen who can send as the
organization.

The page discloses only what its holder already owns: the organization label,
and per number its id, state and last four digits. Not the full phone number,
not the worker id, not numbers added by any other means. The token travels in
a URL and may be forwarded, so the blast radius of a leaked link is bounded at
"can add numbers to this organization until it expires or is revoked", revoke with `POST /api/admin/pairing-invites/<inviteId>/revoke`.

## Operating it

Attach a number mid-incident, without an operator:

1. Send the organization its pairing link (or reuse one already issued).
2. They open it and press "Add a number", then scan.
3. Nothing else. The next send can pick it.

Attaching a number that is already paired: `PATCH
/api/admin/organizations/<orgId>` with
`{ "op": "add", "sessionId": "org-a-04" }`.

Take a number out of rotation without deleting or disconnecting it:
`PATCH /api/admin/sessions/<sessionId>` with `{ "paused": true }`. The router
skips it; inbound keeps working. The same endpoint sets a per-number `budget`.

Migrating existing pools: `pnpm tsx scripts/migrate-pools-to-orgs.ts`. It
copies `session_pools` → `organizations`, rewrites `api_keys.poolId` → `orgId`,
and back-fills `sessions.orgId`. Idempotent; safe to re-run.

## Deliberately not built

**Inter-message pacing.** The per-minute budget caps throughput but does not
spread it: a number may still burst its whole minute's allowance at once.
Smoothing that needs a delay on the wire and a worker-side wait, and the claim
that WhatsApp punishes bursts specifically, as opposed to volume, is one I
have not measured. Cap first, measure, then pace if the data says so.

**A per-organization queue.** Deferring an over-capacity send changes the
delivery contract from "sent or told why" to "accepted, ask later", and needs a
drain process with its own failure modes. `429 + Retry-After` gives the caller
the same information and leaves the decision with them. Revisit when a customer
asks for fire-and-forget bulk, and make it opt-in per key.

**Baileys v8.** The worker is on `7.0.0-rc13`. v8 is a breaking upgrade that
needs verification against a live WhatsApp connection, a pairing regression
would be discovered in production, on a client's number. It belongs in its own
change, with a spare number to test against.

**Moving auth state to Mongo.** Sessions are still file-backed on a worker
volume, which pins a session to one machine. That blocks dense worker packing
and session relocation, and it is the right next structural change, but it
touches credential storage, so it wants its own review rather than riding
along with the router.
