import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Webhooks',
  description:
    'Receive delivery receipts, inbound messages, and opt-out events pushed to your server in real time.',
};

export default function WebhooksPage() {
  return (
    <article className="doc-prose">
      <h1>Webhooks</h1>
      <p className="doc-lead">
        Webhooks push events to an HTTPS URL you register, so your server is notified the moment a
        message is delivered, a contact replies, or a recipient opts out, without polling.
      </p>

      <h2 id="overview">Overview</h2>
      <p>
        Webhook endpoints are registered by an administrator in the gateway admin interface. At
        registration time you supply a publicly accessible HTTPS URL and receive a signing secret.
        The signing secret is shown once and must be stored securely; it is used to verify that
        deliveries genuinely originated from the gateway.
      </p>
      <p>
        The gateway delivers events by sending an HTTP <code>POST</code> request to your URL. The
        request body is a JSON object signed with the <code>X-HMD-Signature</code> header. Your
        endpoint must respond with a <code>2xx</code> status within 5 seconds.
      </p>

      <h2 id="event-categories">Event categories</h2>
      <p>The gateway emits events across four categories:</p>

      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-semibold">Category</th>
              <th className="px-4 py-2.5 font-semibold">Events</th>
              <th className="px-4 py-2.5 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">Message lifecycle</td>
              <td className="px-4 py-2.5">
                <code>message.queued</code>, <code>message.sent</code>,{' '}
                <code>message.delivered</code>, <code>message.read</code>,{' '}
                <code>message.failed</code>
              </td>
              <td className="px-4 py-2.5">Status transitions for outbound messages you sent.</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">Inbound</td>
              <td className="px-4 py-2.5">
                <code>inbound.received</code>, <code>inbound.reaction</code>
              </td>
              <td className="px-4 py-2.5">
                Messages and reactions sent to your session by contacts.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">Contact</td>
              <td className="px-4 py-2.5">
                <code>contact.opted_out</code>
              </td>
              <td className="px-4 py-2.5">A contact was added to the opt-out registry.</td>
            </tr>
            <tr>
              <td className="px-4 py-2.5">System</td>
              <td className="px-4 py-2.5">
                <code>webhook.test</code>
              </td>
              <td className="px-4 py-2.5">
                Synthetic test event sent from the admin interface. Acknowledge with{' '}
                <code>204</code> and take no further action.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="envelope">Common event envelope</h2>
      <p>Every event, regardless of type, shares the same top-level fields:</p>

      <ParamTable
        rows={[
          {
            name: 'type',
            type: 'string',
            required: true,
            description: (
              <>
                Event type discriminator. See{' '}
                <Link href="/docs/webhooks/events">Event payloads</Link> for the full list.
              </>
            ),
          },
          {
            name: 'at',
            type: 'string (ISO 8601)',
            required: true,
            description: 'UTC timestamp of when the event was emitted by the gateway.',
          },
          {
            name: 'eventId',
            type: 'string (UUID v4)',
            required: true,
            description:
              'Unique identifier for this event. Stable across all retry attempts. Use this for deduplication.',
          },
          {
            name: 'sessionId',
            type: 'string',
            required: true,
            description: 'Identifier of the session that produced the event.',
          },
        ]}
      />

      <CodeBlock
        lang="json"
        title="Example POST body: message.delivered"
        code={`{
  "type": "message.delivered",
  "at": "2026-06-24T14:30:47.200Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440003",
  "sessionId": "default",
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "waMessageId": "true_447700900123@c.us_ABCD1234..."
}`}
      />

      <h2 id="http-request">HTTP request format</h2>
      <p>
        Each delivery is a <code>POST</code> with the following headers:
      </p>

      <ParamTable
        rows={[
          {
            name: 'Content-Type',
            type: 'string',
            required: true,
            description: (
              <>
                Always <code>application/json</code>.
              </>
            ),
          },
          {
            name: 'X-HMD-Signature',
            type: 'string',
            required: true,
            description: (
              <>
                HMAC-SHA256 signature in the format{' '}
                <code>t=&lt;unix-seconds&gt;,v1=&lt;hex&gt;</code>. See{' '}
                <Link href="/docs/webhooks/verify">Verifying signatures</Link>.
              </>
            ),
          },
          {
            name: 'X-HMD-Event',
            type: 'string',
            required: true,
            description:
              'The event type (mirrors event.type). Useful for routing at the HTTP layer before parsing the body.',
          },
          {
            name: 'X-HMD-Delivery-Id',
            type: 'string (UUID)',
            required: true,
            description:
              'Unique per delivery attempt. Differs from eventId; the same event may produce multiple delivery attempts each with a distinct Delivery-Id.',
          },
        ]}
      />

      <h2 id="delivery-semantics">Delivery semantics</h2>

      <h3 id="at-least-once">At-least-once delivery</h3>
      <p>
        The gateway guarantees at-least-once delivery. An event may be delivered more than once, for
        example if your endpoint times out or returns a non-2xx status. Always deduplicate on{' '}
        <code>eventId</code> before processing.
      </p>

      <h3 id="idempotency">Idempotency</h3>
      <p>
        Store each <code>eventId</code> in a fast-access store (database unique index or cache) and
        skip reprocessing if you have seen it before. This protects against at-least-once retries
        and any transient network instability on your end.
      </p>

      <h3 id="retries">Retry schedule</h3>
      <p>
        If your endpoint does not respond with a <code>2xx</code> status within 5 seconds, the
        gateway schedules a retry. The delay between attempts (in seconds) is:
      </p>

      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-semibold">Attempt</th>
              <th className="px-4 py-2.5 font-semibold">Delay after previous attempt</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">1 (initial)</td>
              <td className="px-4 py-2.5">Immediate (synchronous)</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">2</td>
              <td className="px-4 py-2.5">30 seconds</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">3</td>
              <td className="px-4 py-2.5">2 minutes (120 s)</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">4</td>
              <td className="px-4 py-2.5">10 minutes (600 s)</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">5</td>
              <td className="px-4 py-2.5">1 hour (3,600 s)</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">6</td>
              <td className="px-4 py-2.5">6 hours (21,600 s)</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">7</td>
              <td className="px-4 py-2.5">24 hours (86,400 s)</td>
            </tr>
            <tr>
              <td className="px-4 py-2.5">After attempt 7</td>
              <td className="px-4 py-2.5">Event marked abandoned. No further attempts.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="ordering">Ordering</h3>
      <p>
        No strict ordering guarantee is made. A <code>message.read</code> event may arrive before
        the corresponding <code>message.delivered</code> event. Design your consumer to handle
        events arriving out of sequence.
      </p>

      <h2 id="response">Expected response</h2>
      <p>
        Respond with any <code>2xx</code> status within 5 seconds. A <code>204 No Content</code>{' '}
        with an empty body is recommended.
      </p>

      <Callout type="warning" title="Respond immediately; process in background">
        Accept the request and respond <code>204</code> as fast as possible. Move all business logic
        to a background queue. A response that exceeds 5 seconds is treated as a failure and
        retried, which can produce duplicate processing if your handler is not idempotent.
      </Callout>

      <h2 id="next-steps">Next steps</h2>
      <ul>
        <li>
          <Link href="/docs/webhooks/verify">Verifying signatures</Link>: exact scheme, replay
          window, and verification code in TypeScript and Python.
        </li>
        <li>
          <Link href="/docs/webhooks/events">Event payloads</Link>: full field reference and JSON
          examples for all 9 event types.
        </li>
        <li>
          <Link href="/docs/opt-outs">Opt-outs</Link>: what happens after a{' '}
          <code>contact.opted_out</code> event and how to manage the registry.
        </li>
      </ul>
    </article>
  );
}
