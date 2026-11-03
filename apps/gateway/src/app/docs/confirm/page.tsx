import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { CodeSample } from '@/components/docs/code-sample';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Synchronous confirm',
  description:
    'Use confirm:true to receive a terminal send status inline before deciding whether to fall back to another channel.',
};

export default function SynchronousConfirmPage() {
  return (
    <article className="doc-prose">
      <h1>Synchronous confirm</h1>
      <p className="doc-lead">
        Pass <code>confirm: true</code> on a send request to wait for a terminal delivery
        acknowledgement before the HTTP response returns. This lets you fall back to email or SMS in
        the same request cycle when a WhatsApp send does not land.
      </p>

      <h2 id="how-it-works">How it works</h2>
      <p>
        By default <code>POST /v1/messages</code> is asynchronous: it accepts the message, returns{' '}
        <code>202 queued</code>, and delivers receipts later via webhook. Synchronous confirm
        changes this:
      </p>
      <ol>
        <li>The gateway subscribes to a per-message confirmation channel before dispatching.</li>
        <li>The message is dispatched to the bound session.</li>
        <li>
          The gateway waits up to <code>confirmTimeoutMs</code> milliseconds for an acknowledgement.
        </li>
        <li>
          The response is <strong>200</strong> (not 202) with a terminal <code>status</code> field.
        </li>
      </ol>

      <Callout type="note" title="HTTP 200, not 202">
        Confirm mode always returns <strong>200 OK</strong> regardless of the outcome. The outcome
        is communicated through the <code>status</code> field in the response body, not the HTTP
        status code. A <code>status</code> of <code>queued</code> means the timeout elapsed, not
        that the message was rejected.
      </Callout>

      <h2 id="parameters">Parameters</h2>

      <ParamTable
        rows={[
          {
            name: 'confirm',
            type: 'boolean',
            required: false,
            default: 'false',
            description: (
              <>
                Set to <code>true</code> to opt into synchronous confirm mode. Cannot be combined
                with <code>sendAt</code>; that combination returns <code>422 INVALID_BODY</code>.{' '}
                <code>replyTo</code> is supported alongside <code>confirm: true</code>.
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
                Maximum milliseconds to wait for the acknowledgement. Range: 300–30 000. If the
                timeout elapses the response carries <code>status: &apos;queued&apos;</code>; the
                message is still enqueued and may arrive later.
              </>
            ),
          },
        ]}
      />

      <h2 id="incompatible-fields">Incompatible fields</h2>
      <p>
        <code>confirm: true</code> cannot be combined with <code>sendAt</code>: scheduling a message
        for a future time and waiting synchronously for its ack in the same request is incoherent.
        Returns <code>422 INVALID_BODY</code>.
      </p>
      <p>
        <code>replyTo</code> has no such restriction: quoting a prior message works normally
        alongside <code>confirm: true</code>.
      </p>
      <p>
        To poll the outcome of a scheduled send, use <code>GET /v1/messages/:messageId</code> after
        the scheduled time. See <Link href="/docs/scheduled-sends">Scheduled sends</Link>.
      </p>

      <h2 id="response-outcomes">The three outcomes</h2>
      <p>
        The HTTP status is always <code>200</code>. The <code>status</code> field in the response
        body carries one of three values:
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>status</th>
              <th>Meaning</th>
              <th>Recommended action</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>sent</code>
              </td>
              <td>
                The message reached WhatsApp. Delivery receipts (<code>delivered</code>,{' '}
                <code>read</code>) will follow via webhook.
              </td>
              <td>Success. No fallback needed.</td>
            </tr>
            <tr>
              <td>
                <code>failed</code>
              </td>
              <td>
                The send failed. <code>errorCode</code> is populated. No further webhook will fire
                for this message.
              </td>
              <td>Trigger your fallback channel immediately.</td>
            </tr>
            <tr>
              <td>
                <code>queued</code>
              </td>
              <td>
                The gateway timed out waiting for the acknowledgement. The message is still enqueued
                and <strong>may still arrive</strong> on WhatsApp after the response returns.
              </td>
              <td>
                If you trigger a fallback, design your copy to tolerate a duplicate delivery, or
                poll <code>GET /v1/messages/:messageId</code> before triggering it.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="warning" title="queued does not mean failed">
        A <code>queued</code> status in confirm mode means the gateway did not receive an
        acknowledgement within <code>confirmTimeoutMs</code>. The message is still in the queue and
        may still land on WhatsApp. If you trigger an email fallback, design your copy so that a
        duplicate delivery is not harmful.
      </Callout>

      <h2 id="response-shapes">Response shapes</h2>

      <CodeBlock
        lang="json"
        title="200: sent"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "sent",
  "requestId": "req_…"
}`}
      />

      <CodeBlock
        lang="json"
        title="200: failed"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "failed",
  "errorCode": "SEND_FAILED",
  "requestId": "req_…"
}`}
      />

      <CodeBlock
        lang="json"
        title="200: queued (timeout elapsed)"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "queued",
  "requestId": "req_…"
}`}
      />

      <h2 id="idempotent-replay-with-confirm">Idempotent replay with confirm</h2>
      <p>
        When <code>confirm: true</code> is set and an <code>idempotencyKey</code> replay finds a
        prior message:
      </p>
      <ul>
        <li>
          <strong>Terminal status</strong> (<code>sent</code>, <code>delivered</code>,{' '}
          <code>read</code>, <code>failed</code>, <code>expired</code>): the gateway returns
          immediately with the mapped status and <code>idempotent: true</code>. No republish occurs.{' '}
          <code>delivered</code> and <code>read</code> map to <code>sent</code>;{' '}
          <code>expired</code> maps to <code>failed</code> with{' '}
          <code>errorCode: &apos;EXPIRED&apos;</code>.
        </li>
        <li>
          <strong>
            <code>queued</code>
          </strong>
          : the original send has not yet been acknowledged by the worker, so the gateway subscribes
          to the acknowledgement channel without republishing, races against{' '}
          <code>confirmTimeoutMs</code>, and returns the result with <code>idempotent: true</code>.
        </li>
        <li>
          <strong>
            <code>scheduled</code>
          </strong>
          : no worker ack will arrive until the scheduled cron fires, so the gateway does not wait
          at all. It returns immediately with <code>status: &apos;queued&apos;</code> and{' '}
          <code>idempotent: true</code>, so the caller can fall back straight away rather than block
          for no reason.
        </li>
      </ul>

      <h2 id="when-to-use">When to use</h2>
      <p>Synchronous confirm is best suited to:</p>
      <ul>
        <li>
          <strong>Auth-critical flows:</strong> OTPs, magic links, password resets, where a missed
          delivery must trigger an immediate fallback.
        </li>
        <li>
          <strong>Payment confirmations:</strong> where you need to know the message landed before
          moving to the next step.
        </li>
      </ul>
      <p>
        For bulk or many-recipient sends, use the default async path and receive receipts via
        webhook. Holding an HTTP connection open per message does not scale and is unnecessary when
        real-time confirmation is not required.
      </p>

      <h2 id="worked-example">Worked example: OTP with email fallback</h2>
      <p>
        This pattern sends an OTP via WhatsApp and falls back to email if the send does not confirm
        within 8 seconds.
      </p>

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
    "purpose": "otp",
    "body": { "kind": "text", "text": "Your code: 482913" },
    "idempotencyKey": "otp-user-123-2026-01-15T14:30:00Z",
    "confirm": true,
    "confirmTimeoutMs": 8000
  }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `async function sendOtp(userId: string, phone: string, code: string) {
  const idempotencyKey = \`otp-\${userId}-\${new Date().toISOString()}\`;

  const res = await fetch('https://wa.example.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: phone,
      channel: 'transactional',
      purpose: 'otp',
      body: { kind: 'text', text: \`Your code: \${code}\` },
      idempotencyKey,
      confirm: true,
      confirmTimeoutMs: 8000,
    }),
  });

  const data = await res.json();

  if (data.status === 'sent') {
    return { channel: 'whatsapp' };
  }

  // status is 'failed' or 'queued' (timeout); fall back to email
  await sendOtpEmail(userId, code);
  return { channel: 'email' };
}`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

def send_otp(user_id: str, phone: str, code: str) -> dict:
    idempotency_key = f"otp-{user_id}-2026-01-15T14:30:00Z"

    res = requests.post(
        "https://wa.example.com/v1/messages",
        headers={
            "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
            "Content-Type": "application/json",
        },
        json={
            "to": phone,
            "channel": "transactional",
            "purpose": "otp",
            "body": {"kind": "text", "text": f"Your code: {code}"},
            "idempotencyKey": idempotency_key,
            "confirm": True,
            "confirmTimeoutMs": 8000,
        },
    )
    data = res.json()

    if data["status"] == "sent":
        return {"channel": "whatsapp"}

    # status is 'failed' or 'queued' (timeout); fall back to email
    send_otp_email(user_id, code)
    return {"channel": "email"}`,
          },
        ]}
      />

      <Callout type="note" title="Incompatible with sendAt">
        <code>confirm: true</code> cannot be combined with <code>sendAt</code>. That combination
        returns <code>422 INVALID_BODY</code>. See{' '}
        <Link href="/docs/endpoints/send">Send a message</Link> for the full field reference.
      </Callout>
    </article>
  );
}
