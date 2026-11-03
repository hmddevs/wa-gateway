import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'Quickstart',
  description: 'Send your first WhatsApp message via the HMD WA Gateway in a few minutes.',
};

export default function QuickstartPage() {
  return (
    <article className="doc-prose">
      <h1>Quickstart</h1>
      <p className="doc-lead">
        Send your first WhatsApp message in a few minutes. You will need an API key, a recipient
        phone number in E.164 format, and any HTTP client.
      </p>

      <h2 id="step-1-get-an-api-key">Step 1. Get an API key</h2>
      <p>
        Access to the HMD WA Gateway is invite-only. Keys are issued by the HMD administrator; there
        is no self-service signup.
      </p>
      <p>
        Email{' '}
        <a href="mailto:security@hmddevs.org?subject=WA%20Gateway%20API%20key%20request">
          security@hmddevs.org
        </a>{' '}
        with your project name, intended use, expected message volume, and any source IP addresses
        you want allowlisted. The full checklist is on the{' '}
        <Link href="/docs/api-keys">Get an API key</Link> page.
      </p>
      <p>Once issued, your key looks like this:</p>
      <CodeBlock
        code="hmd_sk_<division>_<env>_<43-character-secret>"
        lang="bash"
        title="API key format"
      />
      <p>
        Store it in an environment variable. Never commit it to source control or expose it in
        client-side code.
      </p>

      <h2 id="step-2-send-your-first-message">Step 2. Send your first message</h2>
      <p>
        The send endpoint is <code>POST /v1/messages</code>. Every request must carry your API key
        in the <code>Authorization</code> header, a <code>to</code> phone number in E.164 format
        (e.g. <code>+447700900123</code>), a <code>purpose</code> classifying the message intent,
        and a <code>body</code> describing the content.
      </p>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl -X POST https://wa.example.com/v1/messages \\
  -H "Authorization: Bearer \${HMD_WA_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+447700900123",
    "purpose": "transactional",
    "body": { "kind": "text", "text": "Your order #4711 has been confirmed." }
  }'`,
          },
          {
            label: 'JavaScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+447700900123',
    purpose: 'transactional',
    body: { kind: 'text', text: 'Your order #4711 has been confirmed.' },
  }),
});

const data = await res.json();
console.log(data.messageId, data.status);
// → "8e8f3a26-0c47-4f3e-85cd-123456789abc", "queued"`,
          },
        ]}
      />

      <h2 id="step-3-read-the-response">Step 3. Read the response</h2>
      <p>
        A successful async send returns <code>202 Accepted</code> with a <code>messageId</code> and
        an initial <code>status</code> of <code>queued</code>. The message has been accepted and
        will be delivered; you do not need to poll.
      </p>
      <CodeBlock
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "queued"
}`}
        lang="json"
        title="202 response"
      />
      <p>
        Keep the <code>messageId</code>: you can use it to look up delivery status later, quote it
        in a reply, or add a reaction. The response also includes an <code>X-Request-Id</code>{' '}
        header, which you should capture and include in any support requests.
      </p>
      <p>
        The <code>send:new_recipients</code> scope exists in the protocol, but the new-recipient
        gate it was intended for is not currently enforced: sends to a recipient your session has
        never messaged before succeed regardless of whether the key holds that scope.
      </p>

      <h2 id="step-4-check-session-status">Step 4. Check the session status</h2>
      <p>
        If your API key has the <code>read:status</code> scope, you can query whether the session is
        connected before sending. This is useful for health checks and operational dashboards.
      </p>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl https://wa.example.com/v1/worker/status \\
  -H "Authorization: Bearer \${HMD_WA_API_KEY}"`,
          },
        ]}
      />
      <p>
        Only <code>connected</code> accepts new sends. Any other state returns{' '}
        <code>503 WORKER_UNAVAILABLE</code> on a send attempt. See the{' '}
        <Link href="/docs/endpoints/status">Session status</Link> reference for the full list of
        state values.
      </p>

      <Callout type="tip" title="Need synchronous confirmation?">
        If you need to know whether the message actually reached WhatsApp before deciding to fall
        back to email or SMS, pass <code>&quot;confirm&quot;: true</code> in the request body. The
        gateway waits for a terminal acknowledgement and returns{' '}
        <code>status: &quot;sent&quot;</code>, <code>&quot;failed&quot;</code>, or{' '}
        <code>&quot;queued&quot;</code> (timeout). See{' '}
        <Link href="/docs/confirm">Synchronous confirm</Link>.
      </Callout>

      <h2 id="next-steps">Next steps</h2>
      <ul>
        <li>
          <Link href="/docs/concepts">Core concepts</Link>: understand keys, sessions, purpose, and
          idempotency before building further.
        </li>
        <li>
          <Link href="/docs/webhooks">Webhooks</Link>: receive delivery receipts, inbound messages,
          and opt-out events.
        </li>
        <li>
          <Link href="/docs/errors">Errors</Link>: the complete error code catalogue.
        </li>
      </ul>
    </article>
  );
}
