import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';
import { Endpoint } from '@/components/docs/endpoint';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'List messages',
  description:
    'Retrieve a reverse-chronological, paginated list of outbound messages for the calling API key using GET /v1/messages.',
};

export default function ListMessagesPage() {
  return (
    <article className="doc-prose">
      <h1>List messages</h1>
      <p className="doc-lead">
        Fetch a reverse-chronological list of outbound messages associated with the calling API key.
        Walk backwards through history by paging on message id. Returns only messages that belong to
        the calling key.
      </p>

      <Endpoint method="GET" path="/v1/messages" />

      <h2 id="authentication">Authentication and scope</h2>
      <p>
        Requires a Bearer API key in the <code>Authorization</code> header. No additional scope is
        required; any authenticated key may list its own messages. See{' '}
        <Link href="/docs/scopes">Scopes</Link> and{' '}
        <Link href="/docs/authentication">Authentication</Link>.
      </p>

      <h2 id="query-params">Query parameters</h2>
      <ParamTable
        rows={[
          {
            name: 'limit',
            type: 'integer',
            required: false,
            default: '50',
            description: (
              <>
                Maximum number of messages to return in this page. Values above 200 are capped to
                200.
              </>
            ),
          },
          {
            name: 'before',
            type: 'string (message id)',
            required: false,
            description: (
              <>
                Page backwards through history. Pass the <code>messageId</code> of the last item
                from the previous response to fetch the next, older page. Omit on the first request.
              </>
            ),
          },
        ]}
      />

      <h2 id="response">Response</h2>
      <p>
        Returns <code>200 OK</code> with a <code>messages</code> array, ordered newest to oldest.
        Each entry is a summary; the full body content and status history are available from{' '}
        <Link href="/docs/endpoints/get">Get a message</Link>.
      </p>

      <Callout type="note" title="Body is summarised in list responses">
        Each entry&apos;s <code>body</code> contains only its <code>kind</code>, for example{' '}
        <code>{'{ "kind": "text" }'}</code>. The message text and media URLs are not returned here.
        Use <code>GET /v1/messages/{'{messageId}'}</code> for the complete record.
      </Callout>

      <h2 id="response-fields">Response fields</h2>
      <ParamTable
        rows={[
          {
            name: 'messages',
            type: 'array',
            description: 'Array of message summary objects, newest first. May be empty.',
          },
          {
            name: 'messages[].messageId',
            type: 'string (UUID)',
            description: 'Unique gateway identifier for this message.',
          },
          {
            name: 'messages[].to',
            type: 'string (E.164)',
            description: 'Recipient phone number.',
          },
          {
            name: 'messages[].channel',
            type: 'enum',
            description: (
              <>
                One of <code>notification</code>, <code>transactional</code>, or{' '}
                <code>internal</code>.
              </>
            ),
          },
          {
            name: 'messages[].purpose',
            type: 'enum',
            description: (
              <>
                The purpose supplied at creation. One of <code>otp</code>, <code>magic_link</code>,{' '}
                <code>transactional</code>, <code>notification</code>, <code>support</code>,{' '}
                <code>marketing</code>, <code>campaign</code>, <code>newsletter</code>,{' '}
                <code>announcement</code>, or <code>other</code>.
              </>
            ),
          },
          {
            name: 'messages[].status',
            type: 'enum',
            description: (
              <>
                Current lifecycle status. One of <code>queued</code>, <code>scheduled</code>,{' '}
                <code>sent</code>, <code>delivered</code>, <code>read</code>, <code>failed</code>,
                or <code>expired</code>.
              </>
            ),
          },
          {
            name: 'messages[].createdAt',
            type: 'string (ISO 8601)',
            description: 'When the message was accepted by the gateway.',
          },
          {
            name: 'messages[].body',
            type: 'object',
            description: (
              <>
                Body summary. Contains <code>kind</code> only: <code>text</code>, <code>image</code>
                , or <code>document</code>.
              </>
            ),
          },
        ]}
      />

      <Callout type="note" title="Paging to the end">
        There is no cursor field in the response. To page backwards, take the <code>messageId</code>{' '}
        of the last entry and pass it as <code>before</code> on the next request. When a page
        returns fewer than <code>limit</code> entries (or an empty <code>messages</code> array), you
        have reached the end of the history.
      </Callout>

      <h2 id="examples">Examples</h2>

      <h3 id="first-page">First page</h3>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl "https://wa.example.com/v1/messages?limit=20" \\
  -H "Authorization: Bearer hmd_sk_developments_live_…"`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/messages?limit=20', {
  headers: {
    Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\`,
  },
});

const data = await res.json();
// data.messages: array of message summaries, newest first
const last = data.messages.at(-1);
// pass last.messageId as ?before= to fetch older messages`,
          },
          {
            label: 'Response',
            lang: 'json',
            code: `{
  "messages": [
    {
      "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
      "to": "+447700900123",
      "channel": "transactional",
      "purpose": "otp",
      "status": "delivered",
      "createdAt": "2026-06-24T12:34:56.000Z",
      "body": { "kind": "text" }
    },
    {
      "messageId": "7f3b2e15-1d58-4a0f-96de-234567890bcd",
      "to": "+447700900456",
      "channel": "notification",
      "purpose": "notification",
      "status": "sent",
      "createdAt": "2026-06-24T12:33:00.000Z",
      "body": { "kind": "image" }
    }
  ]
}`,
          },
        ]}
      />

      <h3 id="next-page">Fetching older pages</h3>
      <p>
        Pass the <code>messageId</code> of the last entry as the <code>before</code> query
        parameter. Repeat until a page returns fewer than <code>limit</code> entries.
      </p>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `# before = the messageId of the last entry from the previous page
curl "https://wa.example.com/v1/messages?limit=20&before=7f3b2e15-1d58-4a0f-96de-234567890bcd" \\
  -H "Authorization: Bearer hmd_sk_developments_live_…"`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `async function fetchAllMessages() {
  const all: unknown[] = [];
  let before: string | undefined;
  const LIMIT = 50;

  for (;;) {
    const params = new URLSearchParams({ limit: String(LIMIT) });
    if (before) params.set('before', before);

    const res = await fetch(
      \`https://wa.example.com/v1/messages?\${params}\`,
      { headers: { Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\` } },
    );
    if (!res.ok) throw new Error((await res.json()).code);

    const { messages } = await res.json();
    all.push(...messages);
    if (messages.length < LIMIT) break; // reached the end
    before = messages.at(-1).messageId;
  }

  return all;
}`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

def fetch_all_messages():
    out, before, limit = [], None, 50
    while True:
        params = {"limit": limit}
        if before:
            params["before"] = before
        r = requests.get(
            "https://wa.example.com/v1/messages",
            params=params,
            headers={"Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}"},
        )
        r.raise_for_status()
        msgs = r.json()["messages"]
        out.extend(msgs)
        if len(msgs) < limit:
            break
        before = msgs[-1]["messageId"]
    return out`,
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
                Success. Returns the <code>messages</code> array (may be empty).
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
                <code>IP_NOT_ALLOWED</code>
              </td>
              <td>Client IP is not in the key&apos;s CIDR allowlist.</td>
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

      <CodeBlock
        lang="json"
        title="Error envelope"
        code={`{
  "error": "Missing or invalid bearer token",
  "code": "UNAUTHORIZED",
  "requestId": "req_01hvz…"
}`}
      />

      <Callout type="note" title="Error envelope shape">
        All non-2xx responses follow the flat shape{' '}
        <code>{'{ "error": "…", "code": "…", "requestId": "…" }'}</code>. Always match on{' '}
        <code>code</code>, not on <code>error</code>; the message text may change without notice.
        See the <Link href="/docs/errors">Error codes reference</Link> for the full catalogue.
      </Callout>
    </article>
  );
}
