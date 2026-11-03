import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';
import { Endpoint } from '@/components/docs/endpoint';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Send a message',
  description: 'Full reference for POST /v1/messages: enqueue an outbound WhatsApp message.',
};

export default function SendMessagePage() {
  return (
    <article className="doc-prose">
      <h1>Send a message</h1>
      <p className="doc-lead">
        Enqueue an outbound WhatsApp message to a single recipient. The gateway accepts the request,
        persists it, and dispatches it to the bound session asynchronously, unless you opt into
        synchronous confirm mode.
      </p>

      <Endpoint method="POST" path="/v1/messages" />

      <h2 id="authentication">Authentication and scope</h2>
      <p>
        Requires a Bearer API key in the <code>Authorization</code> header. The key must hold one of
        the following scopes, matched against the <code>channel</code> field in the request:
      </p>
      <ul>
        <li>
          <code>send:notification</code>: for <code>channel: &apos;notification&apos;</code>
        </li>
        <li>
          <code>send:transactional</code>: for <code>channel: &apos;transactional&apos;</code>{' '}
          (default)
        </li>
        <li>
          <code>send:internal</code>: for <code>channel: &apos;internal&apos;</code>
        </li>
      </ul>
      <p>
        The <code>send:new_recipients</code> scope is defined in the protocol but the new-recipient
        gate is not currently enforced. Sends to previously unseen recipients are not blocked.
      </p>

      <h2 id="request-body">Request body</h2>
      <p>
        Content type must be <code>application/json; charset=utf-8</code>. Maximum body size is 64
        KiB.
      </p>

      <ParamTable
        rows={[
          {
            name: 'to',
            type: 'string',
            required: true,
            description: (
              <>
                Recipient phone number. E.164 format is canonical (<code>+447700900123</code>), but
                the gateway normalises numbers with spaces, dashes, or parentheses. Alternatively, a
                WhatsApp group JID (<code>120363XXXXXXXXXXXX@g.us</code>) for a standalone group
                send, see <Link href="/docs/messages#group">Sending to a group</Link>. 6–40
                characters. Invalid numbers return <code>400 INVALID_PHONE</code>; malformed group
                JIDs also return <code>400 INVALID_PHONE</code>.
              </>
            ),
          },
          {
            name: 'purpose',
            type: 'enum',
            required: true,
            description: (
              <>
                Declares the intent of the message for compliance routing, retention, and audit. One
                of <code>otp</code>, <code>magic_link</code>, <code>transactional</code>,{' '}
                <code>notification</code>, <code>support</code>, <code>marketing</code>,{' '}
                <code>campaign</code>, <code>newsletter</code>, <code>announcement</code>, or{' '}
                <code>other</code>. No default; omitting returns <code>400 INVALID_BODY</code>.
              </>
            ),
          },
          {
            name: 'body',
            type: 'object',
            required: true,
            description: (
              <>
                The message content. A discriminated union on <code>kind</code>: <code>text</code>,{' '}
                <code>image</code>, or <code>document</code>. See{' '}
                <Link href="/docs/messages">Message body types</Link> for the full shape of each
                kind.
              </>
            ),
          },
          {
            name: 'channel',
            type: 'enum',
            required: false,
            default: "'transactional'",
            description: (
              <>
                Drives the scope check and throttle category. One of <code>notification</code>,{' '}
                <code>transactional</code>, or <code>internal</code>.
              </>
            ),
          },
          {
            name: 'idempotencyKey',
            type: 'string',
            required: false,
            description: (
              <>
                8–128 characters, any string. The pair <code>(apiKeyId, idempotencyKey)</code> is
                uniquely indexed. A first call with a given key returns <code>202</code>; a replay
                returns <code>200</code> with the original <code>messageId</code> and{' '}
                <code>idempotent: true</code>; no duplicate is created. Use a key tied to your
                domain object (order id, alert hash).
              </>
            ),
          },
          {
            name: 'ttlSeconds',
            type: 'integer',
            required: false,
            default: '1800',
            description: (
              <>
                How many seconds to wait before dropping the message if it is still queued. Minimum
                30, maximum 86 400 (24 hours). After expiry the message transitions to{' '}
                <code>expired</code>.
              </>
            ),
          },
          {
            name: 'replyTo',
            type: 'object',
            required: false,
            description: (
              <>
                Quote a prior outbound message. Shape: <code>{'{ "messageId": "<uuid>" }'}</code>.
                The referenced <code>messageId</code> must be the gateway UUID from a previous{' '}
                <code>POST /v1/messages</code> belonging to the same session. Unknown or
                cross-session ids return <code>404 RECIPIENT_NOT_FOUND</code>. Cannot be combined
                with <code>sendAt</code>.
              </>
            ),
          },
          {
            name: 'sendAt',
            type: 'string (ISO 8601)',
            required: false,
            description: (
              <>
                Schedule the send for a future time. Must be at least 30 seconds and at most 30 days
                in the future; otherwise returns <code>422 SEND_AT_PAST</code>. Cannot be combined
                with <code>confirm: true</code> or <code>replyTo</code>. See{' '}
                <Link href="/docs/scheduled-sends">Scheduled sends</Link>.
              </>
            ),
          },
          {
            name: 'confirm',
            type: 'boolean',
            required: false,
            default: 'false',
            description: (
              <>
                Wait synchronously for a terminal status before the HTTP response is returned.
                Returns <code>200</code> instead of <code>202</code>. Cannot be combined with{' '}
                <code>sendAt</code>. See <Link href="/docs/confirm">Synchronous confirm</Link>.
              </>
            ),
          },
          {
            name: 'confirmTimeoutMs',
            type: 'integer',
            required: false,
            default: '5000',
            description: (
              <>
                Maximum milliseconds to wait for the ack when <code>confirm: true</code>. Range:
                300–30 000. If the timeout elapses the response status is{' '}
                <code>&apos;queued&apos;</code>; the message may still arrive.
              </>
            ),
          },
        ]}
      />

      <Callout type="warning" title="Mutually exclusive combinations">
        <ul>
          <li>
            <code>sendAt</code> cannot be combined with <code>confirm: true</code>; returns{' '}
            <code>422 INVALID_BODY</code>.
          </li>
          <li>
            <code>sendAt</code> cannot be combined with <code>replyTo</code>; returns{' '}
            <code>422 INVALID_BODY</code>.
          </li>
        </ul>
      </Callout>

      <h2 id="request-example">Request example</h2>

      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl -X POST https://wa.example.com/v1/messages \\
  -H "Authorization: Bearer hmd_sk_developments_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+447700900123",
    "channel": "transactional",
    "purpose": "transactional",
    "body": {
      "kind": "text",
      "text": "Order #4711 confirmed."
    },
    "idempotencyKey": "order-4711-confirm-2026-01-15"
  }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+447700900123',
    channel: 'transactional',
    purpose: 'transactional',
    body: { kind: 'text', text: 'Order #4711 confirmed.' },
    idempotencyKey: 'order-4711-confirm-2026-01-15',
  }),
});

const data = await res.json();
console.log(data.messageId, data.status); // "8e8f3a26-…", "queued"`,
          },
        ]}
      />

      <h2 id="success-responses">Success responses</h2>

      <h3 id="202-async">202: Async (default)</h3>
      <p>
        Standard asynchronous send. The message is accepted and queued; delivery receipts follow via
        webhook.
      </p>

      <CodeBlock
        lang="json"
        title="202 response: queued"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "queued"
}`}
      />

      <h3 id="202-scheduled">202: Scheduled</h3>
      <p>
        Returned when <code>sendAt</code> is supplied. The message is parked until the scheduled
        time.
      </p>

      <CodeBlock
        lang="json"
        title="202 response: scheduled"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "scheduled",
  "scheduledFor": "2026-04-30T15:00:00.000Z"
}`}
      />

      <h3 id="200-idempotent-replay">200: Idempotent replay</h3>
      <p>
        When the same <code>idempotencyKey</code> is submitted again, the gateway returns the
        original result without creating a duplicate.
      </p>

      <CodeBlock
        lang="json"
        title="200 response: idempotent replay"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "queued",
  "idempotent": true,
  "requestId": "req_…"
}`}
      />

      <h3 id="200-confirm">200: Synchronous confirm</h3>
      <p>
        Returned when <code>confirm: true</code>. See{' '}
        <Link href="/docs/confirm">Synchronous confirm</Link> for the full semantics.
      </p>

      <CodeBlock
        lang="json"
        title="200 response: confirm mode (sent)"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "sent",
  "requestId": "req_…"
}`}
      />

      <CodeBlock
        lang="json"
        title="200 response: confirm mode (failed)"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "failed",
  "errorCode": "SEND_FAILED",
  "requestId": "req_…"
}`}
      />

      <CodeBlock
        lang="json"
        title="200 response: confirm mode (timeout)"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "queued",
  "requestId": "req_…"
}`}
      />

      <h2 id="status-codes">Status codes</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>200</td>
              <td>
                Synchronous confirm result, or idempotent replay of a prior successful request.
              </td>
            </tr>
            <tr>
              <td>202</td>
              <td>Message accepted and queued (or scheduled).</td>
            </tr>
            <tr>
              <td>400</td>
              <td>Malformed request: see error codes below.</td>
            </tr>
            <tr>
              <td>401</td>
              <td>Missing, malformed, revoked, or unrecognised bearer token.</td>
            </tr>
            <tr>
              <td>403</td>
              <td>Authenticated but forbidden: scope missing or IP not allowed.</td>
            </tr>
            <tr>
              <td>404</td>
              <td>
                Referenced resource not found: <code>replyTo</code> target.
              </td>
            </tr>
            <tr>
              <td>409</td>
              <td>Idempotency conflict (reserved).</td>
            </tr>
            <tr>
              <td>413</td>
              <td>Request body exceeded 64 KiB.</td>
            </tr>
            <tr>
              <td>415</td>
              <td>
                Content type was not <code>application/json</code>.
              </td>
            </tr>
            <tr>
              <td>422</td>
              <td>Business logic constraint violated: see error codes below.</td>
            </tr>
            <tr>
              <td>429</td>
              <td>Rate limited (global, per-key, per-IP, or per-recipient cap).</td>
            </tr>
            <tr>
              <td>500</td>
              <td>Unhandled server error; quote the requestId when reporting.</td>
            </tr>
            <tr>
              <td>503</td>
              <td>The bound session is not connected.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="error-codes">Error codes</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>INVALID_BODY</code>
              </td>
              <td>400 / 422</td>
              <td>
                JSON parse failure, schema violation, missing <code>purpose</code>, unsupported body
                type, or a forbidden field combination (<code>sendAt</code> with{' '}
                <code>confirm</code> or <code>replyTo</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>INVALID_PHONE</code>
              </td>
              <td>400</td>
              <td>
                <code>to</code> could not be normalised to E.164.
              </td>
            </tr>
            <tr>
              <td>
                <code>INVALID_CONTENT</code>
              </td>
              <td>400</td>
              <td>
                Reserved, not currently emitted. Intended for media URL SSRF or MIME failures.
              </td>
            </tr>
            <tr>
              <td>
                <code>UNAUTHORIZED</code>
              </td>
              <td>401</td>
              <td>Missing, malformed, revoked, or unrecognised bearer token.</td>
            </tr>
            <tr>
              <td>
                <code>SCOPE_DENIED</code>
              </td>
              <td>403</td>
              <td>
                Key lacks the required <code>send:*</code> scope for the chosen channel.
              </td>
            </tr>
            <tr>
              <td>
                <code>IP_NOT_ALLOWED</code>
              </td>
              <td>403</td>
              <td>Client IP is not in the key&apos;s CIDR allowlist.</td>
            </tr>
            <tr>
              <td>
                <code>RECIPIENT_NOT_FOUND</code>
              </td>
              <td>404</td>
              <td>
                <code>replyTo.messageId</code> target not found or belongs to a different session.
              </td>
            </tr>
            <tr>
              <td>
                <code>IDEMPOTENCY_CONFLICT</code>
              </td>
              <td>409</td>
              <td>Reserved for future multi-body replay detection.</td>
            </tr>
            <tr>
              <td>
                <code>PAYLOAD_TOO_LARGE</code>
              </td>
              <td>413</td>
              <td>Request body exceeded 64 KiB.</td>
            </tr>
            <tr>
              <td>
                <code>UNSUPPORTED_MEDIA_TYPE</code>
              </td>
              <td>415</td>
              <td>Reserved, not currently emitted. Content-type enforcement is not active.</td>
            </tr>
            <tr>
              <td>
                <code>SEND_AT_PAST</code>
              </td>
              <td>422</td>
              <td>
                <code>sendAt</code> is in the past, less than 30 seconds ahead, or more than 30 days
                away.
              </td>
            </tr>
            <tr>
              <td>
                <code>OPTED_OUT</code>
              </td>
              <td>422</td>
              <td>Recipient is on this session&apos;s opt-out registry.</td>
            </tr>
            <tr>
              <td>
                <code>RATE_LIMITED</code>
              </td>
              <td>429</td>
              <td>
                A rate-limit tier was exceeded (global, per-IP, or per-key), or the per-recipient
                cap was reached (5 sends per 10 minutes, global across all API keys).
              </td>
            </tr>
            <tr>
              <td>
                <code>NEW_RECIPIENT_BLOCKED</code>
              </td>
              <td>429</td>
              <td>Reserved, not currently emitted. The new-recipient gate has been removed.</td>
            </tr>
            <tr>
              <td>
                <code>VELOCITY_EXCEEDED</code>
              </td>
              <td>429</td>
              <td>
                Reserved, not currently emitted. The only active per-recipient mechanism is the
                5/10-min cap, which returns <code>RATE_LIMITED</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>WORKER_UNAVAILABLE</code>
              </td>
              <td>503</td>
              <td>The bound session is not connected (offline, pairing, or stopped).</td>
            </tr>
            <tr>
              <td>
                <code>INTERNAL</code>
              </td>
              <td>500</td>
              <td>Unhandled server error. Quote the requestId in support tickets.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="note" title="Error envelope shape">
        All non-2xx responses follow the flat shape{' '}
        <code>{'{ "error": "…", "code": "…", "requestId": "…" }'}</code>. Always match on{' '}
        <code>code</code>, not on <code>error</code>; the message text may change without notice.
      </Callout>
    </article>
  );
}
