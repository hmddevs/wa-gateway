import type { Metadata } from 'next';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'Idempotency',
  description: 'Use idempotency keys to retry sends safely without creating duplicate messages.',
};

export default function IdempotencyPage() {
  return (
    <article className="doc-prose">
      <h1>Idempotency</h1>
      <p className="doc-lead">
        Supply an <code>idempotencyKey</code> in your send request and the gateway guarantees that
        retrying the same call never delivers the message twice, no matter how many times you send
        it. The deduplication window is the message TTL (default 30 minutes, maximum 24 hours). A
        retry that arrives <em>after</em> the window has closed creates a new message, so for OTP
        retries always use a key that is stable within the OTP&apos;s own TTL.
      </p>

      <h2 id="how-it-works">How it works</h2>
      <p>
        The gateway deduplicates on the pair <code>(apiKeyId, idempotencyKey)</code>. Within the
        deduplication window:
      </p>
      <ul>
        <li>
          <strong>First call</strong> with a given key: the message is created and the gateway
          returns <code>202</code>.
        </li>
        <li>
          <strong>Any subsequent call</strong> with the same key: the original{' '}
          <code>messageId</code> is returned immediately with <code>idempotent: true</code> and
          status <code>200</code>. No new message is created.
        </li>
      </ul>

      <h2 id="the-key-field">The idempotencyKey field</h2>
      <p>
        Pass the key as the <code>idempotencyKey</code> field in the <code>POST /v1/messages</code>{' '}
        request body. There is no separate header.
      </p>

      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-semibold">Property</th>
              <th className="px-4 py-2.5 font-semibold">Value</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">Location</td>
              <td className="px-4 py-2.5">
                <code>idempotencyKey</code> field in the request body
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">Format</td>
              <td className="px-4 py-2.5">
                8–128 characters. No character-set restriction beyond length; any string in range is
                accepted.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">Deduplication scope</td>
              <td className="px-4 py-2.5">
                <code>(apiKeyId, idempotencyKey)</code>
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5">Window</td>
              <td className="px-4 py-2.5">Message TTL (default 30 minutes, maximum 24 hours)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="first-call-vs-replay">First call vs. replay</h2>

      <h3 id="first-call">First call</h3>
      <p>
        The message is new. The gateway inserts it, queues it for delivery, and returns{' '}
        <code>202</code>:
      </p>
      <CodeBlock
        lang="json"
        title="202: first call"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "queued"
}`}
      />

      <h3 id="replay">Replay (same key)</h3>
      <p>
        The key already exists. The gateway returns <code>200</code> with the original{' '}
        <code>messageId</code> and <code>idempotent: true</code>. Nothing is re-enqueued:
      </p>
      <CodeBlock
        lang="json"
        title="200: idempotent replay"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "queued",
  "idempotent": true,
  "requestId": "req_01hx7rk9p3fq4m8n5j6t2w0v1b"
}`}
      />

      <h2 id="example">Example: first call and retry</h2>

      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `# First call
curl -X POST https://wa.example.com/v1/messages \\
  -H "Authorization: Bearer $HMD_WA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+447700900123",
    "channel": "transactional",
    "purpose": "otp",
    "body": { "kind": "text", "text": "Your code is 482913." },
    "idempotencyKey": "otp_user_42_2026_06_24T10_00_00Z"
  }'

# Exact same request retried after a network timeout; no duplicate is created
curl -X POST https://wa.example.com/v1/messages \\
  -H "Authorization: Bearer $HMD_WA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+447700900123",
    "channel": "transactional",
    "purpose": "otp",
    "body": { "kind": "text", "text": "Your code is 482913." },
    "idempotencyKey": "otp_user_42_2026_06_24T10_00_00Z"
  }'`,
          },
          {
            label: 'JavaScript',
            lang: 'typescript',
            code: `const key = \`otp_user_\${userId}_\${new Date().toISOString()}\`;

// Safe to call in a retry loop; only one message is ever sent
const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+447700900123',
    channel: 'transactional',
    purpose: 'otp',
    body: { kind: 'text', text: 'Your code is 482913.' },
    idempotencyKey: key,
  }),
});

const data = await res.json();
console.log(data.messageId, data.idempotent);`,
          },
        ]}
      />

      <h2 id="idempotency-conflict">IDEMPOTENCY_CONFLICT</h2>
      <p>
        The gateway reserves <code>409 IDEMPOTENCY_CONFLICT</code> for a future case where a replay
        supplies a different request body than the original. This is not yet enforced.
      </p>

      <h2 id="best-practices">Best practices</h2>
      <Callout type="tip" title="Use a stable key tied to your domain object">
        Derive the key from something that is stable across retries: an order ID, an alert hash, a
        user ID plus a time bucket. A random UUID generated per attempt defeats the purpose. A
        stable UUID generated once and stored alongside the triggering event is the right pattern.
      </Callout>

      <ul>
        <li>
          <strong>One key per logical send.</strong> If you genuinely want two separate messages to
          the same recipient, use two distinct keys.
        </li>
        <li>
          <strong>Check the response code.</strong> A <code>200</code> with{' '}
          <code>idempotent: true</code> means the message was already in flight; its status is in
          the <code>status</code> field.
        </li>
        <li>
          <strong>The window is the message TTL.</strong> Once a message expires (default 30
          minutes), its key is no longer active. Retrying after that window creates a new message.
        </li>
      </ul>
    </article>
  );
}
