import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { CodeSample } from '@/components/docs/code-sample';
import { Endpoint } from '@/components/docs/endpoint';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Presence & typing',
  description:
    'Push online, offline, and typing indicators for a session using POST /v1/sessions/:sessionId/presence.',
};

export default function PresencePage() {
  return (
    <article className="doc-prose">
      <h1>Presence &amp; typing</h1>
      <p className="doc-lead">
        Push real-time presence and typing indicators for your session. Set your session as online
        or offline globally, or send a chat-level typing indicator to a specific recipient.
      </p>

      <Callout type="note" title="Ephemeral delivery">
        Presence updates are not queued. If the session is not currently connected, the update is
        silently dropped. Check the session status before sending presence if reliable delivery
        matters.
      </Callout>

      <h2 id="endpoint">Endpoint</h2>

      <Endpoint method="POST" path="/v1/sessions/:sessionId/presence" />

      <h2 id="auth">Authentication and scope</h2>
      <p>
        Requires a Bearer API key with the <code>send:transactional</code> scope. The{' '}
        <code>sessionId</code> in the path must exactly match the session bound to the calling API
        key; any mismatch returns <code>403 SCOPE_DENIED</code>. See{' '}
        <Link href="/docs/authentication">Authentication</Link> for key format and binding details.
      </p>

      <h2 id="path-params">Path parameters</h2>
      <ParamTable
        rows={[
          {
            name: 'sessionId',
            type: 'string',
            required: true,
            description: (
              <>
                The session identifier. Must match the session bound to your API key. A mismatch
                returns <code>403 SCOPE_DENIED</code>.
              </>
            ),
          },
        ]}
      />

      <h2 id="request-body">Request body</h2>
      <ParamTable
        rows={[
          {
            name: 'state',
            type: 'enum',
            required: true,
            description: (
              <>
                The presence state to publish. One of <code>available</code>,{' '}
                <code>unavailable</code>, <code>composing</code>, <code>recording</code>, or{' '}
                <code>paused</code>. Any other value returns <code>422 INVALID_PRESENCE_STATE</code>
                . See state meanings below.
              </>
            ),
          },
          {
            name: 'to',
            type: 'string (E.164)',
            required: false,
            description: (
              <>
                Recipient phone number, 6 to 20 characters. E.164 format is canonical (e.g.{' '}
                <code>+447700900123</code>); the gateway also normalises numbers with spaces,
                dashes, or parentheses. When provided, the presence update is scoped to that
                specific chat, enabling typing indicators visible only to that contact. When
                omitted, the update is session-wide (global online/offline status). A value outside
                the 6–20 character bound returns <code>422 INVALID_PRESENCE_STATE</code>; a value
                within the bound that cannot be normalised to a phone number returns{' '}
                <code>400 INVALID_PHONE</code>.
              </>
            ),
          },
        ]}
      />

      <h2 id="state-values">State values</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th>Scope</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>available</code>
              </td>
              <td>
                Global (no <code>to</code>)
              </td>
              <td>Session is online and active.</td>
            </tr>
            <tr>
              <td>
                <code>unavailable</code>
              </td>
              <td>
                Global (no <code>to</code>)
              </td>
              <td>Session is offline.</td>
            </tr>
            <tr>
              <td>
                <code>composing</code>
              </td>
              <td>
                Chat-scoped (needs <code>to</code>)
              </td>
              <td>Typing indicator shown to the recipient.</td>
            </tr>
            <tr>
              <td>
                <code>recording</code>
              </td>
              <td>
                Chat-scoped (needs <code>to</code>)
              </td>
              <td>Recording audio or video indicator shown to the recipient.</td>
            </tr>
            <tr>
              <td>
                <code>paused</code>
              </td>
              <td>
                Chat-scoped (needs <code>to</code>)
              </td>
              <td>Was composing but stopped; clears the typing indicator.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="tip" title="Chat-scoped vs. global">
        Use <code>available</code> and <code>unavailable</code> without a <code>to</code> field to
        control your session&apos;s global online status. Use <code>composing</code>,{' '}
        <code>recording</code>, or <code>paused</code> with a <code>to</code> value to show
        real-time indicators inside a specific conversation. <code>to</code> is not enforced by the
        request schema for any state: sending <code>composing</code>, <code>recording</code>, or{' '}
        <code>paused</code> without <code>to</code> is accepted (<code>200 queued</code>) but has no
        visible effect, since WhatsApp needs a target chat to show a typing indicator against.
      </Callout>

      <h2 id="response">Success response</h2>
      <p>
        Returns <code>200 OK</code> with a <code>status</code> of <code>queued</code>, confirming
        the update has been accepted for dispatch.
      </p>

      <CodeBlock
        lang="json"
        title="200 response"
        code={`{
  "status": "queued"
}`}
      />

      <h2 id="examples">Examples</h2>

      <h3 id="example-global">Global presence</h3>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl -X POST https://wa.example.com/v1/sessions/default/presence \\
  -H "Authorization: Bearer hmd_sk_developments_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{ "state": "available" }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const sessionId = 'default';

const res = await fetch(
  \`https://wa.example.com/v1/sessions/\${sessionId}/presence\`,
  {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ state: 'available' }),
  },
);

const data = await res.json();
console.log(data.status); // "queued"`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

session_id = "default"

res = requests.post(
    f"https://wa.example.com/v1/sessions/{session_id}/presence",
    headers={
        "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={"state": "available"},
)
data = res.json()
print(data["status"])  # "queued"`,
          },
        ]}
      />

      <h3 id="example-typing">Chat-level typing indicator</h3>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl -X POST https://wa.example.com/v1/sessions/default/presence \\
  -H "Authorization: Bearer hmd_sk_developments_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "state": "composing",
    "to": "+447700900123"
  }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const sessionId = 'default';

const res = await fetch(
  \`https://wa.example.com/v1/sessions/\${sessionId}/presence\`,
  {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      state: 'composing',
      to: '+447700900123',
    }),
  },
);

const data = await res.json();
console.log(data.status); // "queued"`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

session_id = "default"

res = requests.post(
    f"https://wa.example.com/v1/sessions/{session_id}/presence",
    headers={
        "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={"state": "composing", "to": "+447700900123"},
)
data = res.json()
print(data["status"])  # "queued"`,
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
              <td>Presence update accepted.</td>
            </tr>
            <tr>
              <td>400</td>
              <td>
                <code>INVALID_BODY</code>
              </td>
              <td>JSON parse failure or schema violation.</td>
            </tr>
            <tr>
              <td>400</td>
              <td>
                <code>INVALID_PHONE</code>
              </td>
              <td>
                <code>to</code> could not be normalised to E.164.
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
                Key lacks <code>send:transactional</code> scope, or the path <code>sessionId</code>{' '}
                does not match the key&apos;s bound session.
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
              <td>413</td>
              <td>
                <code>PAYLOAD_TOO_LARGE</code>
              </td>
              <td>Request body exceeded 64 KiB.</td>
            </tr>
            <tr>
              <td>422</td>
              <td>
                <code>INVALID_PRESENCE_STATE</code>
              </td>
              <td>
                Request body failed schema validation: <code>state</code> is not one of the five
                valid enum values, or <code>to</code> is outside the 6–20 character bound.
              </td>
            </tr>
            <tr>
              <td>429</td>
              <td>
                <code>RATE_LIMITED</code>
              </td>
              <td>Rate limit exceeded.</td>
            </tr>
            <tr>
              <td>503</td>
              <td>
                <code>WORKER_UNAVAILABLE</code>
              </td>
              <td>Session is not connected; update dropped.</td>
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

      <p>
        See the <Link href="/docs/errors">Error codes reference</Link> for the full catalogue.
      </p>
    </article>
  );
}
