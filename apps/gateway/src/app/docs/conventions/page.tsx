import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { CodeSample } from '@/components/docs/code-sample';

export const metadata: Metadata = {
  title: 'API conventions',
  description:
    'Base URL, authentication, content type, phone format, timestamps, and other conventions that apply to every HMD WA Gateway request.',
};

export default function ConventionsPage() {
  return (
    <article className="doc-prose">
      <h1>API conventions</h1>
      <p className="doc-lead">
        These conventions apply to every request and response on the HMD WA Gateway. Read this page
        before consulting individual endpoint references; it explains the contract that never
        changes.
      </p>

      <h2 id="base-url">Base URL</h2>
      <p>All consumer endpoints are served from a single origin:</p>
      <CodeBlock lang="bash" code="https://wa.example.com" />
      <p>
        Append the path directly, for example <code>https://wa.example.com/v1/messages</code>. No
        trailing slash is required or expected. All traffic is HTTPS only; plain HTTP connections
        are rejected.
      </p>

      <h2 id="authentication">Authorisation header</h2>
      <p>
        Every consumer request must include a Bearer API key in the <code>Authorization</code>{' '}
        header:
      </p>
      <CodeBlock lang="http" code={`Authorization: Bearer hmd_sk_developments_live_…`} />
      <p>
        Keys follow the format <code>hmd_sk_{'<division>_<env>_<secret>'}</code>, where{' '}
        <code>env</code> is either <code>test</code> or <code>live</code>. A key is exposed only
        once at creation time; store it immediately in an environment variable and never commit it
        to source control.
      </p>
      <p>
        Missing, malformed, revoked, or unrecognised tokens return <code>401 UNAUTHORIZED</code>. An
        authenticated key that lacks the required scope returns <code>403 SCOPE_DENIED</code>. See{' '}
        <Link href="/docs/scopes">Scopes</Link> for the full scope model and{' '}
        <Link href="/docs/authentication">Authentication</Link> for key lifecycle.
      </p>

      <h2 id="content-type">Content type and body limit</h2>
      <p>
        All request bodies must be JSON. Set the header on every write request as a matter of good
        practice:
      </p>
      <CodeBlock lang="http" code="Content-Type: application/json; charset=utf-8" />
      <p>
        The gateway parses the body as JSON regardless of the <code>Content-Type</code> header
        supplied; it does not currently enforce this header, so{' '}
        <code>415 UNSUPPORTED_MEDIA_TYPE</code> is a reserved code, not one you will see in
        practice. A body that fails to parse as JSON returns <code>400 INVALID_BODY</code> instead.
        The maximum accepted body size is <strong>64 KiB</strong>; larger bodies return{' '}
        <code>413 PAYLOAD_TOO_LARGE</code>.
      </p>
      <p>
        All responses carry <code>Content-Type: application/json; charset=utf-8</code>. Parse
        response bodies as UTF-8 JSON; do not rely on a BOM.
      </p>

      <h2 id="phone-format">Phone number format (E.164)</h2>
      <p>
        All phone numbers in requests and responses use{' '}
        <a href="https://en.wikipedia.org/wiki/E.164" target="_blank" rel="noopener noreferrer">
          E.164
        </a>{' '}
        format. The canonical regular expression is:
      </p>
      <CodeBlock lang="bash" code={`^\\+[1-9]\\d{6,14}$`} />
      <p>
        An E.164 number begins with <code>+</code>, followed by the country code (no leading zero),
        followed by the subscriber number. Total length is 7–20 characters including the{' '}
        <code>+</code> prefix.
      </p>
      <p>
        The gateway normalises numbers that contain spaces, dashes, or parentheses before
        validation, so <code>+44 (770) 090-0123</code> is accepted and stored as{' '}
        <code>+447700900123</code>. Input that cannot be normalised to a valid E.164 number returns{' '}
        <code>400 INVALID_PHONE</code>.
      </p>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Input</th>
              <th>Normalised</th>
              <th>Accepted</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>+447700900123</code>
              </td>
              <td>
                <code>+447700900123</code>
              </td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>
                <code>+44 7700 900 123</code>
              </td>
              <td>
                <code>+447700900123</code>
              </td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>
                <code>+44 (7700) 900-123</code>
              </td>
              <td>
                <code>+447700900123</code>
              </td>
              <td>Yes</td>
            </tr>
            <tr>
              <td>
                <code>07700900123</code>
              </td>
              <td>n/a</td>
              <td>No (missing country code)</td>
            </tr>
            <tr>
              <td>
                <code>+44</code>
              </td>
              <td>n/a</td>
              <td>No (too short after country code)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="timestamps">Timestamps</h2>
      <p>
        All timestamps are{' '}
        <a href="https://www.rfc-editor.org/rfc/rfc3339" target="_blank" rel="noopener noreferrer">
          ISO 8601 (RFC 3339)
        </a>{' '}
        strings with an explicit timezone offset. UTC is used throughout:
      </p>
      <CodeBlock lang="text" code="2026-06-24T12:00:00+00:00" />
      <p>
        When supplying a timestamp in a request (for example <code>sendAt</code>), include the
        timezone offset. The gateway accepts any valid RFC 3339 offset and normalises internally to
        UTC. Responses always carry <code>+00:00</code>.
      </p>
      <p>
        Dates are never returned as Unix epoch integers. Parse response timestamps with your
        platform&apos;s ISO 8601 parser; do not assume a fixed string length or field order.
      </p>

      <h2 id="json-request-response">JSON request and response</h2>
      <p>
        The API is JSON-only on both request and response. There are no multipart, form-encoded, or
        binary endpoints. Error responses follow a flat envelope regardless of the HTTP status:
      </p>
      <CodeBlock
        lang="json"
        title="Error envelope"
        code={`{
  "error": "Human-readable description",
  "code": "MACHINE_READABLE_CODE",
  "requestId": "req_…"
}`}
      />
      <p>
        Always branch on <code>code</code>, never on <code>error</code>. The human-readable message
        may change without notice. See <Link href="/docs/errors">Error codes</Link> for the complete
        catalogue.
      </p>

      <h2 id="request-id">X-Request-Id header</h2>
      <p>
        Every response, including errors, carries an <code>X-Request-Id</code> header containing a
        UUID that uniquely identifies the request as it passed through the gateway:
      </p>
      <CodeBlock lang="http" code="X-Request-Id: req_8e8f3a26-0c47-4f3e-85cd-123456789abc" />
      <p>
        This value is also echoed in the <code>requestId</code> field of error envelopes and
        synchronous confirm responses. Quote it in all support enquiries; it is the fastest way to
        locate the server-side log entry.
      </p>

      <Callout type="tip" title="Support shortcut">
        When something goes wrong, capture the <code>X-Request-Id</code> from the response headers
        before any retry logic runs. It pinpoints the exact server-side event even if the client
        never received a body.
      </Callout>

      <h2 id="cache-control">Cache-Control</h2>
      <p>Every response carries:</p>
      <CodeBlock lang="http" code="Cache-Control: no-store" />
      <p>
        This prevents CDNs, reverse proxies, and browser caches from storing responses that may
        contain message content or status. Do not attempt to cache responses; the directive is
        intentional and non-negotiable.
      </p>

      <h2 id="versioning">Versioning</h2>
      <p>
        The current stable API version is <code>v1</code>, reflected in every endpoint path (e.g.{' '}
        <code>/v1/messages</code>). See <Link href="/docs/versioning">Versioning</Link> for the
        stability guarantees, deprecation policy, and how breaking changes are communicated.
      </p>

      <h2 id="idempotency">Idempotency</h2>
      <p>
        Write endpoints accept an optional <code>idempotencyKey</code> field in the request body.
        Submitting the same key a second time returns the original response without re-executing the
        operation. Keys are scoped to your API key; the practical replay window follows the
        message&apos;s own <code>ttlSeconds</code> (default 30 minutes, maximum 24 hours), not a
        fixed 24-hour expiry. See <Link href="/docs/idempotency">Idempotency</Link> for the full
        semantics and recommended key construction patterns.
      </p>

      <h2 id="request-example">Putting it together</h2>
      <p>A minimal well-formed request looks like this:</p>

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
    "body": { "kind": "text", "text": "Hello." }
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
    body: { kind: 'text', text: 'Hello.' },
  }),
});

// Always capture before discarding the response
const requestId = res.headers.get('x-request-id');
const data = await res.json();`,
          },
        ]}
      />
    </article>
  );
}
