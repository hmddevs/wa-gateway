import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';
import { Endpoint } from '@/components/docs/endpoint';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Session status',
  description:
    'Check the live connection status of the WhatsApp session bound to your API key using GET /v1/worker/status.',
};

export default function SessionStatusPage() {
  return (
    <article className="doc-prose">
      <h1>Session status</h1>
      <p className="doc-lead">
        Returns the live connection status of the WhatsApp session bound to your API key: whether
        the session is reachable, the connected phone number, the last healthy timestamp, and the
        current send queue depth.
      </p>

      <Callout type="tip" title="Check before high-stakes sends">
        For auth-critical flows such as OTP or payment confirmation, call this endpoint first. If{' '}
        <code>status</code> is not <code>connected</code>, consider falling back to an alternative
        channel before dispatching.
      </Callout>

      <Endpoint method="GET" path="/v1/worker/status" />

      <h2 id="authentication">Authentication and scope</h2>
      <p>
        Requires a Bearer API key with the <code>read:status</code> scope. Keys without this scope
        return <code>403 SCOPE_DENIED</code>. See{' '}
        <Link href="/docs/authentication">Authentication</Link> for key format and scope details.
      </p>

      <h2 id="response-shape">Response shape</h2>
      <p>
        Returns <code>200 OK</code> on success. <code>workerId</code>, <code>status</code>,{' '}
        <code>lastHeartbeatAt</code>, <code>connectedAt</code>, <code>phoneE164</code>,{' '}
        <code>version</code>, and <code>queueDepth</code> are always present; fields with no known
        value are returned as <code>null</code> rather than omitted. <code>sessionId</code> is
        present only when the calling API key is bound to a session.
      </p>

      <CodeBlock
        lang="json"
        title="200 OK: session connected"
        code={`{
  "workerId": "wrk_primary",
  "sessionId": "default",
  "status": "connected",
  "lastHeartbeatAt": "2026-06-24T09:30:00.000Z",
  "connectedAt": "2026-06-24T08:00:00.000Z",
  "phoneE164": "+447700900100",
  "version": "1.4.2",
  "queueDepth": 0
}`}
      />

      <CodeBlock
        lang="json"
        title="200 OK: session offline"
        code={`{
  "workerId": "wrk_primary",
  "sessionId": "default",
  "status": "offline",
  "lastHeartbeatAt": "2026-06-24T07:45:00.000Z",
  "connectedAt": null,
  "phoneE164": null,
  "version": null,
  "queueDepth": null
}`}
      />

      <h2 id="response-fields">Response fields</h2>
      <ParamTable
        rows={[
          {
            name: 'workerId',
            type: 'string',
            description:
              'Identifier of the worker process serving this session, or the key’s legacy bound worker when the key predates per-session binding.',
          },
          {
            name: 'sessionId',
            type: 'string (optional)',
            description:
              'The session identifier bound to your API key. Present only when the calling key is bound to a session.',
          },
          {
            name: 'status',
            type: 'enum',
            description: (
              <>
                Effective session status. One of <code>initialising</code>, <code>pairing</code>,{' '}
                <code>connected</code>, <code>degraded</code>, <code>offline</code>, or{' '}
                <code>stopped</code>. Reported as <code>offline</code> whenever the last heartbeat
                is older than 60 seconds, regardless of the underlying stored status. See
                interpreting status below.
              </>
            ),
          },
          {
            name: 'lastHeartbeatAt',
            type: 'string (ISO 8601) or null',
            description:
              'Time of the last worker heartbeat. Null if the session has never been observed healthy.',
          },
          {
            name: 'connectedAt',
            type: 'string (ISO 8601) or null',
            description:
              'Time the current connection was established. Null when the session is not connected.',
          },
          {
            name: 'phoneE164',
            type: 'string (E.164) or null',
            description:
              'The WhatsApp phone number paired to the session. Null when the session is not connected.',
          },
          {
            name: 'version',
            type: 'string or null',
            description: 'Worker build version, or null when unknown.',
          },
          {
            name: 'queueDepth',
            type: 'integer or null',
            description: (
              <>
                Number of sends currently pending for this session. Null when unknown. A non-zero
                value whilst <code>status</code> is <code>offline</code> indicates queued messages
                that will drain once the session reconnects.
              </>
            ),
          },
        ]}
      />

      <h2 id="interpreting-status">Interpreting the status field</h2>
      <p>
        Only <code>connected</code> accepts an immediate (non-scheduled) send. Every other status
        returns <code>503 WORKER_UNAVAILABLE</code> for a non-scheduled{' '}
        <code>POST /v1/messages</code>; a scheduled send (<code>sendAt</code> supplied) is still
        accepted and parked for the cron regardless of the current status.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
              <th>Immediate sends accepted?</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>initialising</code>
              </td>
              <td>Worker is starting up the session; session data is still being loaded.</td>
              <td>
                No &mdash; <code>503 WORKER_UNAVAILABLE</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>pairing</code>
              </td>
              <td>Session is waiting for a QR code or pairing code to be scanned.</td>
              <td>
                No &mdash; <code>503 WORKER_UNAVAILABLE</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>connected</code>
              </td>
              <td>Session is authenticated and healthy.</td>
              <td>Yes.</td>
            </tr>
            <tr>
              <td>
                <code>degraded</code>
              </td>
              <td>Session is connected but experiencing problems.</td>
              <td>
                No &mdash; <code>503 WORKER_UNAVAILABLE</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>offline</code>
              </td>
              <td>
                Session is not reachable, or its heartbeat is more than 60 seconds old (reported as{' '}
                <code>offline</code> even if the stored status is something else).
              </td>
              <td>
                No &mdash; <code>503 WORKER_UNAVAILABLE</code>. Contact{' '}
                <a href="mailto:security@hmddevs.org">security@hmddevs.org</a> if the session does
                not recover.
              </td>
            </tr>
            <tr>
              <td>
                <code>stopped</code>
              </td>
              <td>Session has been deliberately stopped (for example, unlinked by an admin).</td>
              <td>
                No &mdash; <code>503 WORKER_UNAVAILABLE</code>.
              </td>
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
            code: `curl https://wa.example.com/v1/worker/status \\
  -H "Authorization: Bearer hmd_sk_developments_live_…"`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/worker/status', {
  headers: {
    Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\`,
  },
});

if (!res.ok) {
  const err = await res.json();
  throw new Error(err.code);
}

const session = await res.json();

if (session.status !== 'connected') {
  // Fall back to an alternative channel
  console.warn('Session not connected:', session.status, session.lastHeartbeatAt);
}`,
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
              <td>
                Success. Always returned for a valid, authenticated request, even when the session
                is offline; the connection state is encoded in the <code>status</code> field, not
                the HTTP status.
              </td>
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
                <code>SCOPE_DENIED</code>
              </td>
              <td>
                Key lacks the <code>read:status</code> scope.
              </td>
            </tr>
            <tr>
              <td>403</td>
              <td>
                <code>IP_NOT_ALLOWED</code>
              </td>
              <td>Client IP not in the key&apos;s CIDR allowlist.</td>
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
    </article>
  );
}
