import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';
import { Endpoint } from '@/components/docs/endpoint';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Get a message',
  description:
    'Retrieve the full record for a single outbound message, including status history and timestamps, using GET /v1/messages/:messageId.',
};

export default function GetMessagePage() {
  return (
    <article className="doc-prose">
      <h1>Get a message</h1>
      <p className="doc-lead">
        Retrieve the full record for a single outbound message: current status, complete
        chronological status history with timestamps, body kind, TTL information, and any error code
        from a failure.
      </p>

      <Endpoint method="GET" path="/v1/messages/:messageId" />

      <h2 id="authentication">Authentication and scope</h2>
      <p>
        Requires a Bearer API key in the <code>Authorization</code> header. No additional scope is
        required. The message must have been created by the calling API key itself (not merely the
        same session; a different key bound to the same session cannot see it); any other{' '}
        <code>messageId</code> (including one that exists but belongs to a different key) returns{' '}
        <code>404 INVALID_BODY</code>. See <Link href="/docs/authentication">Authentication</Link>{' '}
        for key format and bearer usage.
      </p>

      <h2 id="path-params">Path parameters</h2>
      <ParamTable
        rows={[
          {
            name: 'messageId',
            type: 'string (UUID)',
            required: true,
            description:
              'The gateway UUID returned by POST /v1/messages when the message was created.',
          },
        ]}
      />

      <h2 id="response-shape">Response shape</h2>
      <p>
        Returns <code>200 OK</code> with the full message record.
      </p>

      <CodeBlock
        lang="json"
        title="200 OK: delivered message"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "to": "+447700900123",
  "channel": "transactional",
  "purpose": "otp",
  "status": "delivered",
  "statusHistory": [
    {
      "status": "queued",
      "at": "2026-06-24T12:34:56.000Z"
    },
    {
      "status": "sent",
      "at": "2026-06-24T12:34:57.120Z"
    },
    {
      "status": "delivered",
      "at": "2026-06-24T12:34:59.480Z"
    }
  ],
  "createdAt": "2026-06-24T12:34:56.000Z",
  "ttlExpiresAt": "2026-06-24T13:04:56.000Z",
  "errorCode": null,
  "body": { "kind": "text" }
}`}
      />

      <CodeBlock
        lang="json"
        title="200 OK: failed message"
        code={`{
  "messageId": "3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f",
  "to": "+447700900456",
  "channel": "transactional",
  "purpose": "transactional",
  "status": "failed",
  "statusHistory": [
    {
      "status": "queued",
      "at": "2026-06-24T13:00:00.000Z"
    },
    {
      "status": "failed",
      "at": "2026-06-24T13:00:01.500Z",
      "code": "OPTED_OUT",
      "detail": "Recipient has opted out"
    }
  ],
  "createdAt": "2026-06-24T13:00:00.000Z",
  "ttlExpiresAt": "2026-06-24T13:30:00.000Z",
  "errorCode": "OPTED_OUT",
  "body": { "kind": "text" }
}`}
      />

      <h2 id="response-fields">Response fields</h2>
      <ParamTable
        rows={[
          {
            name: 'messageId',
            type: 'string (UUID)',
            description: 'Unique gateway identifier for this message.',
          },
          {
            name: 'to',
            type: 'string (E.164)',
            description: 'Recipient phone number.',
          },
          {
            name: 'channel',
            type: 'enum',
            description: (
              <>
                One of <code>notification</code>, <code>transactional</code>, or{' '}
                <code>internal</code>.
              </>
            ),
          },
          {
            name: 'purpose',
            type: 'enum',
            description: (
              <>
                The send purpose supplied at creation. One of <code>otp</code>,{' '}
                <code>magic_link</code>, <code>transactional</code>, <code>notification</code>,{' '}
                <code>support</code>, <code>marketing</code>, <code>campaign</code>,{' '}
                <code>newsletter</code>, <code>announcement</code>, or <code>other</code>.
              </>
            ),
          },
          {
            name: 'status',
            type: 'enum',
            description: (
              <>
                Current lifecycle status. One of <code>queued</code>, <code>scheduled</code>,{' '}
                <code>sent</code>, <code>delivered</code>, <code>read</code>, <code>failed</code>,
                or <code>expired</code>. See status values below.
              </>
            ),
          },
          {
            name: 'statusHistory',
            type: 'array',
            description:
              'Chronological list of all status transitions this message has passed through. Each entry has the fields below.',
          },
          {
            name: 'statusHistory[].status',
            type: 'enum',
            description: 'The status reached at this transition.',
          },
          {
            name: 'statusHistory[].at',
            type: 'string (ISO 8601)',
            description: 'UTC timestamp of when this status was reached.',
          },
          {
            name: 'statusHistory[].code',
            type: 'string (optional)',
            description: (
              <>
                Machine-readable error code. Present only when <code>status</code> is{' '}
                <code>failed</code>. See <Link href="/docs/errors">Error codes reference</Link>.
              </>
            ),
          },
          {
            name: 'statusHistory[].detail',
            type: 'string (optional)',
            description: (
              <>
                Human-readable failure detail. Present only when <code>status</code> is{' '}
                <code>failed</code>. Do not match on this string; use <code>code</code>.
              </>
            ),
          },
          {
            name: 'createdAt',
            type: 'string (ISO 8601)',
            description: 'When the message was first accepted by the gateway.',
          },
          {
            name: 'ttlExpiresAt',
            type: 'string (ISO 8601)',
            description:
              'Deadline after which an undelivered, still-queued message is marked expired. Derived from the ttlSeconds supplied at creation (default 30 minutes).',
          },
          {
            name: 'errorCode',
            type: 'string or null',
            description: (
              <>
                Set when <code>status</code> is <code>failed</code>. Mirrors the <code>code</code>{' '}
                from the final <code>statusHistory</code> entry. See{' '}
                <Link href="/docs/errors">Error codes reference</Link> for possible values.
                <code>null</code> when the message has not failed.
              </>
            ),
          },
          {
            name: 'body',
            type: 'object',
            description: (
              <>
                Summary of the message body. Contains <code>kind</code> only (<code>text</code>,{' '}
                <code>image</code>, or <code>document</code>). Full content is not returned.
              </>
            ),
          },
        ]}
      />

      <h2 id="status-values">Status values</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
              <th>Terminal?</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>queued</code>
              </td>
              <td>Accepted and waiting for dispatch.</td>
              <td>No</td>
            </tr>
            <tr>
              <td>
                <code>scheduled</code>
              </td>
              <td>
                Parked for a future dispatch time (only when <code>sendAt</code> was supplied).
              </td>
              <td>No</td>
            </tr>
            <tr>
              <td>
                <code>sent</code>
              </td>
              <td>Dispatched to the messaging network; delivery receipts pending.</td>
              <td>No</td>
            </tr>
            <tr>
              <td>
                <code>delivered</code>
              </td>
              <td>Recipient&apos;s device received the message (two grey checkmarks).</td>
              <td>No</td>
            </tr>
            <tr>
              <td>
                <code>read</code>
              </td>
              <td>
                Recipient opened the message (two blue checkmarks). Only emitted when the recipient
                has read receipts enabled.
              </td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>
                <code>failed</code>
              </td>
              <td>
                Dispatch failed permanently. <code>errorCode</code> is set. No further attempts will
                be made.
              </td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>
                <code>expired</code>
              </td>
              <td>Message TTL elapsed while still queued. Not dispatched.</td>
              <td>Yes</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="example">Example</h2>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl https://wa.example.com/v1/messages/8e8f3a26-0c47-4f3e-85cd-123456789abc \\
  -H "Authorization: Bearer hmd_sk_developments_live_…"`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const messageId = '8e8f3a26-0c47-4f3e-85cd-123456789abc';

const res = await fetch(
  \`https://wa.example.com/v1/messages/\${messageId}\`,
  {
    headers: {
      Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    },
  },
);

if (!res.ok) {
  const err = await res.json();
  throw new Error(err.code); // e.g. 'INVALID_BODY' for not found
}

const msg = await res.json();
console.log(msg.status, msg.statusHistory);`,
          },
        ]}
      />

      <h2 id="status-codes">Status codes</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Code</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>200</td>
              <td></td>
              <td>Success. Returns the full message record.</td>
            </tr>
            <tr>
              <td>401</td>
              <td>
                <code>UNAUTHORIZED</code>
              </td>
              <td>Missing or invalid bearer token.</td>
            </tr>
            <tr>
              <td>403</td>
              <td>
                <code>IP_NOT_ALLOWED</code>
              </td>
              <td>Client IP not in the key&apos;s CIDR allowlist.</td>
            </tr>
            <tr>
              <td>404</td>
              <td>
                <code>INVALID_BODY</code>
              </td>
              <td>
                Message not found or belongs to a different API key. The gateway does not
                distinguish between these two cases.
              </td>
            </tr>
            <tr>
              <td>429</td>
              <td>
                <code>RATE_LIMITED</code>
              </td>
              <td>
                Rate limit exceeded. See <Link href="/docs/rate-limits">Rate limits</Link>.
              </td>
            </tr>
            <tr>
              <td>500</td>
              <td>
                <code>INTERNAL</code>
              </td>
              <td>
                Unhandled server error. Quote the <code>requestId</code> in support tickets.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="warning" title="Foreign messageId returns 404">
        The gateway deliberately does not distinguish between a genuinely absent message and one
        owned by a different API key. Both cases return <code>404 INVALID_BODY</code> to prevent
        enumeration.
      </Callout>

      <CodeBlock
        lang="json"
        title="404 Not found"
        code={`{
  "error": "Not found",
  "code": "INVALID_BODY",
  "requestId": "req_01hvz…"
}`}
      />

      <p>
        See the <Link href="/docs/errors">Error codes reference</Link> for the full catalogue.
      </p>
    </article>
  );
}
