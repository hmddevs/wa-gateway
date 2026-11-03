# `@hmddevs/wa-sdk` reference

Official TypeScript client for the HMD WhatsApp Gateway. Zero runtime dependencies, dual ESM/CJS, full type definitions. The SDK wraps the same HTTP API documented in [`API.md`](./API.md); pick the SDK unless you have a specific reason not to.

## Five-line quickstart

```ts
import { hmdWA } from '@hmddevs/wa-sdk';

const wa = hmdWA({ baseUrl: 'https://wa.example.com' }); // reads HMD_WA_API_KEY
const res = await wa.send({
  to: '+447700900123',
  purpose: 'transactional',
  body: { kind: 'text', text: 'Hello' },
});
console.log(res.messageId, res.status); // → "8e8f3a26-…", "queued"
```

## Install

```bash
pnpm add @hmddevs/wa-sdk
# npm i @hmddevs/wa-sdk
# yarn add @hmddevs/wa-sdk
```

Requires Node 18 or newer (uses built-in `fetch` and `AbortController`). Works in Node, Vercel Functions, Cloudflare Workers, Deno, and Bun.

## Configuration

```ts
import { hmdWA } from '@hmddevs/wa-sdk';

const wa = hmdWA({
  apiKey: process.env.HMD_WA_API_KEY, // string
  baseUrl: 'https://wa.example.com', // string, required
  timeoutMs: 10_000, // number, per-attempt
  maxRetries: 3, // number, up to 4 attempts total
  fetch: globalThis.fetch, // typeof fetch, inject in tests
  userAgent: 'session-a/1.4.2', // string, appended after the SDK UA
});
```

| Option       | Type           | Default                      | Notes                                                                                 |
| ------------ | -------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| `apiKey`     | `string`       | `process.env.HMD_WA_API_KEY` | Required. Throws `HmdWAError` `CONFIG_ERROR` if missing.                              |
| `baseUrl`    | `string`       | required                     | Trailing slashes trimmed. Set to your gateway's base URL.                             |
| `timeoutMs`  | `number`       | `10_000`                     | Per-attempt timeout. Aborted requests with `AbortError` become a retryable `TIMEOUT`. |
| `maxRetries` | `number`       | `3`                          | Up to four attempts in total. Set to `0` to disable retries.                          |
| `fetch`      | `typeof fetch` | `globalThis.fetch`           | Inject for tests, proxies, or to add observability.                                   |
| `userAgent`  | `string`       | ,                            | Appended after `@hmddevs/wa-sdk/<v> node`. Useful for log correlation.                |

The factory throws `HmdWAError` with `code: 'CONFIG_ERROR'` if `apiKey` or `baseUrl` is missing, or `globalThis.fetch` is not available.

## Methods

All methods accept a final `opts` argument with `{ signal?: AbortSignal }` for caller-side cancellation. Cancelling produces an `HmdWAError` with `code: 'ABORTED'`.

### `client.send(req, opts?)`

Enqueue an outbound WhatsApp message.

```ts
import type { SendMessageRequest, SendMessageResponse } from '@hmddevs/wa-sdk';

const res: SendMessageResponse = await wa.send(
  {
    to: '+447700900123',
    channel: 'transactional', // 'notification' | 'transactional' | 'internal'
    purpose: 'transactional', // required, no default; see API.md#project-and-purpose-metadata
    body: { kind: 'text', text: 'Order #4711 confirmed.' },
    ttlSeconds: 600,
    sendAt: '2026-04-28T18:00:00.000Z', // optional, schedule for later, ISO 8601 UTC
  },
  { idempotencyKey: 'order-4711-confirm' },
);
// res.messageId   → UUID v4
// res.status      → 'queued' on immediate send, 'scheduled' when sendAt is supplied
// res.idempotent  → true on replay, undefined on first call
```

Body kinds: `text`, `image`, `document`. Image and document bodies fetch from a publicly reachable URL (subject to an SSRF check at send time) and take an optional `caption`; documents also take a `filename`.

See [`API.md`](./API.md#post-v1messages--enqueue-an-outbound-message) for the full schema.

### Scheduled sends

Pass `sendAt` (ISO 8601 UTC) to park a message for later dispatch. Minimum 30 s in the future, maximum 30 days; outside that window the SDK surfaces `HmdWAError.code = 'SEND_AT_PAST'`. Response is `status: 'scheduled'`; poll `wa.get(messageId)` to observe the transition through `queued → sent → delivered`.

```ts
const res = await wa.send({
  to: '+447700900123',
  purpose: 'notification',
  body: { kind: 'text', text: 'Reminder: payment due tomorrow.' },
  sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});
// res.status === 'scheduled'
```

The scope check is driven by `channel`:

- `notification` → requires `send:notification`.
- `transactional` → requires `send:transactional` (default).
- `internal` → requires `send:internal`.

Wrong scope returns `403 SCOPE_DENIED`. The SDK surfaces this as an `HmdWAError` with `code: 'SCOPE_DENIED'`.

If `idempotencyKey` is supplied either in `opts` or on `req`, the SDK forwards it inside the request body on every retry; the gateway reads it from the body, and no header is involved. That makes 429/5xx retries safe, so you cannot double-send.

### Sending to a group

Set `to` to a WhatsApp group JID (`120363XXXXXXXXXXXX@g.us`) instead of a phone number to message a group. The dispatch path is otherwise identical to a DM send.

```ts
await wa.send({
  to: '120363012345678901@g.us',
  channel: 'transactional',
  purpose: 'notification',
  body: { kind: 'text', text: 'Deploy finished: all green.' },
});
```

Group caveats: `replyTo` (quoting) is not yet supported and returns `422`; the opt-out registry is phone-keyed and does not apply, so a group send is never blocked by `OPTED_OUT`; `sendAt` scheduling works normally. See [`API.md`](./API.md#sending-to-a-group).

### `client.sendAndConfirm(req, opts?)`

Like `send`, but waits for a terminal worker ack and returns `'sent' | 'failed' | 'queued'` synchronously. Use for auth-critical flows that need a clear go/no-go decision before falling back to a secondary channel (typically email).

```ts
const res = await wa.sendAndConfirm(
  {
    to: '+447700900123',
    purpose: 'otp',
    body: { kind: 'text', text: `Your code is ${otp}` },
    idempotencyKey: `otp-${userId}-${Date.now()}`,
  },
  { confirmTimeoutMs: 5000 },
);

if (res.status !== 'sent') {
  await sendEmailFallback(userId, otp); // 'failed' or 'queued'
}
```

`opts.confirmTimeoutMs` defaults to 5000 ms; the SDK validates it to the 300–30 000 ms range and throws `HmdWAError(code: 'CONFIG_ERROR')` before the network call if out of bounds. The SDK's per-attempt request timeout is automatically widened to `confirmTimeoutMs + 2000` for this call so a soft `'queued'` return from the gateway never collides with the SDK's own timeout.

`status: 'queued'` means the gateway timed out waiting for the worker ack, the message MAY still arrive later. Always pair `sendAndConfirm` with an `idempotencyKey` so a downstream retry on the same key does not double-send.

### `client.get(messageId, opts?)`

```ts
const detail = await wa.get('8e8f3a26-…');
// detail.statusHistory[], ordered timeline of status transitions
// detail.errorCode, set when status is 'failed'
// detail.ttlExpiresAt, auto-drop deadline
```

Returns `404 INVALID_BODY` (mapped to `HmdWAError`) if the id is unknown or owned by another key.

### `client.list(opts?)`

```ts
const page1 = await wa.list({ limit: 50 });
const page2 = await wa.list({ limit: 50, before: page1.messages.at(-1)?.messageId });
```

Pagination is cursor-based on `messageId`. `limit` is server-capped at 200. The body of each entry is summarised to `{ kind }` only.

### `client.listGroups(opts?)`

Discover the WhatsApp group JIDs the bound session belongs to, so one can be passed as `to` on `send`. Requires the `read:groups` scope. Results are strictly scoped to the session bound to the API key.

```ts
const { groups } = await wa.listGroups();
const jid = groups[0]?.jid; // e.g. '120363012345678901@g.us'

await wa.send({
  to: jid,
  channel: 'notification',
  purpose: 'notification',
  body: { kind: 'text', text: 'Standup in 10 minutes.' },
});
```

A group only appears once the session has seen at least one message in it (live or history-synced), so `groups` may be empty for a freshly paired session. `subject` (the group's name) is not currently captured, so it is always absent, `groups[].jid` is the only field guaranteed to be present.

### `client.send(req, { replyTo, … })`

`send` accepts an optional `replyTo: { messageId }`. Quote a prior outbound message we sent on this session and the recipient's WhatsApp client renders it as an inline reply.

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

The `messageId` MUST be one returned by a previous `wa.send` on the same API key (or another key bound to the same session). Cross-session ids and unknown ids return `404 RECIPIENT_NOT_FOUND` (mapped to `HmdWAError.code = 'RECIPIENT_NOT_FOUND'`). Quoting an inbound peer message is reserved for a later release.

### `client.react(messageId, emoji, opts?)` / `client.unreact(messageId, opts?)`

Set or clear the emoji reaction this session has on a prior outbound message.

```ts
import type { ReactionResponse } from '@hmddevs/wa-sdk';

const ack: ReactionResponse = await wa.react(original.messageId, '👍');
// ack.messageId  → reaction operation id (NOT the target message id)
// ack.emoji      → '👍'
// ack.status     → 'queued'

await wa.unreact(original.messageId);
```

Constraints:

- `emoji` must be a non-empty string of 1 to 8 characters and contain at least one emoji codepoint. The SDK rejects `''` and non-emoji input client-side as `HmdWAError.code = 'CONFIG_ERROR'` before any network call.
- The target message MUST already be in the `sent` (or later) state. Reacting to a queued message returns `422 INVALID_REACTION` because there is no underlying WhatsApp id yet.
- WhatsApp allows one reaction per (sender, message). Calling `react` again with a different emoji replaces the existing one. `unreact` clears it.

### `client.setTyping(to, on, opts?)`

Toggle the per-chat typing indicator for one recipient.

```ts
await wa.setTyping('+447700900123', true, { sessionId: 'session-a' });
// … your code does work …
await wa.setTyping('+447700900123', false, { sessionId: 'session-a' });
```

`on=true` sends `composing`; `on=false` sends `paused`. Use this around long-running work (LLM calls, search queries) to give the recipient an honest "we're on it" signal.

### `client.setPresence(state, opts?)`

Push a session-wide or chat-scoped presence indicator.

```ts
await wa.setPresence('available', { sessionId: 'session-a' });
await wa.setPresence('unavailable', { sessionId: 'session-a' });

// chat-scoped
await wa.setPresence('recording', { sessionId: 'session-a', to: '+447700900123' });
```

`PresenceState` is `'available' | 'unavailable' | 'composing' | 'recording' | 'paused'`. The chat-scoped states (`composing`, `recording`, `paused`) require `opts.to`; the session-wide states (`available`, `unavailable`) ignore it.

### Session id resolution

Both `setTyping` and `setPresence` are session-scoped: they target a specific Baileys session. The SDK resolves the session id in this order, picking the first non-empty value:

1. `opts.sessionId`.
2. `process.env.HMD_WA_SESSION_ID`.
3. The literal string `'default'`.

The resolved id MUST equal the API key's bound `sessionId`. Mismatches return `403 SCOPE_DENIED`. Set `HMD_WA_SESSION_ID` in environments where a single service owns a single session and you want method calls to stay terse.

### `client.status(opts?)`

```ts
const status = await wa.status();
if (status.status !== 'connected') {
  // 'initialising' | 'pairing' | 'connected' | 'degraded' | 'offline' | 'stopped'
  // Only 'connected' accepts new sends. Anything else → 503 WORKER_UNAVAILABLE on send.
}
```

Requires the `read:status` scope on the API key.

### Webhook route testing

The SDK does not expose webhook-route management or testing. Those endpoints (`/v1/admin/webhooks/*`) are gated by the admin WebAuthn step-up and cannot be reached with a service API key. Use the admin panel at `/admin` to send a test event to a route URL and verify your consumer's signature handling end-to-end.

## Errors

Every SDK failure is an `HmdWAError`:

```ts
import { HmdWAError, HMD_WA_ERROR_CODES, CLIENT_ERROR_CODES } from '@hmddevs/wa-sdk';

try {
  await wa.send({ to: '+1', purpose: 'transactional', body: { kind: 'text', text: 'x' } });
} catch (err) {
  if (err instanceof HmdWAError) {
    console.error({
      code: err.code, // gateway code OR client-side code
      httpStatus: err.httpStatus, // number | undefined (undefined for network/timeout)
      requestId: err.requestId, // include in support tickets
      retryable: err.retryable, // boolean, informational; SDK has already exhausted retries
      message: err.message,
    });
  } else {
    throw err;
  }
}
```

`code` is one of:

- A **gateway code** (`UNAUTHORIZED`, `SCOPE_DENIED`, `INVALID_BODY`, `INVALID_PHONE`, `WORKER_UNAVAILABLE`, `RATE_LIMITED`, …, see [`API.md`](./API.md#error-codes) for the full list).
- A **client code** from `CLIENT_ERROR_CODES`:
  - `CONFIG_ERROR`, missing API key, no `fetch`, or invalid argument (e.g. empty `messageId`).
  - `NETWORK_ERROR`, `fetch` threw before producing a response.
  - `TIMEOUT`, per-attempt timeout fired (`AbortError`).
  - `ABORTED`, caller cancelled via `opts.signal`.
  - `INVALID_RESPONSE`, gateway returned a non-JSON or malformed body on a 2xx.

Use `HMD_WA_ERROR_CODES` (the union of gateway and client codes) for exhaustive matching:

```ts
switch (err.code) {
  case HMD_WA_ERROR_CODES.SCOPE_DENIED:
    /* config issue, page on-call */ break;
  case HMD_WA_ERROR_CODES.WORKER_UNAVAILABLE:
    /* session offline, backoff and retry later */ break;
  case HMD_WA_ERROR_CODES.RATE_LIMITED:
    /* SDK exhausted retries, push to outbox */ break;
  case CLIENT_ERROR_CODES.CONFIG_ERROR:
    /* bug in caller, fail loudly */ break;
  case CLIENT_ERROR_CODES.TIMEOUT:
    /* network is degraded */ break;
  case HMD_WA_ERROR_CODES.RECIPIENT_NOT_FOUND:
    /* replyTo or reaction target unknown to this session */ break;
  case HMD_WA_ERROR_CODES.INVALID_REACTION:
    /* empty emoji on POST, or target not yet sent */ break;
  case HMD_WA_ERROR_CODES.INVALID_PRESENCE_STATE:
    /* presence body fails the schema */ break;
}
```

`HmdWAError.fromResponse(status, body, rawBody?)` is exported for advanced consumers that want to construct an error from a manual `fetch` against the gateway.

## Retry behaviour

The SDK retries automatically on:

- HTTP `408`, `429`, `500`, `502`, `503`, `504`.
- Transport errors (`NETWORK_ERROR`).
- Per-attempt timeouts (`TIMEOUT`).

It does **not** retry:

- Other 4xx (the request is malformed; retrying makes nothing better).
- `ABORTED` (caller asked to stop).
- `CONFIG_ERROR` (the call cannot be made).

Backoff:

- If the response carries `Retry-After` (integer seconds or HTTP-date), the SDK honours it, capped at 30 seconds.
- Otherwise, exponential backoff with jitter: `min(30s, 250ms * 2^attempt) + random(0..250ms)`.

`maxRetries` defaults to 3, giving up to four attempts. Set to `0` to disable retries entirely (your service may be doing its own outboxing).

The `idempotencyKey` body field is preserved across every retry, so a 429 followed by a 200 cannot produce two WhatsApp messages.

## Timeouts and cancellation

Two layers:

- **Per-attempt timeout** (`timeoutMs`, default 10 s). Fires through an internal `AbortController` and surfaces as `TIMEOUT` (retryable).
- **Caller signal** (`opts.signal`). Cancels the attempt and stops further retries; surfaces as `ABORTED` (not retryable).

Combined example:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000); // overall ceiling

try {
  await wa.send(
    {
      /* … */
    },
    { signal: ac.signal },
  );
} catch (err) {
  if (err instanceof HmdWAError && err.code === 'ABORTED') {
    // wall-clock budget exhausted
  }
}
```

## Webhook verification

Use `verifyWebhook(rawBody, signatureHeader, secret, opts?)` to validate the signature, replay window, and payload schema in one call.

```ts
import { verifyWebhook, WebhookVerificationError } from '@hmddevs/wa-sdk';

const event = await verifyWebhook(rawBody, signatureHeader, secret);
//   event: WebhookEvent, discriminated by event.type
```

Failure modes (all throw `WebhookVerificationError` with `code` set):

| `code`               | Cause                                                                               |
| -------------------- | ----------------------------------------------------------------------------------- |
| `missing_header`     | No `X-HMD-Signature`, or `rawBody`/`secret` is empty/wrong type.                    |
| `malformed_header`   | Header missing `t=` or `v1=`, body is not JSON, or body fails `WebhookEventSchema`. |
| `stale_timestamp`    | `\|now − t\| > toleranceSec` (default 300 s).                                       |
| `signature_mismatch` | HMAC did not match.                                                                 |

The function never returns silently on failure. It also never accepts a parsed JSON object, pass the **raw bytes the gateway sent**, exactly. Re-stringifying changes whitespace and key order and breaks the HMAC.

`opts`:

- `toleranceSec?: number` (default 300), narrow this only if you can guarantee tight clock sync.
- `nowUnixSec?: number`, for tests.

### Express

```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from '@hmddevs/wa-sdk';

const app = express();

app.post(
  '/hooks/wa',
  express.raw({ type: 'application/json' }), // gives us req.body as a Buffer
  async (req, res) => {
    try {
      const event = await verifyWebhook(
        (req.body as Buffer).toString('utf8'),
        req.header('x-hmd-signature') ?? null,
        process.env.HMD_WA_WEBHOOK_SECRET!,
      );

      // dedupe on event.eventId here, then process by type
      switch (event.type) {
        case 'message.delivered':
          /* … */ break;
        case 'message.failed':
          /* … */ break;
        case 'inbound.received':
          /* … */ break;
        default:
          /* ignore unknown types */ break;
      }

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

Do **not** mount `express.json()` on this route. The default JSON parser consumes the body and the HMAC will fail.

### Next.js (App Router)

```ts
// app/api/hooks/wa/route.ts
import { verifyWebhook, WebhookVerificationError } from '@hmddevs/wa-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text(); // raw, exact bytes
  try {
    const event = await verifyWebhook(
      raw,
      req.headers.get('x-hmd-signature'),
      process.env.HMD_WA_WEBHOOK_SECRET!,
    );

    // dedupe + process
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return Response.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
}
```

Acknowledge with 2xx as soon as the event is durably enqueued in your system. Long synchronous work risks the 5 s gateway timeout, which forces a retry with the same `eventId`.

## TypeScript

All public types are re-exported from the SDK. Consumers do not need a direct dependency on `@hmddevs/protocol`:

```ts
import type {
  // Outbound
  SendMessageRequest,
  SendMessageResponse,
  SendBody,
  SendChannel,
  SendReplyTo,
  GetMessageResponse,
  ListMessagesResponse,
  ListGroupsResponse,
  GroupSummary,
  WorkerStatusResponse,

  // Conversational primitives
  ReactionRequest,
  ReactionResponse,
  PresenceRequest,
  PresenceResponse,
  PresenceState,

  // Opt-outs
  OptOutEntry,
  ListOptOutsResponse,

  // Errors
  ErrorResponse,
  HmdWAErrorCode,

  // Webhooks
  WebhookEvent,
  WebhookEventType,
  MessageQueuedEvent,
  MessageSentEvent,
  MessageDeliveredEvent,
  MessageReadEvent,
  MessageFailedEvent,
  InboundReceivedEvent,
  InboundReactionEvent,
  ContactOptedOutEvent,
  WebhookTestEvent,
} from '@hmddevs/wa-sdk';
```

`WebhookEvent` is a discriminated union on `type`. TypeScript narrows based on the discriminant:

```ts
function handle(event: WebhookEvent): void {
  switch (event.type) {
    case 'message.failed':
      console.error(event.error.code, event.error.message); // narrowed
      return;
    case 'inbound.received':
      if (event.content.type === 'text') console.log(event.content.text); // narrowed twice
      return;
  }
}
```

Constants exported alongside types:

- `WEBHOOK_SIGNATURE_HEADER`, `'X-HMD-Signature'`
- `WEBHOOK_EVENT_HEADER`, `'X-HMD-Event'`
- `WEBHOOK_DELIVERY_HEADER`, `'X-HMD-Delivery-Id'`
- `WEBHOOK_TOLERANCE_SECONDS`, `300`
- `SDK_VERSION`, current SDK version, mirrors `package.json`.

## Versioning

The SDK follows semver. The re-exports of protocol types are treated as part of the SDK's stable contract: a breaking change to a public type is a major bump on the SDK, regardless of the protocol package's own version.

Patch releases may add new methods, new event types in the union, and new error codes. Existing methods, fields, and codes will not be repurposed.

## Changelog

- **Unreleased**, `listGroups` to discover the WhatsApp group JIDs the bound session belongs to (`read:groups` scope). New types: `ListGroupsResponse`, `GroupSummary`, `HmdWAListGroupsOptions`.
- **Unreleased** (breaking), removed template sends. `body.kind: 'template'` is no longer accepted by `send`; use `text`, `image`, or `document`. Removed types `MessageTemplate`/`TemplateBody` and error codes `TEMPLATE_NOT_FOUND`/`TEMPLATE_VAR_MISSING`.
- **0.3.0** (slice 2), template sends (`body.kind: 'template'` + `variables`), `sendAt` for scheduled sends. New types: `MessageTemplate`, `TemplateBody`, `OptOutEntry`, `ListOptOutsResponse`, `ContactOptedOutEvent`. New error codes: `TEMPLATE_NOT_FOUND`, `TEMPLATE_VAR_MISSING`, `SEND_AT_PAST`, `OPTED_OUT`. New webhook event: `contact.opted_out`.
- **0.2.0** (slice 1, conversational primitives), `replyTo` on `send`, plus `react`, `unreact`, `setTyping`, `setPresence`. New types: `ReactionRequest`, `ReactionResponse`, `PresenceRequest`, `PresenceResponse`, `PresenceState`, `SendReplyTo`, `InboundReactionEvent`. New error codes: `RECIPIENT_NOT_FOUND`, `INVALID_REACTION`, `INVALID_PRESENCE_STATE`. New webhook event: `inbound.reaction`.
- **0.1.0**, initial release. `send`, `get`, `list`, `status`, `verifyWebhook`. Dual ESM/CJS, zero runtime dependencies.
