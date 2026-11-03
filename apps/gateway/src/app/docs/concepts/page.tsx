import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Core concepts',
  description:
    'The mental model behind the HMD WA Gateway: keys, sessions, purpose, idempotency, message lifecycle, and phone format.',
};

export default function ConceptsPage() {
  return (
    <article className="doc-prose">
      <h1>Core concepts</h1>
      <p className="doc-lead">
        Before building an integration, it helps to understand how the gateway models identity,
        routing, and delivery. This page covers the foundational concepts you will encounter on
        every API call.
      </p>

      <h2 id="api-key-session-project">API key, session, and project</h2>
      <p>An API key is not just a credential; it carries a complete routing context:</p>
      <ul>
        <li>
          <strong>Session</strong>: every key is bound to a single WhatsApp phone number. All
          messages sent through the key go out from that number. You cannot choose a different
          session per message.
        </li>
        <li>
          <strong>Project</strong>: every key is stamped with a <code>projectId</code> slug at
          issuance (see below). This slug is immutable and groups all your messages for audit,
          billing, and reporting.
        </li>
        <li>
          <strong>Scopes</strong>: the key carries a set of permissions that gate which operations
          you may perform. See <Link href="/docs/authentication">Authentication</Link> for the
          complete scope list.
        </li>
      </ul>
      <p>
        This means two keys can point to different phone numbers, belong to different projects, and
        carry different permissions, even for the same consumer application.
      </p>

      <h2 id="project-id">Project ID</h2>
      <p>
        Every API key is stamped with a <code>projectId</code> slug at issuance. This slug follows
        the pattern <code>[a-z0-9-]</code>, 1 to 64 characters (for example{' '}
        <code>acme-notifications</code>).
      </p>
      <p>
        You{' '}
        <strong>
          never pass <code>projectId</code> in a request
        </strong>
        . The gateway reads it from the authenticated key and persists it automatically on every
        message you send. It drives:
      </p>
      <ul>
        <li>Multi-tenant audit grouping (all messages for a project are queryable together)</li>
        <li>Billing roll-ups</li>
        <li>Downstream routing for features such as inbound reply agents</li>
      </ul>
      <p>
        The <code>projectId</code> is immutable once issued. If you need a new project grouping,
        request a new key from the administrator.
      </p>

      <h2 id="purpose">The purpose field</h2>
      <p>
        Every send request requires a <code>purpose</code> field. This is a required enum with no
        default; omitting it returns <code>400 INVALID_BODY</code>.
      </p>
      <CodeBlock
        code={`{
  "to": "+447700900123",
  "purpose": "otp",
  "body": { "kind": "text", "text": "Your code is 482913. It expires in 10 minutes." }
}`}
        lang="json"
        title="purpose field in a send request"
      />
      <ParamTable
        rows={[
          {
            name: 'otp',
            type: 'purpose',
            description:
              'One-time code. Short TTL, single-use. For login codes, verification codes, and similar flows.',
          },
          {
            name: 'magic_link',
            type: 'purpose',
            description: 'Passwordless sign-in link or token.',
          },
          {
            name: 'transactional',
            type: 'purpose',
            description: 'Order updates, receipts, confirmations, and account alerts. Non-urgent.',
          },
          {
            name: 'notification',
            type: 'purpose',
            description: 'State changes, reminders, and informational messages. Non-urgent.',
          },
          {
            name: 'support',
            type: 'purpose',
            description: 'Human-to-customer replies in a live support context.',
          },
          {
            name: 'marketing',
            type: 'purpose',
            description: 'Promotional content. Requires recipient opt-in.',
          },
          {
            name: 'campaign',
            type: 'purpose',
            description: 'A specific promotional or outreach campaign send.',
          },
          {
            name: 'newsletter',
            type: 'purpose',
            description: 'Recurring digest or bulletin content.',
          },
          {
            name: 'announcement',
            type: 'purpose',
            description: 'One-off broadcast, e.g. a service update or policy change.',
          },
          {
            name: 'other',
            type: 'purpose',
            description: 'Anything that does not fit the categories above.',
          },
        ]}
      />
      <p>
        <code>purpose</code> is distinct from <code>channel</code>: the <code>channel</code> field
        (values: <code>notification</code>, <code>transactional</code>, <code>internal</code>)
        controls which scope your key needs and how the gateway prioritises delivery. The{' '}
        <code>purpose</code> field records your intent for compliance routing, retention policy, and
        audit categorisation. Both can be set independently; a common pairing is{' '}
        <code>channel: &apos;transactional&apos;</code> with <code>purpose: &apos;otp&apos;</code>.
      </p>
      <p>
        A third term, <strong>category</strong>, appears in the <code>message.queued</code> webhook
        payload. It echoes the resolved <code>channel</code> of the send (e.g.{' '}
        <code>&apos;transactional&apos;</code>). It is not a separate concept: <code>category</code>{' '}
        in webhooks is the channel label, carried through to the event so consumers can route
        without re-fetching the message. See <Link href="/docs/scopes">Scopes</Link> for the full
        channel-to-scope mapping.
      </p>

      <Callout type="note" title="Always supply purpose">
        There is no default. Omitting <code>purpose</code> returns <code>400 INVALID_BODY</code>.
        Pick the value that most accurately describes the message; it affects how the gateway
        categorises the message for audit and data-retention purposes.
      </Callout>

      <h2 id="message-lifecycle">Message lifecycle</h2>
      <p>
        After a successful send, a message moves through a series of statuses. You can observe them
        by polling <Link href="/docs/endpoints/get">GET /v1/messages/:messageId</Link> or by
        listening to <Link href="/docs/webhooks">webhook events</Link>.
      </p>
      <ParamTable
        rows={[
          {
            name: 'queued',
            type: 'status',
            description:
              'The message has been accepted by the gateway and is waiting for the session to pick it up.',
          },
          {
            name: 'scheduled',
            type: 'status',
            description: (
              <>
                The message is parked for a future dispatch time because <code>sendAt</code> was
                supplied. It will transition to <code>queued</code> when the scheduled time arrives.
              </>
            ),
          },
          {
            name: 'sent',
            type: 'status',
            description:
              'The session has sent the message to WhatsApp. Delivery receipts are pending.',
          },
          {
            name: 'delivered',
            type: 'status',
            description: "WhatsApp delivered the message to the recipient's device.",
          },
          {
            name: 'read',
            type: 'status',
            description: 'The recipient opened the message in WhatsApp.',
          },
          {
            name: 'failed',
            type: 'status',
            description:
              'The session failed to send the message. An errorCode is set on the message record.',
          },
          {
            name: 'expired',
            type: 'status',
            description: (
              <>
                The message TTL elapsed while the message was still <code>queued</code>. The default
                TTL is 30 minutes; the maximum is 24 hours. Set <code>ttlSeconds</code> on the send
                request to override.
              </>
            ),
          },
        ]}
      />
      <p>
        The typical happy-path progression is: <code>queued</code> &rarr; <code>sent</code> &rarr;{' '}
        <code>delivered</code> &rarr; <code>read</code>. Each transition is recorded in the{' '}
        <code>statusHistory</code> array on the message detail response.
      </p>

      <h2 id="phone-format">Phone number format</h2>
      <p>
        All phone numbers use <strong>E.164</strong> (the ITU-T international numbering format): a{' '}
        <code>+</code> followed by a country code and subscriber number, 1 to 15 digits in total,
        with no spaces, dashes, or parentheses. For example: <code>+447700900123</code>.
      </p>
      <p>
        The gateway is lenient on input; it normalises formats like <code>447700900123</code>,{' '}
        <code>(0)7700 900123</code>, and similar representations to E.164 automatically. The
        canonical stored form is always E.164. Numbers that cannot be normalised return{' '}
        <code>400 INVALID_PHONE</code>.
      </p>

      <h2 id="idempotency">Idempotency</h2>
      <p>
        The gateway supports optional idempotency keys on <code>POST /v1/messages</code>. Pass an{' '}
        <code>idempotencyKey</code> string, 8 to 128 characters, in the request body. If you resend
        the same <code>(apiKeyId, idempotencyKey)</code> pair within the window, the gateway returns
        the original response with <code>idempotent: true</code> rather than creating a duplicate
        message.
      </p>
      <p>
        This makes it safe to retry failed or timed-out HTTP calls without double-delivering. Send
        the same <code>idempotencyKey</code> on every retry of the same logical request.
      </p>
      <p>
        For full details, including the window duration and replay semantics in confirm mode, see{' '}
        <Link href="/docs/idempotency">Idempotency</Link>.
      </p>

      <h2 id="opt-outs">Opt-outs</h2>
      <p>
        A recipient may opt out of messages from a session by sending an inbound <code>STOP</code>{' '}
        message or through an administrator action. Once opted out, any send to that phone number
        from that session returns <code>422 OPTED_OUT</code> and the message is not enqueued.
      </p>
      <p>
        For a standalone session, opt-out is session-specific; it does not affect messages from
        other sessions. For an API key bound to an organization, opt-out is enforced
        organization-wide instead: a recipient who opts out on any of its numbers is blocked across
        all of them, so routing the next message via a different number cannot bypass the opt-out.
        Respect opt-outs and do not retry; retrying is a compliance violation. See{' '}
        <Link href="/docs/opt-outs">Opt-outs</Link> for the full behaviour reference.
      </p>
    </article>
  );
}
