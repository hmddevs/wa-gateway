import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { CodeSample } from '@/components/docs/code-sample';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Message body types',
  description: 'The three body shapes accepted by POST /v1/messages: text, image, and document.',
};

export default function MessageBodyTypesPage() {
  return (
    <article className="doc-prose">
      <h1>Message body types</h1>
      <p className="doc-lead">
        Every send request carries a <code>body</code> field: a discriminated union keyed on{' '}
        <code>kind</code>. Pick the variant that matches your content. Supplying an unrecognised{' '}
        <code>kind</code> returns <code>400 INVALID_BODY</code>.
      </p>

      <p>
        The three supported kinds are <strong>text</strong>, <strong>image</strong>, and{' '}
        <strong>document</strong>. Each is documented in full below, including all fields,
        constraints, and a complete example.
      </p>

      {/* ------------------------------------------------------------------ */}
      <h2 id="text">text</h2>
      <p>
        Sends a plain-text message. No media or attachments; the full content is in the{' '}
        <code>text</code> field.
      </p>

      <h3 id="text-fields">Fields</h3>
      <ParamTable
        rows={[
          {
            name: 'kind',
            type: "string ('text')",
            required: true,
            description: (
              <>
                Must be the literal string <code>&apos;text&apos;</code>.
              </>
            ),
          },
          {
            name: 'text',
            type: 'string',
            required: true,
            description: (
              <>
                The message content. Minimum 1 character, maximum 4 096 characters. Empty string and
                strings exceeding 4 096 characters return <code>400 INVALID_BODY</code>.
              </>
            ),
          },
        ]}
      />

      <h3 id="text-example">Example</h3>
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
    "channel": "transactional",
    "purpose": "transactional",
    "body": {
      "kind": "text",
      "text": "Your order #4711 has been confirmed."
    }
  }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+447700900123',
    channel: 'transactional',
    purpose: 'transactional',
    body: {
      kind: 'text',
      text: 'Your order #4711 has been confirmed.',
    },
  }),
});

const data = await res.json();
console.log(data.messageId, data.status); // "8e8f3a26-…", "queued"`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

res = requests.post(
    "https://wa.example.com/v1/messages",
    headers={
        "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "to": "+447700900123",
        "channel": "transactional",
        "purpose": "transactional",
        "body": {
            "kind": "text",
            "text": "Your order #4711 has been confirmed.",
        },
    },
)
data = res.json()
print(data["messageId"], data["status"])  # "8e8f3a26-…", "queued"`,
          },
        ]}
      />

      {/* ------------------------------------------------------------------ */}
      <h2 id="image">image</h2>
      <p>
        Sends an image hosted at a publicly accessible URL. The gateway validates the URL&apos;s
        host before dispatch but does not fetch or inspect the image itself; see{' '}
        <a href="#media-validation">Media URLs</a> below.
      </p>

      <h3 id="image-fields">Fields</h3>
      <ParamTable
        rows={[
          {
            name: 'kind',
            type: "string ('image')",
            required: true,
            description: (
              <>
                Must be the literal string <code>&apos;image&apos;</code>.
              </>
            ),
          },
          {
            name: 'url',
            type: 'string (URL)',
            required: true,
            description: (
              <>
                A publicly reachable <code>https://</code> URL. The gateway resolves and validates
                the hostname before dispatch, then passes the URL straight through to the paired
                WhatsApp client, which fetches the resource itself when the message is sent. It must
                be reachable from WhatsApp&apos;s servers, not from the gateway. See{' '}
                <a href="#media-validation">Media URLs</a> below.
              </>
            ),
          },
          {
            name: 'caption',
            type: 'string',
            required: false,
            description: (
              <>
                Optional caption displayed beneath the image. Maximum 1 024 characters. Omit
                entirely if no caption is needed.
              </>
            ),
          },
        ]}
      />

      <h3 id="image-example">Example</h3>
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
    "channel": "transactional",
    "purpose": "transactional",
    "body": {
      "kind": "image",
      "url": "https://cdn.example.com/receipt-4711.png",
      "caption": "Receipt for order #4711"
    }
  }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+447700900123',
    channel: 'transactional',
    purpose: 'transactional',
    body: {
      kind: 'image',
      url: 'https://cdn.example.com/receipt-4711.png',
      caption: 'Receipt for order #4711',
    },
  }),
});`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

res = requests.post(
    "https://wa.example.com/v1/messages",
    headers={
        "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "to": "+447700900123",
        "channel": "transactional",
        "purpose": "transactional",
        "body": {
            "kind": "image",
            "url": "https://cdn.example.com/receipt-4711.png",
            "caption": "Receipt for order #4711",
        },
    },
)`,
          },
        ]}
      />

      <CodeBlock
        lang="json"
        title="body object (image)"
        code={`{
  "kind": "image",
  "url": "https://cdn.example.com/receipt-4711.png",
  "caption": "Receipt for order #4711"
}`}
      />

      {/* ------------------------------------------------------------------ */}
      <h2 id="document">document</h2>
      <p>
        Sends a file attachment hosted at a publicly accessible URL. Accepts PDFs, spreadsheets, and
        other file types supported by WhatsApp.
      </p>

      <h3 id="document-fields">Fields</h3>
      <ParamTable
        rows={[
          {
            name: 'kind',
            type: "string ('document')",
            required: true,
            description: (
              <>
                Must be the literal string <code>&apos;document&apos;</code>.
              </>
            ),
          },
          {
            name: 'url',
            type: 'string (URL)',
            required: true,
            description: (
              <>
                A publicly reachable <code>https://</code> URL, host-validated before dispatch and
                then passed straight through to the paired WhatsApp client. See{' '}
                <a href="#media-validation">Media URLs</a> below.
              </>
            ),
          },
          {
            name: 'filename',
            type: 'string',
            required: false,
            description: (
              <>
                The name displayed as the attachment title in WhatsApp. Minimum 1 character, maximum
                255 characters. If omitted, WhatsApp infers the name from the URL.
              </>
            ),
          },
          {
            name: 'caption',
            type: 'string',
            required: false,
            description: (
              <>Optional caption displayed beneath the attachment. Maximum 1 024 characters.</>
            ),
          },
        ]}
      />

      <h3 id="document-example">Example</h3>
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
    "channel": "transactional",
    "purpose": "transactional",
    "body": {
      "kind": "document",
      "url": "https://cdn.example.com/invoice-4711.pdf",
      "filename": "invoice-4711.pdf",
      "caption": "Invoice for order #4711"
    }
  }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+447700900123',
    channel: 'transactional',
    purpose: 'transactional',
    body: {
      kind: 'document',
      url: 'https://cdn.example.com/invoice-4711.pdf',
      filename: 'invoice-4711.pdf',
      caption: 'Invoice for order #4711',
    },
  }),
});`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import os, requests

res = requests.post(
    "https://wa.example.com/v1/messages",
    headers={
        "Authorization": f"Bearer {os.environ['HMD_WA_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "to": "+447700900123",
        "channel": "transactional",
        "purpose": "transactional",
        "body": {
            "kind": "document",
            "url": "https://cdn.example.com/invoice-4711.pdf",
            "filename": "invoice-4711.pdf",
            "caption": "Invoice for order #4711",
        },
    },
)`,
          },
        ]}
      />

      <CodeBlock
        lang="json"
        title="body object (document)"
        code={`{
  "kind": "document",
  "url": "https://cdn.example.com/invoice-4711.pdf",
  "filename": "invoice-4711.pdf",
  "caption": "Invoice for order #4711"
}`}
      />

      {/* ------------------------------------------------------------------ */}
      <h2 id="group">Sending to a group</h2>
      <p>
        Any body kind above can be sent to a WhatsApp group instead of a single recipient. Pass a
        group JID (<code>120363XXXXXXXXXXXX@g.us</code>) as the <code>to</code> field rather than a
        phone number. The gateway validates the JID shape and dispatches it through the same publish
        path as a direct message; no other field changes.
      </p>
      <ul>
        <li>
          Group quoting (<code>replyTo</code>) is not supported yet: a group send with{' '}
          <code>replyTo</code> returns <code>422 INVALID_BODY</code>. Quoting a group message needs
          the original sender&apos;s <code>participantJid</code>, which the gateway does not yet
          resolve.
        </li>
        <li>
          The opt-out registry does not apply to groups (it is keyed on phone number); a group send
          is never blocked by <code>OPTED_OUT</code>.
        </li>
        <li>
          <code>sendAt</code> (scheduled sends) works normally for groups.
        </li>
      </ul>
      <p>
        <strong>Finding a group&apos;s JID.</strong> The paired number must be a member of the
        group, and the JID is not shown anywhere in the WhatsApp app. Call{' '}
        <code>GET /v1/groups</code> (requires the <code>read:groups</code> scope) and take{' '}
        <code>jid</code> from any entry, results are strictly scoped to your own session. Inbound
        webhooks do not carry the group JID (their <code>from</code> is an E.164 phone), so{' '}
        <code>GET /v1/groups</code> is the way to discover it. See{' '}
        <Link href="/docs/endpoints/groups">List groups</Link> for the full endpoint reference.
      </p>

      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl -X POST https://wa.example.com/v1/messages \\
  -H "Authorization: Bearer hmd_sk_developments_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "120363012345678901@g.us",
    "channel": "notification",
    "purpose": "notification",
    "body": {
      "kind": "text",
      "text": "Standup in 10 minutes."
    }
  }'`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '120363012345678901@g.us',
    channel: 'notification',
    purpose: 'notification',
    body: { kind: 'text', text: 'Standup in 10 minutes.' },
  }),
});`,
          },
        ]}
      />

      {/* ------------------------------------------------------------------ */}
      <h2 id="send-response">Send response</h2>
      <p>
        A successful <code>POST /v1/messages</code> returns <code>202</code> with this shape (or{' '}
        <code>200</code> with <code>idempotent: true</code> on a duplicate key):
      </p>
      <CodeBlock
        lang="json"
        title="202 response"
        code={`{
  "messageId": "8e8f3a26-0c47-4f3e-85cd-123456789abc",
  "status": "queued"
}`}
      />
      <p>
        Use <code>messageId</code> to poll <code>GET /v1/messages/:messageId</code> or to correlate
        incoming webhook events. See <a href="/docs/endpoints/send">Send a message</a> for the full
        field reference, scheduled sends, and synchronous confirm mode.
      </p>

      {/* ------------------------------------------------------------------ */}
      <h2 id="media-validation">Media URLs</h2>
      <p>
        For <code>image</code> and <code>document</code> bodies, the gateway resolves{' '}
        <code>url</code>&apos;s hostname before dispatch and rejects it with{' '}
        <code>400 INVALID_CONTENT</code> if the scheme is not <code>https://</code>, the hostname
        fails to resolve, or any resolved address is loopback, link-local, RFC 1918 private, CGNAT,
        or a cloud metadata address. This is host-level validation only: the gateway does not fetch,
        scan, or otherwise inspect the resource itself. Once the URL passes host validation it is
        forwarded as-is in the outbound envelope, and the paired WhatsApp client fetches the
        resource directly at send time.
      </p>
      <p>
        This means the URL must be reachable from wherever the paired WhatsApp number&apos;s device
        or WhatsApp&apos;s own infrastructure fetches from, not from the gateway. There is no
        gateway-enforced size cap or MIME-type allowlist on media URLs; WhatsApp applies its own
        limits and may reject the send if the resource is unreachable or unsupported. That kind of
        rejection surfaces as a delivery failure (<code>message.failed</code> webhook, or{' '}
        <code>status: &apos;failed&apos;</code> on a confirm-mode send), not as a validation error
        on the initial request.
      </p>

      <Callout type="note" title="Host-level SSRF protection, not content inspection">
        The gateway resolves <code>url</code>&apos;s hostname at send time and blocks addresses that
        resolve to internal or private ranges, which stops the initial request from being used to
        probe the gateway&apos;s own network. It does not fetch or scan the resource content: the
        actual download happens later, from the paired WhatsApp client, so this check cannot see
        what that client ultimately retrieves. Signed URLs with a short expiry must remain valid
        long enough for the WhatsApp client to retrieve them after the message reaches the device,
        which can lag the API call.
      </Callout>

      {/* ------------------------------------------------------------------ */}
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
                <code>INVALID_BODY</code>
              </td>
              <td>400</td>
              <td>
                Unrecognised <code>kind</code>, missing required field, field exceeds its length
                limit, or schema violation in the body object (including a malformed{' '}
                <code>url</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>PAYLOAD_TOO_LARGE</code>
              </td>
              <td>413</td>
              <td>The overall request body exceeded 64 KiB.</td>
            </tr>
            <tr>
              <td>
                <code>INVALID_CONTENT</code>
              </td>
              <td>400</td>
              <td>
                An <code>image</code> or <code>document</code> <code>url</code> failed host
                validation: non-HTTPS, unresolvable, or resolves to a private, loopback, link-local,
                CGNAT, or metadata address. See <a href="#media-validation">Media URLs</a> above.
              </td>
            </tr>
            <tr>
              <td>
                <code>UNSUPPORTED_MEDIA_TYPE</code>
              </td>
              <td>415</td>
              <td>
                Reserved for a <code>Content-Type</code> guard on the request itself; the guard is
                not currently active, so this code is not currently emitted.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  );
}
