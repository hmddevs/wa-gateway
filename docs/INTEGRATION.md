# Integration guide

How to wire an HMD service (Acme, Example Travel, Example Logistics, internal tools) into the WhatsApp gateway. Allow about 10 minutes from key issuance to first message in production. Pair with [`SDK.md`](./SDK.md) for the typed client and [`API.md`](./API.md) for the raw HTTP surface.

## Before you start

You need:

- **Node 18+** in your service runtime (Node 20 LTS preferred). Required by the SDK's reliance on built-in `fetch` and `AbortController`.
- An **API key**, admin-issued. See below.
- A **public HTTPS endpoint** for receiving webhooks **or** a willingness to poll `client.list` from a cron. Webhooks are strongly preferred.
- A **secrets manager** (Vercel env vars, AWS Secrets Manager, Doppler, 1Password, whatever your service already uses). API keys and webhook secrets must not live in code or in plaintext config.

## Getting an API key

The WA gateway has no self-service signup. Keys are issued by the gateway admin in the admin panel.

1. Open a request with the WA admin (your project's HMD ops contact). Provide:

   - Service name and the HMD division it sits under (`developments`, `payments`, `core`, …).
   - The **session** you need to send through (one phone number, e.g. `session-a`). One key is bound to one session permanently.
   - Required **scopes**: pick the minimum set.
     - `send:notification`, broadcast-style notifications.
     - `send:transactional`, order confirmations, OTPs, account events. Most services use this.
     - `send:internal`, only for HMD internal tooling.
     - `send:new_recipients`: defined in the protocol for a future new-recipient gate; it is not currently enforced, so holding or lacking it has no effect on sends today.
     - `read:status`, required if you intend to call `client.status()`.
   - Whether the key is **test** or **live**. Test keys must point at test sessions; live keys at live. Do not mix.
   - Optional **IP allowlist** (CIDRs). Strongly recommended for keys living in a known egress range.
   - Per-minute **rate limit** (default suits most services).

2. The admin issues the key with WebAuthn step-up. The full secret is shown **once**. They will paste it to you over a secure channel (1Password share, signed message, never email, never Slack DM in plain text). After that point, only the argon2id hash is kept.

3. Store the key in your service's secrets manager as `HMD_WA_API_KEY`. Confirm receipt; then delete the share.

The key has the format `hmd_sk_<division>_<env>_<43-char-secret>`. The division and env are visible by inspection, useful for log triage, useless to an attacker.

## Environment variables

Canonical names. Use these unless you have an unavoidable reason to differ.

| Var                     | Required                  | Notes                                                                                    |
| ----------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `HMD_WA_API_KEY`        | yes                       | Bearer key. The SDK reads this if `apiKey` is not passed to `hmdWA()`.                   |
| `HMD_WA_WEBHOOK_SECRET` | yes if receiving webhooks | Per-route HMAC secret. Different for every webhook route. Store in your secrets manager. |

If your service handles webhooks for multiple routes, scope the env name (e.g. `HMD_WA_WEBHOOK_SECRET_SESSION_A`, `HMD_WA_WEBHOOK_SECRET_SESSION_B`) and pick the right one based on the path or the `X-HMD-Delivery-Id` correlation in your handler.

## Sending your first message

Install the SDK:

```bash
pnpm add @hmddevs/wa-sdk
```

Send:

```ts
import { hmdWA, HmdWAError } from '@hmddevs/wa-sdk';

const wa = hmdWA({ baseUrl: 'https://wa.example.com' }); // reads HMD_WA_API_KEY; baseUrl is required, no default

try {
  const res = await wa.send(
    {
      to: '+447700900123',
      channel: 'transactional',
      purpose: 'transactional',
      body: { kind: 'text', text: 'Order #4711 confirmed.' },
    },
    { idempotencyKey: 'order-4711-confirm' },
  );
  console.log('messageId:', res.messageId);
} catch (err) {
  if (err instanceof HmdWAError) {
    // Surface err.code + err.requestId to your error tracker.
    console.error('wa send failed', err.code, err.requestId, err.message);
  }
  throw err;
}
```

A successful response is `{ messageId, status: 'queued' }` with HTTP 202. The message is now durably queued; the worker will pick it up and deliver to WhatsApp asynchronously.

If you need to know what happened next (delivered, read, failed), receive webhooks. Polling `client.get(messageId)` works in a pinch but does not scale.

## Synchronous confirm vs async send

The default `client.send` returns 202 the moment the gateway has durably queued the message, fast (~150 ms), webhook-driven, the right shape for fan-out (notifications, reminders, marketing).

For auth-critical flows where the caller must decide _now_ whether to fall back to email or SMS, use `client.sendAndConfirm`. The gateway holds the response until the worker acks the WhatsApp send (or `confirmTimeoutMs` elapses) and returns one of `'sent' | 'failed' | 'queued'`.

```ts
const res = await wa.sendAndConfirm(
  {
    to: user.phone,
    purpose: 'otp',
    body: { kind: 'text', text: `Login code: ${code}` },
    idempotencyKey: `login-${user.id}-${code}`,
  },
  { confirmTimeoutMs: 5000 },
);

if (res.status !== 'sent') {
  await sendEmailFallback(user, code);
}
```

**Latency budget.** Plan for `confirmTimeoutMs + ~150 ms` end-to-end. The SDK extends its own request timeout to `confirmTimeoutMs + 2000` so a gateway-side `'queued'` return never collides with an SDK retry.

**When to use it.** OTP, password reset, login alerts, payment confirmations, anywhere a missed message is more expensive than waiting up to five seconds. **Don't** use it for fan-out, marketing, or anything where each individual recipient's success doesn't gate caller logic. Default async + webhooks scales; per-message subscribers don't.

**Idempotency is mandatory.** A `'queued'` return means the gateway timed out, but the worker may still complete the send. Always pair `sendAndConfirm` with an `idempotencyKey` so a downstream retry on the same key collapses to the same `messageId` and never double-sends.

**Redis footnote.** Each confirm-mode call opens a fresh Upstash subscriber on the gateway side, Vercel serverless can't hold long-lived subscriptions. Connection budget is per active confirm request, not per active client.

## Conversational primitives

Slice 1 of the gateway adds three patterns most chat-style integrations want: quoted replies, reactions, and a typing indicator. All three ride the same auth and rate-limit posture as `send`.

### Quoted replies

```ts
const original = await wa.send({
  to: '+447700900123',
  purpose: 'transactional',
  body: { kind: 'text', text: 'Order #4711 confirmed.' },
});

await wa.send({
  to: '+447700900123',
  purpose: 'transactional',
  body: { kind: 'text', text: 'Sorry, that should have been #4712.' },
  replyTo: { messageId: original.messageId },
});
```

The `replyTo.messageId` MUST be a UUID returned from a prior `wa.send` on this session. Cross-session ids and unknown ids return `404 RECIPIENT_NOT_FOUND`. Quoting an inbound peer message is reserved for a later release; for now, use replies to disambiguate corrections to your own outbound messages (typo fixes, status updates).

### Reactions

```ts
await wa.react(original.messageId, '👍'); // POST /v1/messages/:id/reactions
await wa.unreact(original.messageId); // DELETE /v1/messages/:id/reactions
```

Constraints: the target message must already be in `sent` (or later); empty emojis go through `unreact`, not `react`. WhatsApp allows one reaction per (sender, message), so calling `react` again with a different emoji replaces the existing one.

You also receive **inbound reactions** as webhooks. Add `inbound.reaction` to your route's event list, then handle:

```ts
case 'inbound.reaction':
  // event.from           → '+447700900123'
  // event.waMessageId    → raw WhatsApp id of the reacted-to message
  // event.targetFromMe   → boolean, did we author the original?
  // event.messageId?     → gateway UUID, set when targetFromMe is true and we still have the original on file
  // event.emoji          → '👍' (empty string when the peer cleared their reaction)
  if (event.targetFromMe && event.messageId) {
    await markCustomerReaction(event.messageId, event.emoji);
  }
  break;
```

A peer clearing their reaction comes through as the same event with `emoji: ''`. Your handler should treat that as "remove the previously stored reaction" rather than "ignore".

### Typing indicator

```ts
await wa.setTyping('+447700900123', true, { sessionId: 'session-a' });
// … your code does work (LLM, search, payments) …
await wa.setTyping('+447700900123', false, { sessionId: 'session-a' });
```

`setTyping` is fire-and-forget. The recipient sees "typing…" while the indicator is active. Use it around any synchronous work that takes more than a second: the indicator is honest UX, not theatre. Always pair an `on=true` with a matching `on=false`; an unbounded "typing" state looks broken on the receiving phone.

For session-wide presence (a different signal: are we here at all?):

```ts
await wa.setPresence('available', { sessionId: 'session-a' });
await wa.setPresence('unavailable', { sessionId: 'session-a' });
```

The session id MUST equal the API key's bound session, otherwise the gateway responds `403 SCOPE_DENIED`. Set `HMD_WA_SESSION_ID` in your service's environment so you don't have to pass `{ sessionId }` on every call.

### Read-receipt toggle

By default the worker calls `sock.readMessages([key])` on every inbound message, the peer sees double blue ticks. Some HMD products want that off (privacy posture, support inboxes that should not appear "read at 03:14"). The toggle lives in the admin panel:

1. `/admin` → Sessions panel.
2. Find your session card.
3. Untick **Send read receipts**. The change is applied at the next worker config refresh (within 30 s).

When off, inbound messages still arrive in webhooks; the worker just stops acknowledging them upstream. Senders see only a single grey tick. Document the choice for the team handling that session, and document the user-facing behaviour change for your service.

## Scheduled sends

Pass `sendAt` on `wa.send` (ISO 8601 UTC) to park a message for a future minute. The response carries `status: 'scheduled'` instead of `'queued'`; a per-minute cron on the gateway dispatches it. Poll `wa.get(messageId)` or wait for the usual `message.sent` / `message.delivered` webhooks to observe the transition.

```ts
const res = await wa.send({
  to: '+447700900123',
  purpose: 'notification',
  body: { kind: 'text', text: 'Reminder: payment due tomorrow.' },
  sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});
// res.status === 'scheduled'
```

A few rules to bake into your scheduler:

- **Always UTC.** Compute `sendAt` from a UTC instant (`new Date(...).toISOString()`, Luxon `toUTC().toISO()`, or your DB's UTC timestamp). Local-offset strings work as long as the parsed instant is right, but UTC is the canonical form and avoids DST surprises around the boundary.
- **Lead time floor.** `sendAt` MUST be at least 30 s in the future. Anything earlier returns `422 SEND_AT_PAST` (`HmdWAError.code = 'SEND_AT_PAST'`). If you compute `sendAt` from a queued job, account for clock skew and queue latency, pad by 60 s rather than racing the floor.
- **Horizon ceiling.** 30 days. Beyond that, also `SEND_AT_PAST`. Long-horizon scheduling belongs in your service's own scheduler; only push to the WA gateway once you are inside the window.
- **Latency budget.** Cron runs once a minute, so add up to ~60 s between `sendAt` and the actual WhatsApp send. If you need second-precision delivery, that is not what this surface is for.
- **Late validation.** Opt-out, scope, and worker-availability checks run again at dispatch time. A scheduled message can fail at dispatch even though scheduling succeeded, listen for `message.failed` and surface the failure to the same domain object you scheduled against.

There is no API to cancel a scheduled message. If your domain logic needs cancellation (the order was refunded before the reminder fired), keep the gateway dispatch close to the action and let cancellation happen upstream of the `wa.send` call.

## Opt-out handling

Each session keeps a per-session opt-out registry. The gateway enforces it at send time: a `wa.send` to a listed number returns `422 OPTED_OUT` (`HmdWAError.code = 'OPTED_OUT'`). Subscribe to the `contact.opted_out` webhook to keep your domain mirror in sync.

Add `contact.opted_out` to your route's event list, then handle it alongside the message events:

```ts
case 'contact.opted_out':
  // event.phone      → '+447700900123'
  // event.source     → 'keyword' | 'admin'
  // event.keyword?   → matched STOP keyword (only when source === 'keyword')
  await markContactOptedOut(event.phone, {
    source: event.source,
    keyword: event.keyword,
    sessionId: event.sessionId,
  });
  break;
```

Treat the event as authoritative: stop scheduling new messages to that number, suppress in-flight reminders, and remove the contact from any campaign list. The gateway will continue to reject sends to that number with `OPTED_OUT` regardless of what your service tries.

A few practical notes:

- **Inbound STOP keywords, two-step confirmation.** A lone keyword does not opt the sender out: the gateway opens a 30-minute confirmation window and prompts the sender to repeat the keyword; only the second matching message within that window commits the opt-out and fires the webhook. The default keyword is `STOP`, case-insensitive against the trimmed inbound text. Set the list per session via `PATCH /api/admin/sessions/:id` with `{ "conversation": { "optOutKeywords": ["STOP", "UNSUBSCRIBE", "ARRÊT"] } }` (up to 10 keywords, 1–32 chars each). An empty array reverts to the default `STOP` keyword rather than disabling keyword opt-outs. Most services should leave the defaults and add localised keywords on top.
- **Re-opt-in.** There is no public re-opt-in endpoint. When a customer explicitly asks to be re-enabled, ask the gateway admin to call `DELETE /api/admin/sessions/:id/optouts/:phone`. No webhook fires for re-opt-in (intentionally, the audit lives in the admin log). Your service should treat this as an out-of-band correction.
- **Idempotency.** The webhook is at-least-once, like every other event. Dedupe by `event.eventId` as you already do for message events.
- **Scheduled sends.** The opt-out check runs at dispatch time, not at scheduling time. A customer who opts out between `wa.send({ sendAt })` and the cron tick sees nothing; the gateway returns `OPTED_OUT` and emits `message.failed`. Handle this in the same code path as a regular failed send.

## Receiving webhooks

The gateway POSTs JSON events to your URL with a signed timestamped header. Verify the signature with `verifyWebhook` from the SDK; it handles HMAC, replay window, and payload schema in one call.

### Setting up a route

Webhook routes are admin-managed. Ask the gateway admin to create a route for your service:

- **URL**, your HTTPS endpoint (HTTPS is enforced).
- **Scope**, `apiKey` (events scoped to one key) or `session` (all events on the session, regardless of which key sent them). For most services, `session` is right.
- **Events**: pick from `message.queued`, `message.sent`, `message.delivered`, `message.read`, `message.failed`, `inbound.received`, `inbound.reaction`, `contact.opted_out`, `webhook.test`.
- **Description**, human label so the admin panel is readable.

The admin will give you the **secret** (32 random bytes, base64url) on creation. The gateway stores it AES-256-GCM-encrypted; the raw value is never returned again. Put it on `HMD_WA_WEBHOOK_SECRET` in your secrets manager.

### Vercel / Next.js (App Router)

Most HMD services run here.

```ts
// app/api/hooks/wa/route.ts
import { verifyWebhook, WebhookVerificationError } from '@hmddevs/wa-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text(); // raw bytes, do not parse before verifying
  let event;
  try {
    event = await verifyWebhook(
      raw,
      req.headers.get('x-hmd-signature'),
      process.env.HMD_WA_WEBHOOK_SECRET!,
    );
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return Response.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }

  // Dedupe by event.eventId, the gateway is at-least-once.
  if (await alreadyProcessed(event.eventId)) {
    return new Response(null, { status: 204 });
  }

  switch (event.type) {
    case 'message.delivered':
      await markDelivered(event.messageId);
      break;
    case 'message.failed':
      await markFailed(event.messageId, event.error.code);
      break;
    case 'inbound.received':
      await ingestInbound(event);
      break;
    default:
      // Ignore unknown types, additive new types may arrive in patch releases.
      break;
  }

  await markProcessed(event.eventId);
  return new Response(null, { status: 204 });
}
```

Acknowledge with 2xx as soon as the event is durably enqueued. The gateway times out at 5 seconds; long synchronous work forces a retry with the same `eventId`.

### Express

```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from '@hmddevs/wa-sdk';

const app = express();

app.post(
  '/hooks/wa',
  express.raw({ type: 'application/json' }), // raw body parser, required
  async (req, res) => {
    try {
      const event = await verifyWebhook(
        (req.body as Buffer).toString('utf8'),
        req.header('x-hmd-signature') ?? null,
        process.env.HMD_WA_WEBHOOK_SECRET!,
      );

      if (await alreadyProcessed(event.eventId)) {
        return res.status(204).end();
      }
      await dispatch(event);
      await markProcessed(event.eventId);
      res.status(204).end();
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        res.status(400).json({ error: err.code });
        return;
      }
      throw err;
    }
  },
);
```

Do not mount `express.json()` on this path. The default parser consumes the body and the HMAC fails.

### Fastify

```ts
import Fastify from 'fastify';
import { verifyWebhook, WebhookVerificationError } from '@hmddevs/wa-sdk';

const app = Fastify();

app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  // Pass the raw string straight through; we'll verify before parsing.
  done(null, body);
});

app.post('/hooks/wa', async (req, reply) => {
  const raw = req.body as string;
  try {
    const event = await verifyWebhook(
      raw,
      (req.headers['x-hmd-signature'] as string | undefined) ?? null,
      process.env.HMD_WA_WEBHOOK_SECRET!,
    );

    if (await alreadyProcessed(event.eventId)) return reply.code(204).send();
    await dispatch(event);
    await markProcessed(event.eventId);
    return reply.code(204).send();
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return reply.code(400).send({ error: err.code });
    }
    throw err;
  }
});
```

The default Fastify JSON parser also normalises whitespace; the override above keeps the raw string available.

## Production posture

- **Idempotency on `send`.** Always pass an `idempotencyKey` tied to your domain object (`order-4711-confirm`, `alert-${incidentId}`, `otp-${userId}-${nonce}`). Length 8–128 characters. The SDK forwards it across retries, so a transient 429/5xx never produces a duplicate WhatsApp message.
- **Rate limits.** Three fixed-window (60 s) tiers: global (10 000/min), per IP (1200/min by default, env-configurable), per key (configured per key). The SDK retries 429s with capped backoff and `Retry-After` honour. If you call the API directly, treat 429 as transient.
- **`X-Request-Id` correlation.** Every error from the SDK carries `err.requestId`. Log it. Forward it to your error tracker (Sentry, Datadog). If you raise a support ticket, the request id is the only thing the admin needs to pull the full chain of audit + structured logs from MongoDB and Vercel.
- **Monitoring.** Track:
  - Send success rate (`HmdWAError` count by `code`).
  - Latency of the `send` call (p50/p99). Healthy is <500 ms.
  - Webhook receiver: count of verification failures, dedupe hits, processing latency.
  - `client.status().status` if you have `read:status`, alert on prolonged `degraded` or `offline`.
- **Webhook handler.** Idempotency by `eventId` is mandatory. The gateway is at-least-once: retries can arrive minutes or hours after the first delivery.

## Test vs live

Two separate environments:

- **Test:** test API key (`hmd_sk_<division>_test_…`) + test session. Use freely in CI and local dev.
- **Live:** live API key (`hmd_sk_<division>_live_…`) + live session bound to the real HMD WhatsApp number. Treat with the same care as a payments key.

Switch by environment variable, never by code branch. A typical Vercel project has `HMD_WA_API_KEY` set differently in the Preview and Production environments.

## Rotation

### API key

In-place rotation is not supported (the secret is hashed). Procedure:

1. Ask the admin to issue a new key with the same scopes / IP allowlist / session.
2. Update `HMD_WA_API_KEY` in your secrets manager to the new value. Redeploy.
3. Confirm traffic on the new key (admin panel shows last-used timestamp).
4. Ask the admin to revoke the old key.

Plan a 5–10 minute overlap window for rolling deploys.

### Webhook secret

In-place secret rotation is not supported (the route stores an encrypted blob). Procedure:

1. Ask the admin to create a **new route** at the same URL (or a new URL, your choice).
2. Update `HMD_WA_WEBHOOK_SECRET` in your secrets manager. If you stayed at the same URL, your handler now needs to accept either the old or the new secret during the overlap; the simplest fix is dual-verify (try the new secret, fall back to the old).
3. Once you see successful deliveries on the new route, ask the admin to delete the old one.

This trade-off keeps the gateway's invariant simple: one secret per route, immutable. We accept the operational cost of a swap procedure.

## Troubleshooting

| Symptom                                            | Likely cause                                                                                          | Fix                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`                                     | Key wrong, revoked, or env var not loaded                                                             | Verify `HMD_WA_API_KEY` is set in the running environment. Check the admin panel for the key's `revokedAt`.                                         |
| `SCOPE_DENIED`                                     | Key lacks the scope for the channel you sent on                                                       | Either send on a channel you have scope for, or ask the admin to grant the missing scope.                                                           |
| `IP_NOT_ALLOWED`                                   | Egress IP not in the key's allowlist                                                                  | Vercel's egress IPs change per region. Either widen the allowlist or remove it.                                                                     |
| `INVALID_PHONE`                                    | `to` could not be normalised to E.164                                                                 | Ensure `+` prefix and digits only. Reject empty / placeholder numbers before calling `wa.send`.                                                     |
| `INVALID_BODY`                                     | Body fails the Zod schema, or path resource not found                                                 | Read the `error` message; verify against [`packages/protocol/src/api.ts`](../packages/protocol/src/api.ts).                                         |
| `PAYLOAD_TOO_LARGE`                                | Body > 64 KiB                                                                                         | Reduce the text/caption or send media via URL rather than data URI.                                                                                 |
| `RATE_LIMITED`                                     | One of the three tiers tripped                                                                        | The SDK already retries; if you still see it surfaced, you are sustained over budget. Raise the per-key limit with the admin or shed load upstream. |
| `WORKER_UNAVAILABLE`                               | Bound session not `connected` (pairing, offline, stopped)                                             | Check `wa.status()`. The Mac worker may need attention. Page the WA admin.                                                                          |
| `RECIPIENT_NOT_FOUND`                              | `replyTo.messageId` or reaction target unknown to this session                                        | Confirm you're using a UUID returned from a prior `wa.send` on the same session. Cross-session ids are intentionally rejected.                      |
| `INVALID_REACTION`                                 | Empty emoji on `wa.react`, non-emoji input, or target not yet sent                                    | Use `wa.unreact` to clear; ensure the target message has reached `sent` before reacting.                                                            |
| `INVALID_PRESENCE_STATE`                           | Body fails `PresenceStateSchema`                                                                      | Pick from `'available'`, `'unavailable'`, `'composing'`, `'recording'`, `'paused'`.                                                                 |
| `MAINTENANCE`                                      | Reserved for a future gateway maintenance mode                                                        | Not currently emitted by any route; if you see it, treat as unexpected and open a ticket.                                                           |
| Webhook `WebhookVerificationError stale_timestamp` | Receiver clock is off, or you queued and processed the body more than 5 minutes after receipt         | Sync NTP. Process webhooks immediately on receipt; do not buffer them through a slow queue before verifying.                                        |
| Webhook `signature_mismatch`                       | Wrong secret, wrong body bytes (a parser ate it), or someone re-stringified the JSON before verifying | Confirm the secret matches the route. Confirm you are passing the **raw bytes** to `verifyWebhook`.                                                 |
| Same event processed twice                         | Normal, gateway is at-least-once                                                                      | Dedupe by `event.eventId` at the start of your handler.                                                                                             |

## Support

Open a ticket with your project's WA admin / HMD ops contact. Include:

- The `requestId` of a failing call (mandatory for `send` failures).
- The `eventId` and `X-HMD-Delivery-Id` of a failing webhook (for delivery issues).
- The time window in UTC.
- The HMD service name and environment (test/live).
- The error code (never paste the human-readable message, it changes).

The admin can pull the full request chain from the audit log and structured logs in seconds with the request id.
