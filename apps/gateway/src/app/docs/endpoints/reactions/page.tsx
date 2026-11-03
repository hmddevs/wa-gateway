import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { CodeSample } from '@/components/docs/code-sample';
import { Endpoint } from '@/components/docs/endpoint';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Reactions',
  description:
    'Set or clear an emoji reaction on a prior outbound message using POST or DELETE /v1/messages/:messageId/reactions.',
};

export default function ReactionsPage() {
  return (
    <article className="doc-prose">
      <h1>Reactions</h1>
      <p className="doc-lead">
        React to a prior outbound message with an emoji, or remove your reaction entirely. WhatsApp
        allows one reaction per sender per message; a second call replaces the first.
      </p>

      <Callout type="note" title="Outbound messages only">
        The <code>messageId</code> must be the gateway UUID returned by a prior{' '}
        <code>POST /v1/messages</code> that belongs to the same session as the calling API key.
        Reacting to inbound messages is not currently supported.
      </Callout>

      {/* ------------------------------------------------------------------ */}
      <h2 id="set-a-reaction">Set a reaction</h2>

      <Endpoint method="POST" path="/v1/messages/:messageId/reactions" />

      <p>
        Sends an emoji reaction to the specified message. If a reaction already exists from this
        session, it is replaced.
      </p>

      <h3 id="set-auth">Authentication and scope</h3>
      <p>
        Requires a Bearer API key with the <code>send:transactional</code> scope. See{' '}
        <Link href="/docs/authentication">Authentication</Link> for key format and bearer usage.
      </p>

      <h3 id="set-path-params">Path parameters</h3>
      <ParamTable
        rows={[
          {
            name: 'messageId',
            type: 'string (UUID)',
            required: true,
            description: (
              <>
                The gateway UUID of the outbound message to react to. Must be a valid UUID v4;
                invalid values return <code>400 INVALID_BODY</code>. Must belong to the same session
                as the calling API key; otherwise returns <code>404 RECIPIENT_NOT_FOUND</code>.
              </>
            ),
          },
        ]}
      />

      <h3 id="set-body">Request body</h3>
      <ParamTable
        rows={[
          {
            name: 'emoji',
            type: 'string',
            required: true,
            description: (
              <>
                The emoji to set. Must be 1–8 characters and contain at least one unicode
                Extended_Pictographic codepoint. An empty string, a plain text string, or a value
                that fails emoji validation returns <code>422 INVALID_REACTION</code>. To remove a
                reaction, use <code>DELETE /v1/messages/:messageId/reactions</code> instead.
              </>
            ),
          },
        ]}
      />

      <h3 id="set-response">Success response</h3>
      <p>
        Returns <code>202 Accepted</code>. The reaction has been accepted for delivery. The{' '}
        <code>messageId</code> in the response identifies the reaction operation itself, not the
        original message.
      </p>

      <h3 id="set-example">Examples</h3>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl -X POST https://wa.example.com/v1/messages/8e8f3a26-0c47-4f3e-85cd-123456789abc/reactions \\
  -H "Authorization: Bearer hmd_sk_developments_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{ "emoji": "👍" }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const messageId = '8e8f3a26-0c47-4f3e-85cd-123456789abc';

const res = await fetch(
  \`https://wa.example.com/v1/messages/\${messageId}/reactions\`,
  {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ emoji: '👍' }),
  },
);

const data = await res.json();
console.log(data.status); // "queued"`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

message_id = "8e8f3a26-0c47-4f3e-85cd-123456789abc"

res = requests.post(
    f"https://wa.example.com/v1/messages/{message_id}/reactions",
    headers={
        "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={"emoji": "👍"},
)
data = res.json()
print(data["status"])  # "queued"`,
          },
        ]}
      />

      <CodeBlock
        lang="json"
        title="202 response: reaction set"
        code={`{
  "messageId": "1f0a4c01-ab12-4de3-8f90-123456789def",
  "emoji": "👍",
  "status": "queued"
}`}
      />

      {/* ------------------------------------------------------------------ */}
      <h2 id="clear-a-reaction">Clear a reaction</h2>

      <Endpoint method="DELETE" path="/v1/messages/:messageId/reactions" />

      <p>
        Removes the reaction this session has set on a prior outbound message. No request body is
        required.
      </p>

      <h3 id="delete-auth">Authentication and scope</h3>
      <p>
        Requires the same Bearer API key with <code>send:transactional</code> scope as the POST
        variant.
      </p>

      <h3 id="delete-path-params">Path parameters</h3>
      <ParamTable
        rows={[
          {
            name: 'messageId',
            type: 'string (UUID)',
            required: true,
            description: 'The gateway UUID of the outbound message to clear the reaction from.',
          },
        ]}
      />

      <h3 id="delete-response">Success response</h3>
      <p>
        Returns <code>202 Accepted</code> with <code>emoji</code> set to an empty string, confirming
        the clear has been accepted.
      </p>

      <h3 id="delete-example">Examples</h3>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl -X DELETE https://wa.example.com/v1/messages/8e8f3a26-0c47-4f3e-85cd-123456789abc/reactions \\
  -H "Authorization: Bearer hmd_sk_developments_live_…"`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const messageId = '8e8f3a26-0c47-4f3e-85cd-123456789abc';

const res = await fetch(
  \`https://wa.example.com/v1/messages/\${messageId}/reactions\`,
  {
    method: 'DELETE',
    headers: {
      'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    },
  },
);

const data = await res.json();
console.log(data.emoji, data.status); // "", "queued"`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

message_id = "8e8f3a26-0c47-4f3e-85cd-123456789abc"

res = requests.delete(
    f"https://wa.example.com/v1/messages/{message_id}/reactions",
    headers={
        "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
    },
)
data = res.json()
print(data["emoji"], data["status"])  # "", "queued"`,
          },
        ]}
      />

      <CodeBlock
        lang="json"
        title="202 response: reaction cleared"
        code={`{
  "messageId": "2a1b5d02-cd34-5ef4-9a01-234567890ef0",
  "emoji": "",
  "status": "queued"
}`}
      />

      {/* ------------------------------------------------------------------ */}
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
              <td>202</td>
              <td></td>
              <td>Reaction accepted for delivery.</td>
            </tr>
            <tr>
              <td>400</td>
              <td>
                <code>INVALID_BODY</code>
              </td>
              <td>
                Path <code>messageId</code> is not a valid UUID, or (POST only) the request body was
                not valid JSON.
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
                Key lacks the <code>send:transactional</code> scope.
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
              <td>404</td>
              <td>
                <code>RECIPIENT_NOT_FOUND</code>
              </td>
              <td>Target message not found or belongs to a different session.</td>
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
                <code>INVALID_REACTION</code>
              </td>
              <td>
                <code>emoji</code> is empty on POST, exceeds 8 characters, contains no unicode
                Extended_Pictographic codepoint, or the target message has not yet been sent by the
                worker (no <code>waMessageId</code> recorded yet).
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
              <td>Session is not connected.</td>
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
        See the <Link href="/docs/errors">Error codes reference</Link> for the full catalogue and
        matching guidance.
      </p>
    </article>
  );
}
