# @hmddevs/wa-sdk

Official client SDK for the HMD WhatsApp Gateway. Zero runtime dependencies, dual ESM/CJS, full TypeScript types.

## Quickstart

```ts
import { hmdWA } from '@hmddevs/wa-sdk';

const wa = hmdWA({ apiKey: process.env.HMD_WA_API_KEY, baseUrl: 'https://wa.example.com' });
const res = await wa.send({
  to: '+447700900123',
  purpose: 'transactional',
  body: { kind: 'text', text: 'Hello' },
});
console.log(res.messageId, res.status);
```

## Install

```bash
pnpm add @hmddevs/wa-sdk
# or: npm i @hmddevs/wa-sdk / yarn add @hmddevs/wa-sdk
```

Requires Node 18 or newer (uses built-in `fetch`).

## Configuration

```ts
hmdWA({
  apiKey, // string. Defaults to process.env.HMD_WA_API_KEY.
  baseUrl, // string. Required, e.g. https://wa.example.com. Trailing slashes trimmed.
  timeoutMs, // number. Per-attempt timeout. Defaults to 10_000.
  maxRetries, // number. Defaults to 3 (so up to 4 attempts on 429/5xx + network errors).
  fetch, // typeof fetch. Inject a custom transport (testing, proxies).
  userAgent, // string. Appended to the default UA `@hmddevs/wa-sdk/<v> node`.
});
```

The factory throws `HmdWAError` (`code: 'CONFIG_ERROR'`) if `apiKey` or `baseUrl` is missing, or `globalThis.fetch` is not available.

## Sending messages

```ts
const wa = hmdWA({ baseUrl: 'https://wa.example.com' });

await wa.send(
  {
    to: '+447700900123',
    channel: 'transactional',
    purpose: 'transactional',
    body: { kind: 'text', text: 'Order #4711 confirmed.' },
  },
  { idempotencyKey: 'order-4711-confirm' },
);

// `purpose` is required. Pick the narrowest value: 'otp' | 'magic_link' |
// 'transactional' | 'notification' | 'support' | 'marketing' | 'campaign' |
// 'newsletter' | 'announcement' | 'other'. The gateway returns 400 if it's
// missing. Short-lived secrets (OTP, magic link) are a server-side concern:
// use a short TTL and single-use semantics on your side, since the WhatsApp
// transport itself does not provide ephemerality.

// Other body kinds: image, document (see SendBody types).

// Need a synchronous go/no-go before falling back to another channel?
// `sendAndConfirm` forces `confirm: true` and waits (default 5s, 300–30000ms
// range) for a terminal 'sent' | 'failed' | 'queued' status.
await wa.sendAndConfirm({
  to: '+447700900123',
  purpose: 'otp',
  body: { kind: 'text', text: 'Your code is 482913.' },
});

// Lookup, list, status.
await wa.get(messageId);
await wa.list({ limit: 50, before: cursor });
await wa.status();
```

`send` is exactly-once when an `idempotencyKey` is supplied. The same key is forwarded on every retry, so transient 429/5xx never produces a duplicate WhatsApp message. Choose a stable key tied to your domain object (order id, ticket id, …), at least 8 characters.

`projectId` is not a send-call argument. It is stamped on the API key when an admin issues it (slug regex `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, immutable after issuance) and the gateway persists it on every resulting message for multi-tenant audit, billing, and downstream routing. To change project attribution, ask an admin to issue a new key.

### Sending to a group

Pass a WhatsApp group JID as `to` to message a group instead of a contact. Everything else is identical to a DM send.

```ts
await wa.send({
  to: '120363012345678901@g.us', // group JID, not a phone number
  channel: 'transactional',
  purpose: 'notification',
  body: { kind: 'text', text: 'Deploy finished: all green.' },
});
```

Caveats: `replyTo` (quoting) is not yet supported for groups and returns `422`; the phone-keyed opt-out registry does not apply, so a group send is never blocked by `OPTED_OUT`; `sendAt` (scheduling) works normally.

### Discovering group JIDs

WhatsApp group JIDs are not shown anywhere in the app, so use `client.listGroups()` to find one before sending. Requires the `read:groups` scope.

```ts
// Discover the group JIDs this key's session belongs to.
const { groups } = await wa.listGroups();
// groups: [{ jid: '120363012345678901@g.us', lastActivityAt: '2026-07-15T09:12:00.000Z' }]
```

A group only appears once the session has seen at least one message in it, so `groups` may be empty for a freshly paired session.

Each entry may also carry group metadata the gateway has captured, `subject`, `subjectOwner`, `subjectTime`, `creation`, `owner`, `desc`, `descId`, `announce`, `restrict`, `size`, `ephemeralDuration`, `inviteCode`, `participants`, `metadataFetchedAt`, all optional and additive; a group with activity but no captured metadata is still listed, just without them.

**Privacy note.** When present, `participants` lists every group member's JID (their phone number, in effect) and admin role (`'admin' | 'superadmin' | null`), for every member of the group, not only those who have messaged the session directly. This is exposed to any API key holding the `read:groups` scope, which previously revealed only group JIDs. Bear this in mind before issuing that scope to a key.

The retry policy retries on `408`, `429`, `500`, `502`, `503`, `504`, and network errors. It honours `Retry-After` (integer seconds or HTTP-date), capped at 30 seconds, and otherwise applies exponential backoff with jitter.

## Conversational primitives

```ts
const wa = hmdWA({ baseUrl: 'https://wa.example.com' });

// Quote a prior message, recipient sees it as an inline reply.
const original = await wa.send({
  to: '+447700900123',
  purpose: 'transactional',
  body: { kind: 'text', text: 'Order #4711 confirmed.' },
});
await wa.send({
  to: '+447700900123',
  purpose: 'transactional',
  body: { kind: 'text', text: 'Sorry, typo, order #4712.' },
  replyTo: { messageId: original.messageId },
});

// React to a previous outbound message; replaces any existing reaction.
await wa.react(original.messageId, '👍');
await wa.unreact(original.messageId);

// Typing indicator, flip on while you're composing, off when you stop.
await wa.setTyping('+447700900123', true);
// … work …
await wa.setTyping('+447700900123', false);

// Session-wide presence (no `to`).
await wa.setPresence('available');
await wa.setPresence('unavailable');
```

`setTyping` and `setPresence` are session-scoped, they need to know which session to act on. Pass `{ sessionId }` explicitly, or set `HMD_WA_SESSION_ID` in the environment. The session id MUST match the API key's bound session; otherwise the gateway responds 403.

`react` requires the target message to be one this API key already sent and acknowledged. Reactions on inbound messages, or on outbound messages still in the queue, are 404 / 422 respectively.

## Verifying webhooks

The gateway signs every webhook with `HMAC-SHA256` over `t.rawBody` and emits the result in `X-HMD-Signature: t=<unix>,v1=<hex>`. Use the raw request body, do not re-stringify a parsed JSON object before verifying.

### Express

```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from '@hmddevs/wa-sdk';

const app = express();

app.post('/hooks/wa', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await verifyWebhook(
      req.body.toString('utf8'),
      req.header('x-hmd-signature'),
      process.env.HMD_WA_WEBHOOK_SECRET!,
    );
    // event is fully typed, discriminated by event.type
    console.log('event:', event.type, event.eventId);
    res.status(204).end();
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      res.status(400).json({ error: err.code });
      return;
    }
    throw err;
  }
});
```

### Next.js (App Router)

```ts
import { verifyWebhook, WebhookVerificationError } from '@hmddevs/wa-sdk';

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();
  try {
    const event = await verifyWebhook(
      raw,
      req.headers.get('x-hmd-signature'),
      process.env.HMD_WA_WEBHOOK_SECRET!,
    );
    // route on event.type
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return Response.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
}
```

`verifyWebhook` rejects when the signature is missing/malformed, the `t=` timestamp is outside the ±300s window, the HMAC does not match, or the body fails `WebhookEventSchema` validation. It never returns silently on failure.

## Errors

Every failure surfaced by the SDK is an `HmdWAError`:

```ts
import { HmdWAError, HMD_WA_ERROR_CODES } from '@hmddevs/wa-sdk';

try {
  await wa.send({ to: '+1', purpose: 'transactional', body: { kind: 'text', text: 'x' } });
} catch (err) {
  if (err instanceof HmdWAError) {
    console.error(err.code, err.httpStatus, err.requestId, err.retryable);
    if (err.code === HMD_WA_ERROR_CODES.INVALID_PHONE) {
      /* … */
    }
  } else {
    throw err;
  }
}
```

Always include `err.requestId` when raising a support ticket.

## TypeScript

All public types are re-exported from the SDK, so consumers do not need a direct dependency on `@hmddevs/protocol`:

```ts
import type {
  SendMessageRequest,
  SendMessageResponse,
  GetMessageResponse,
  ListMessagesResponse,
  WorkerStatusResponse,
  WebhookEvent,
  WebhookEventType,
} from '@hmddevs/wa-sdk';
```

## Reference

Full reference: [docs/SDK.md](https://github.com/hmddevs/wa-gateway/blob/main/docs/SDK.md). Integration guide: [docs/INTEGRATION.md](https://github.com/hmddevs/wa-gateway/blob/main/docs/INTEGRATION.md).

## Licence

MIT, © HMD Developments.
