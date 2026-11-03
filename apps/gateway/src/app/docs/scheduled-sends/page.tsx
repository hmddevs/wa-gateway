import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { CodeSample } from '@/components/docs/code-sample';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Scheduled sends',
  description: 'Use sendAt to schedule a WhatsApp message for a future time, up to 30 days ahead.',
};

export default function ScheduledSendsPage() {
  return (
    <article className="doc-prose">
      <h1>Scheduled sends</h1>
      <p className="doc-lead">
        Supply a <code>sendAt</code> datetime to park a message for future delivery. The gateway
        persists it immediately and dispatches it automatically when the scheduled time arrives.
      </p>

      <h2 id="how-it-works">How it works</h2>
      <p>
        When <code>sendAt</code> is present, the message is stored with{' '}
        <code>status: &apos;scheduled&apos;</code> instead of being dispatched immediately. A
        per-minute process picks up messages whose scheduled time has passed and dispatches them
        asynchronously. The response is <strong>202 Accepted</strong> with{' '}
        <code>status: &apos;scheduled&apos;</code> and a <code>scheduledFor</code> field confirming
        the stored time.
      </p>
      <p>
        You can observe the transition from <code>scheduled</code> to <code>queued</code> (and
        onwards to <code>sent</code>, <code>delivered</code>, or <code>read</code>) by polling{' '}
        <code>GET /v1/messages/:messageId</code>.
      </p>

      <h2 id="the-sendat-field">The sendAt field</h2>

      <ParamTable
        rows={[
          {
            name: 'sendAt',
            type: 'string (ISO 8601)',
            required: false,
            description: (
              <>
                A future datetime in ISO 8601 format with timezone information, for example{' '}
                <code>2026-04-30T15:00:00.000Z</code> or <code>2026-04-30T16:00:00+01:00</code>. The
                gateway normalises all times to UTC internally. Must be at least 30 seconds and at
                most 30 days in the future; values outside this window return{' '}
                <code>422 SEND_AT_PAST</code>. Cannot be combined with <code>confirm: true</code> or{' '}
                <code>replyTo</code>.
              </>
            ),
          },
        ]}
      />

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Constraint</th>
              <th>Value</th>
              <th>Error on violation</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Minimum lead time</td>
              <td>30 seconds in the future</td>
              <td>
                <code>422 SEND_AT_PAST</code>
              </td>
            </tr>
            <tr>
              <td>Maximum lead time</td>
              <td>30 days in the future</td>
              <td>
                <code>422 SEND_AT_PAST</code>
              </td>
            </tr>
            <tr>
              <td>
                Combined with <code>replyTo</code>
              </td>
              <td>Not allowed</td>
              <td>
                <code>422 INVALID_BODY</code>
              </td>
            </tr>
            <tr>
              <td>
                Combined with <code>confirm: true</code>
              </td>
              <td>Not allowed</td>
              <td>
                <code>422 INVALID_BODY</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="note" title="Dispatch granularity">
        Scheduled messages are picked up by a per-minute process, so the actual dispatch time may be
        up to one minute after the <code>sendAt</code> value. Plan accordingly for time-sensitive
        sends.
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
    "channel": "notification",
    "purpose": "notification",
    "body": {
      "kind": "text",
      "text": "Reminder: your appointment is tomorrow at 10:00."
    },
    "sendAt": "2026-04-30T09:00:00.000Z",
    "idempotencyKey": "appt-reminder-user-123-2026-04-30"
  }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const scheduledFor = new Date(appointmentDate);
scheduledFor.setDate(scheduledFor.getDate() - 1);
scheduledFor.setHours(9, 0, 0, 0);

const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+447700900123',
    channel: 'notification',
    purpose: 'notification',
    body: {
      kind: 'text',
      text: 'Reminder: your appointment is tomorrow at 10:00.',
    },
    sendAt: scheduledFor.toISOString(),
    idempotencyKey: \`appt-reminder-user-123-\${scheduledFor.toISOString()}\`,
  }),
});

const data = await res.json();
console.log(data.status);       // "scheduled"
console.log(data.scheduledFor); // "2026-04-30T09:00:00.000Z"`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os
from datetime import datetime, timedelta, timezone
import requests

appointment_date = datetime(2026, 5, 1, 10, 0, 0, tzinfo=timezone.utc)
scheduled_for = appointment_date - timedelta(days=1)
scheduled_for = scheduled_for.replace(hour=9, minute=0, second=0, microsecond=0)

res = requests.post(
    "https://wa.example.com/v1/messages",
    headers={
        "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "to": "+447700900123",
        "channel": "notification",
        "purpose": "notification",
        "body": {
            "kind": "text",
            "text": "Reminder: your appointment is tomorrow at 10:00.",
        },
        "sendAt": scheduled_for.isoformat(),
        "idempotencyKey": f"appt-reminder-user-123-{scheduled_for.date()}",
    },
)
data = res.json()
print(data["status"])        # "scheduled"
print(data["scheduledFor"])  # "2026-04-30T09:00:00+00:00"`,
          },
        ]}
      />

      <h2 id="success-response">Success response</h2>

      <CodeBlock
        lang="json"
        title="202 response: scheduled"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "scheduled",
  "scheduledFor": "2026-04-30T09:00:00.000Z"
}`}
      />

      <h2 id="polling-status">Polling status</h2>
      <p>
        Use <code>GET /v1/messages/:messageId</code> to observe when the message transitions from{' '}
        <code>scheduled</code> to <code>queued</code> and then to a terminal status. The{' '}
        <code>statusHistory</code> array on that response records every transition with a timestamp.
      </p>

      <h2 id="error-codes">Relevant error codes</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>When it occurs</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>SEND_AT_PAST</code>
              </td>
              <td>422</td>
              <td>
                <code>sendAt</code> is in the past, less than 30 seconds in the future, or more than
                30 days in the future.
              </td>
            </tr>
            <tr>
              <td>
                <code>INVALID_BODY</code>
              </td>
              <td>422</td>
              <td>
                <code>sendAt</code> is combined with <code>replyTo</code> or{' '}
                <code>confirm: true</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>WORKER_UNAVAILABLE</code>
              </td>
              <td>503</td>
              <td>
                The bound session is not registered with the gateway. The session must exist even
                for scheduled sends.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="tip" title="Use idempotency keys on scheduled sends">
        Pair <code>sendAt</code> with an <code>idempotencyKey</code> tied to the domain object
        (appointment id, reminder id). Retrying a failed HTTP call will replay the original
        scheduled message rather than creating a duplicate.
      </Callout>

      <p>
        For the full field reference, see <Link href="/docs/endpoints/send">Send a message</Link>.
      </p>
    </article>
  );
}
