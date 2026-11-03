import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Event payloads',
  description:
    'Field reference and JSON examples for every webhook event type emitted by the HMD WA Gateway.',
};

export default function WebhookEventsPage() {
  return (
    <article className="doc-prose">
      <h1>Event payloads</h1>
      <p className="doc-lead">
        The gateway emits nine event types. Each event carries a common envelope plus type-specific
        fields documented below. Retry attempts carry the same <code>eventId</code>; deduplicate on
        it before processing.
      </p>

      <p>
        All events share the common envelope described in the{' '}
        <Link href="/docs/webhooks">Webhooks overview</Link>: <code>type</code>, <code>at</code>,{' '}
        <code>eventId</code>, and <code>sessionId</code>. Only type-specific fields are listed under
        each event below.
      </p>

      <Callout type="tip" title="Handle unknown event types gracefully">
        New event types may be added in future releases. Your handler must include a default case
        that acknowledges the request with <code>204</code> rather than erroring on unrecognised
        types.
      </Callout>

      <Callout type="note" title="Inbound content.type vs outbound body.kind">
        Inbound messages use a <code>content.type</code> discriminator (values: <code>text</code>,{' '}
        <code>image</code>, <code>document</code>). Outbound messages use a <code>body.kind</code>{' '}
        discriminator (values: <code>text</code>, <code>image</code>, <code>document</code>). These
        are distinct fields; do not conflate them.
      </Callout>

      <h2 id="event-type-enum">Event type enum</h2>
      <CodeBlock
        lang="typescript"
        title="All 9 webhook event types"
        code={`type WebhookEventType =
  | 'message.queued'      // outbound accepted and enqueued
  | 'message.sent'        // dispatched to the messaging network
  | 'message.delivered'   // recipient device received it
  | 'message.read'        // recipient opened it
  | 'message.failed'      // terminal failure
  | 'inbound.received'    // contact sent a message to your session
  | 'inbound.reaction'    // contact reacted to a message
  | 'contact.opted_out'   // contact added to opt-out registry
  | 'webhook.test';       // synthetic test event from admin interface`}
      />

      <h2 id="retry-schedule">Retry schedule</h2>
      <p>
        If your endpoint does not respond with a <code>2xx</code> status within 5 seconds, the
        gateway retries at the following delays (cumulative from the initial attempt): 30 s, 2 min,
        10 min, 1 h, 6 h, 24 h. After the seventh attempt (sixth retry) the event is marked
        abandoned. See <Link href="/docs/webhooks">Webhooks overview</Link> for the delivery table.
      </p>

      <h2 id="message-lifecycle">Message lifecycle events</h2>
      <p>
        These five events track an outbound message from acceptance through to terminal state. They
        all include <code>messageId</code> (the gateway UUID from <code>POST /v1/messages</code>).
      </p>

      <h3 id="message-queued">message.queued</h3>
      <p>
        Fired when the gateway has accepted the send request and enqueued the message for dispatch.
      </p>

      <CodeBlock
        lang="json"
        title="message.queued"
        code={`{
  "type": "message.queued",
  "at": "2026-06-24T14:30:45.123Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440001",
  "sessionId": "default",
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "to": "+447700900123",
  "category": "transactional"
}`}
      />

      <ParamTable
        rows={[
          {
            name: 'messageId',
            type: 'string (UUID)',
            required: true,
            description: 'Gateway-issued message identifier.',
          },
          {
            name: 'to',
            type: 'string (E.164)',
            required: true,
            description: "Recipient's phone number.",
          },
          {
            name: 'category',
            type: "'notification' | 'transactional' | 'internal'",
            required: true,
            description:
              'Message category. Corresponds to the channel field supplied at send time.',
          },
        ]}
      />

      <h3 id="message-sent">message.sent</h3>
      <p>
        Fired when the message has been successfully handed off to the messaging network. A
        network-issued identifier is now available.
      </p>

      <CodeBlock
        lang="json"
        title="message.sent"
        code={`{
  "type": "message.sent",
  "at": "2026-06-24T14:30:46.500Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440002",
  "sessionId": "default",
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "waMessageId": "true_447700900123@c.us_ABCD1234..."
}`}
      />

      <ParamTable
        rows={[
          {
            name: 'messageId',
            type: 'string (UUID)',
            required: true,
            description: 'Gateway-issued message identifier.',
          },
          {
            name: 'waMessageId',
            type: 'string',
            required: true,
            description:
              'Network-issued message identifier. Can be used as a reply-to or reaction target on peer messages.',
          },
        ]}
      />

      <h3 id="message-delivered">message.delivered</h3>
      <p>
        Fired when the recipient device has received the message (equivalent to two grey checkmarks
        in a standard client).
      </p>

      <CodeBlock
        lang="json"
        title="message.delivered"
        code={`{
  "type": "message.delivered",
  "at": "2026-06-24T14:30:47.200Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440003",
  "sessionId": "default",
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "waMessageId": "true_447700900123@c.us_ABCD1234..."
}`}
      />

      <p>
        Carries the same fields as <code>message.sent</code>.
      </p>

      <h3 id="message-read">message.read</h3>
      <p>
        Fired when the recipient has opened and read the message (equivalent to two blue
        checkmarks). Only emitted when the recipient has read receipts enabled on their account.
      </p>

      <CodeBlock
        lang="json"
        title="message.read"
        code={`{
  "type": "message.read",
  "at": "2026-06-24T14:30:48.100Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440004",
  "sessionId": "default",
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "waMessageId": "true_447700900123@c.us_ABCD1234..."
}`}
      />

      <p>
        Carries the same fields as <code>message.sent</code>.
      </p>

      <h3 id="message-failed">message.failed</h3>
      <p>
        Fired when the message has reached a terminal failure state. No further send attempts will
        be made. The <code>status</code> field may be <code>failed</code> (dispatch rejected) or{' '}
        <code>expired</code> (TTL elapsed before dispatch).
      </p>

      <CodeBlock
        lang="json"
        title="message.failed"
        code={`{
  "type": "message.failed",
  "at": "2026-06-24T14:30:50.000Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440005",
  "sessionId": "default",
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "failed",
  "error": {
    "code": "OPTED_OUT",
    "message": "Recipient has opted out",
    "retryable": false
  }
}`}
      />

      <ParamTable
        rows={[
          {
            name: 'messageId',
            type: 'string (UUID)',
            required: true,
            description: 'Gateway-issued message identifier.',
          },
          {
            name: 'status',
            type: "'failed' | 'expired'",
            required: true,
            description: (
              <>
                <code>failed</code> when dispatch was rejected; <code>expired</code> when the
                message TTL elapsed before it could be sent.
              </>
            ),
          },
          {
            name: 'error.code',
            type: 'string',
            required: true,
            description: (
              <>
                Machine-readable error code. See <Link href="/docs/errors">Errors</Link> for the
                full catalogue.
              </>
            ),
          },
          {
            name: 'error.message',
            type: 'string',
            required: true,
            description:
              'Human-readable error description. Do not match on this string; use error.code.',
          },
          {
            name: 'error.retryable',
            type: 'boolean',
            required: true,
            description:
              'Whether retrying the send would likely succeed. False for permanent failures such as opt-outs or invalid phone numbers.',
          },
        ]}
      />

      <Callout type="note" title="Opted-out contacts">
        When <code>error.code</code> is <code>OPTED_OUT</code>, the contact has been added to the
        opt-out registry. Future send attempts to the same number will return{' '}
        <code>422 OPTED_OUT</code> until an administrator removes the entry. See{' '}
        <Link href="/docs/opt-outs">Opt-outs</Link>.
      </Callout>

      <h2 id="inbound-events">Inbound events</h2>

      <h3 id="inbound-received">inbound.received</h3>
      <p>
        Fired when a contact sends a message to your session. The <code>content</code> field is a
        discriminated union on <code>content.type</code>. Note that inbound content uses{' '}
        <code>content.type</code> (not <code>body.kind</code>, which is the outbound discriminator).
      </p>

      <CodeBlock
        lang="json"
        title="inbound.received: text"
        code={`{
  "type": "inbound.received",
  "at": "2026-06-24T14:35:10.500Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440006",
  "sessionId": "default",
  "waMessageId": "false_447700900124@c.us_ABCD5678...",
  "from": "+447700900124",
  "content": {
    "type": "text",
    "text": "Hello, I need help with my order."
  }
}`}
      />

      <CodeBlock
        lang="json"
        title="inbound.received: image"
        code={`{
  "type": "inbound.received",
  "at": "2026-06-24T14:35:22.100Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440010",
  "sessionId": "default",
  "waMessageId": "false_447700900124@c.us_EFGH9012...",
  "from": "+447700900124",
  "content": {
    "type": "image",
    "mediaUrl": "https://media-bucket.example.com/image123.jpg",
    "mediaMimeType": "image/jpeg",
    "caption": "Photo of the damaged item"
  }
}`}
      />

      <CodeBlock
        lang="json"
        title="inbound.received: document"
        code={`{
  "type": "inbound.received",
  "at": "2026-06-24T14:35:35.300Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440011",
  "sessionId": "default",
  "waMessageId": "false_447700900124@c.us_IJKL3456...",
  "from": "+447700900124",
  "content": {
    "type": "document",
    "mediaUrl": "https://media-bucket.example.com/receipt.pdf",
    "mediaFileName": "receipt.pdf",
    "mediaMimeType": "application/pdf",
    "caption": "Invoice #1234"
  }
}`}
      />

      <ParamTable
        rows={[
          {
            name: 'waMessageId',
            type: 'string',
            required: true,
            description: 'Network-issued identifier for the inbound message.',
          },
          {
            name: 'from',
            type: 'string (E.164)',
            required: true,
            description: "Sender's phone number.",
          },
          {
            name: 'content.type',
            type: "'text' | 'image' | 'document'",
            required: true,
            description:
              'Content variant discriminator. Distinct from the outbound body.kind field.',
          },
          {
            name: 'content.text',
            type: 'string',
            description: (
              <>
                Message text. Present only when <code>content.type</code> is{' '}
                <code>&quot;text&quot;</code>.
              </>
            ),
          },
          {
            name: 'content.mediaUrl',
            type: 'string (URL)',
            description:
              'Media download URL. Present for image and document variants. Valid for up to 3 days.',
          },
          {
            name: 'content.mediaMimeType',
            type: 'string',
            description: 'MIME type of the media. Present for image and document variants.',
          },
          {
            name: 'content.mediaFileName',
            type: 'string',
            description: 'Original filename. Present for the document variant only.',
          },
          {
            name: 'content.caption',
            type: 'string (optional)',
            description: 'Optional caption text. Present for image and document variants.',
          },
        ]}
      />

      <h3 id="inbound-reaction">inbound.reaction</h3>
      <p>
        Fired when a contact reacts to a message with an emoji. An empty <code>emoji</code> string
        indicates the reaction was cleared by the contact.
      </p>

      <CodeBlock
        lang="json"
        title="inbound.reaction: emoji set"
        code={`{
  "type": "inbound.reaction",
  "at": "2026-06-24T14:36:05.200Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440007",
  "sessionId": "default",
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "waMessageId": "true_447700900123@c.us_ABCD1234...",
  "targetFromMe": true,
  "from": "+447700900124",
  "emoji": "👍"
}`}
      />

      <CodeBlock
        lang="json"
        title="inbound.reaction: emoji cleared"
        code={`{
  "type": "inbound.reaction",
  "at": "2026-06-24T14:36:20.000Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440013",
  "sessionId": "default",
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "waMessageId": "true_447700900123@c.us_ABCD1234...",
  "targetFromMe": true,
  "from": "+447700900124",
  "emoji": ""
}`}
      />

      <ParamTable
        rows={[
          {
            name: 'messageId',
            type: 'string (UUID) or null',
            description:
              'Gateway-issued identifier of the message being reacted to. Present only when the target message was sent by this session. Null for reactions to messages authored by other contacts.',
          },
          {
            name: 'waMessageId',
            type: 'string',
            required: true,
            description: 'Network-issued identifier of the message being reacted to.',
          },
          {
            name: 'targetFromMe',
            type: 'boolean',
            required: true,
            description: 'True when the reacted-to message was authored by this session.',
          },
          {
            name: 'from',
            type: 'string (E.164)',
            required: true,
            description: 'Phone number of the contact who reacted.',
          },
          {
            name: 'emoji',
            type: 'string',
            required: true,
            description:
              'The emoji reaction (1–8 characters), or an empty string if the reaction was cleared.',
          },
        ]}
      />

      <h2 id="contact-events">Contact events</h2>

      <h3 id="contact-opted-out">contact.opted_out</h3>
      <p>
        Fired when a contact is added to the opt-out registry, either because they sent a recognised
        opt-out keyword (such as &ldquo;STOP&rdquo;) or because an administrator added them
        manually. After this event, any send to the same number returns <code>422 OPTED_OUT</code>.
      </p>

      <CodeBlock
        lang="json"
        title="contact.opted_out: keyword"
        code={`{
  "type": "contact.opted_out",
  "at": "2026-06-24T14:37:15.000Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440008",
  "sessionId": "default",
  "phone": "+447700900125",
  "source": "keyword",
  "keyword": "STOP"
}`}
      />

      <CodeBlock
        lang="json"
        title="contact.opted_out: admin-initiated"
        code={`{
  "type": "contact.opted_out",
  "at": "2026-06-24T14:37:30.000Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440012",
  "sessionId": "default",
  "phone": "+447700900125",
  "source": "admin"
}`}
      />

      <ParamTable
        rows={[
          {
            name: 'phone',
            type: 'string (E.164)',
            required: true,
            description: 'Phone number of the contact who opted out.',
          },
          {
            name: 'source',
            type: "'keyword' | 'admin'",
            required: true,
            description:
              '"keyword" when the contact sent a recognised opt-out keyword; "admin" when added manually via the admin interface.',
          },
          {
            name: 'keyword',
            type: 'string (optional)',
            description:
              'The matched opt-out keyword (e.g. "STOP"). Present only when source is "keyword".',
          },
        ]}
      />

      <p>
        See <Link href="/docs/opt-outs">Opt-outs</Link> for how to manage the opt-out registry and
        handle re-subscription.
      </p>

      <h2 id="system-events">System events</h2>

      <h3 id="webhook-test">webhook.test</h3>
      <p>
        A synthetic test event sent by the admin interface when you trigger a test delivery for a
        webhook endpoint. Treat it as a no-op; your consumer should acknowledge it with{' '}
        <code>204</code> and take no further action.
      </p>

      <CodeBlock
        lang="json"
        title="webhook.test"
        code={`{
  "type": "webhook.test",
  "at": "2026-06-24T14:38:00.000Z",
  "eventId": "550e8400-e29b-41d4-a716-446655440009",
  "sessionId": "default",
  "message": "This is a test webhook from HMD WA Gateway."
}`}
      />

      <ParamTable
        rows={[
          {
            name: 'message',
            type: 'string',
            required: true,
            description: (
              <>
                Literal string: <code>This is a test webhook from HMD WA Gateway.</code>
              </>
            ),
          },
        ]}
      />

      <h2 id="related">Related</h2>
      <ul>
        <li>
          <Link href="/docs/webhooks">Webhooks overview</Link>: delivery semantics, retry schedule,
          and response expectations.
        </li>
        <li>
          <Link href="/docs/webhooks/verify">Verifying signatures</Link>: how to validate the{' '}
          <code>X-HMD-Signature</code> header.
        </li>
        <li>
          <Link href="/docs/opt-outs">Opt-outs</Link>: managing the opt-out registry after a{' '}
          <code>contact.opted_out</code> event.
        </li>
        <li>
          <Link href="/docs/concepts">Core concepts</Link>: the full message lifecycle and state
          machine.
        </li>
      </ul>
    </article>
  );
}
