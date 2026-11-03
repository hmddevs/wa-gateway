import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'Opt-outs',
  description:
    'How contact opt-outs work, what the OPTED_OUT error means, and your compliance obligations.',
};

export default function OptOutsPage() {
  return (
    <article className="doc-prose">
      <h1>Opt-outs</h1>
      <p className="doc-lead">
        A contact can opt out of messages at any time. Once opted out, all send attempts to that
        contact return <code>422 OPTED_OUT</code> and nothing is enqueued. Respect opt-outs
        immediately; do not retry.
      </p>

      <h2 id="how-opt-out-works">How opt-out works</h2>
      <p>A contact enters the opt-out registry in one of two ways:</p>
      <ul>
        <li>
          <strong>Inbound STOP keyword.</strong> When a contact replies with <code>STOP</code> (case
          insensitive), the gateway records the opt-out automatically.
        </li>
        <li>
          <strong>Admin action.</strong> An administrator can manually add a contact to the opt-out
          registry through the admin console.
        </li>
      </ul>

      <p>
        Opt-out records are <strong>persistent</strong> and stored per session: the registry is
        keyed on the pair <code>(sessionId, phone)</code>. For a key bound to a single session,
        opting out on that session has no effect on any other session.
      </p>
      <p>
        For a key bound to an <strong>organization</strong> (several numbers behind one key),
        enforcement is organization-wide: if the contact has opted out on <em>any</em> of its
        numbers, sends are blocked regardless of which number is routed for delivery. This prevents
        a failover to a different number from bypassing an existing opt-out.
      </p>

      <h2 id="opted-out-error">The OPTED_OUT error</h2>
      <p>
        Any <code>POST /v1/messages</code> call where the recipient is opted out returns{' '}
        <code>422</code> immediately. The message is <strong>not</strong> inserted or enqueued:
      </p>

      <CodeBlock
        lang="json"
        title="422 OPTED_OUT"
        code={`{
  "error": "Recipient has opted out",
  "code": "OPTED_OUT",
  "requestId": "req_01hx7rk9p3fq4m8n5j6t2w0v1b"
}`}
      />

      <h2 id="webhook-event">Opt-out webhook event</h2>
      <p>
        When a contact opts out (via STOP keyword), the gateway fires a{' '}
        <code>contact.opted_out</code> webhook event to all active webhook routes for the session.
        Subscribe to this event to keep your own contact database in sync without polling.
      </p>
      <p>
        See <Link href="/docs/webhooks/events">Event payloads</Link> for the full{' '}
        <code>contact.opted_out</code> payload shape.
      </p>

      <h2 id="compliance">Compliance obligations</h2>
      <Callout type="security" title="Honour opt-outs: do not retry">
        Regulations such as GDPR require you to honour an opt-out and cease messaging immediately.
        When you receive <code>OPTED_OUT</code>, remove or flag the contact in your own system. Do
        not change the phone number format or use a different session to circumvent the registry.
      </Callout>

      <p>
        Practical steps after receiving <code>OPTED_OUT</code>:
      </p>
      <ol>
        <li>
          <strong>Do not retry the send.</strong> The contact has explicitly refused further
          messages.
        </li>
        <li>
          <strong>Update your records.</strong> Mark the contact as opted out in your CRM or
          database so future send attempts are suppressed before they reach the API.
        </li>
        <li>
          <strong>Log for audit.</strong> Retain a record of when the opt-out was received, keyed by
          phone number and your internal contact ID.
        </li>
      </ol>

      <Callout type="note" title="Opt-out is not reversible via the API">
        There is no consumer API endpoint to remove a contact from the opt-out registry. Reversals
        must be processed by an administrator. Contact{' '}
        <a href="mailto:security@hmddevs.org">security@hmddevs.org</a> if a contact wishes to
        re-subscribe and has provided fresh consent.
      </Callout>
    </article>
  );
}
