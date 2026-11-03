import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'HTTP headers',
  description:
    'Reference for every request and response header used by the HMD WA Gateway API, including a note on the absence of rate-limit headers.',
};

export default function HeadersPage() {
  return (
    <article className="doc-prose">
      <h1>HTTP headers</h1>
      <p className="doc-lead">
        This page lists every HTTP header the HMD WA Gateway reads from requests and every header it
        sets on responses. No other headers are contractual; anything not listed here may be added,
        removed, or changed without notice.
      </p>

      <h2 id="request-headers">Request headers</h2>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Header</th>
              <th>Required</th>
              <th>Value</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>Authorization</code>
              </td>
              <td>Yes</td>
              <td>
                <code>Bearer hmd_sk_…</code>
              </td>
              <td>
                Must use the <code>Bearer</code> scheme exactly, followed by a single space, then
                the API key. Missing or malformed returns <code>401 UNAUTHORIZED</code>; invalid key
                returns <code>401 UNAUTHORIZED</code>; valid key lacking the required scope returns{' '}
                <code>403 SCOPE_DENIED</code>. See{' '}
                <Link href="/docs/authentication">Authentication</Link> and{' '}
                <Link href="/docs/scopes">Scopes</Link>.
              </td>
            </tr>
            <tr>
              <td>
                <code>Content-Type</code>
              </td>
              <td>No, but recommended</td>
              <td>
                <code>application/json; charset=utf-8</code>
              </td>
              <td>
                Send this on <code>POST</code> and <code>DELETE</code> requests with a body as a
                matter of good practice. The gateway does not currently enforce a content-type
                guard: the request body is parsed as JSON regardless of the header value, so{' '}
                <code>415 UNSUPPORTED_MEDIA_TYPE</code> is a reserved code and is not returned in
                practice. A body that fails to parse as JSON returns <code>400 INVALID_BODY</code>{' '}
                instead.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="authorization-detail">Authorization in detail</h3>
      <p>The header value must follow this exact structure:</p>
      <CodeBlock lang="http" code="Authorization: Bearer hmd_sk_developments_live_…" />
      <p>
        The key is verified on every request using a two-phase lookup: a fast HMAC index lookup
        identifies the key record, and then the full credential is verified. Both phases are
        constant-time to prevent timing attacks. Never log or expose the full key value; use the key
        ID (visible in the admin dashboard) when referencing a key in logs or support tickets.
      </p>

      <Callout type="security" title="Keep keys server-side">
        API keys must never be embedded in client-side code, mobile app bundles, or public
        repositories. Treat them as passwords. If a key is exposed, revoke it immediately from the
        admin dashboard and issue a replacement.
      </Callout>

      <h2 id="response-headers">Response headers</h2>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Header</th>
              <th>Present on</th>
              <th>Value</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>X-Request-Id</code>
              </td>
              <td>All responses</td>
              <td>
                UUID (e.g. <code>req_8e8f3a26-…</code>)
              </td>
              <td>
                Unique identifier for the request as processed by the gateway. Echoed in the{' '}
                <code>requestId</code> field of error envelopes and confirm-mode response bodies.
                Quote this value in all support enquiries.
              </td>
            </tr>
            <tr>
              <td>
                <code>Cache-Control</code>
              </td>
              <td>All responses</td>
              <td>
                <code>no-store</code>
              </td>
              <td>
                Prevents CDNs, proxies, and browser caches from storing responses. All responses
                carry this directive unconditionally; do not attempt to cache API responses.
              </td>
            </tr>
            <tr>
              <td>
                <code>Content-Type</code>
              </td>
              <td>All responses</td>
              <td>
                <code>application/json; charset=utf-8</code>
              </td>
              <td>
                All responses, including errors, are JSON. Parse bodies as UTF-8; do not rely on a
                BOM or a charset detection heuristic.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 id="x-request-id-detail">X-Request-Id in detail</h3>
      <p>
        Every response, including <code>4xx</code> and <code>5xx</code> errors, carries{' '}
        <code>X-Request-Id</code>. Capture it from the response before applying any retry logic:
      </p>
      <CodeBlock
        lang="typescript"
        code={`const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ /* … */ }),
});

// Capture before reading the body or retrying
const requestId = res.headers.get('x-request-id');

if (!res.ok) {
  const err = await res.json();
  // err.requestId and requestId will match
  throw new Error(\`[\${err.code}] \${err.error} (requestId: \${requestId})\`);
}`}
      />

      <h2 id="no-rate-limit-headers">No rate-limit headers</h2>
      <p>
        The HMD WA Gateway does <strong>not</strong> return <code>X-RateLimit-Limit</code>,{' '}
        <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code>, or any other rate-limit
        headers on standard responses. Do not read these headers; they will not be present.
      </p>
      <p>
        Rate limiting is signalled exclusively by HTTP status <code>429</code> with the machine-
        readable code <code>RATE_LIMITED</code> in the response body:
      </p>
      <CodeBlock
        lang="json"
        title="429 response body"
        code={`{
  "error": "Rate limit exceeded. Back off and retry.",
  "code": "RATE_LIMITED",
  "requestId": "req_…"
}`}
      />

      <Callout type="warning" title="How to handle 429">
        When you receive a <code>429 RATE_LIMITED</code> response, apply exponential backoff with
        jitter. Start at a minimum of 1 second and double on each consecutive 429, capped at 60
        seconds. Do not hammer the endpoint; the gateway enforces a three-tier sliding window
        (global, per-key, and per-IP) and sustained rapid retries will extend your blocked window.
        See <Link href="/docs/rate-limits">Rate limits</Link> for the tier thresholds and
        recommended back-off implementation.
      </Callout>

      <h2 id="forwarded-headers">Forwarded and proxy headers</h2>
      <p>
        The gateway determines the originating client IP for per-IP rate limiting and CIDR allowlist
        enforcement from the operator-configured <code>TRUSTED_CLIENT_IP_HEADER</code>, injected by
        the deployment&apos;s own reverse proxy and not settable by a client reaching the app
        directly. When Cloudflare fronting is enabled and the immediate upstream hop is itself
        inside a published Cloudflare IP range, <code>CF-Connecting-IP</code> is used instead, since
        that combination proves the request genuinely arrived via Cloudflare. Raw{' '}
        <code>X-Forwarded-For</code> and <code>X-Real-Ip</code> are never trusted for these security
        decisions, since either header is fully client-controlled once a request reaches the gateway
        directly. You do not need to set any of these headers manually; they are populated, or
        deliberately ignored, by the gateway&apos;s own trust-boundary logic.
      </p>

      <h2 id="webhook-headers">Webhook delivery headers</h2>
      <p>
        Outbound webhook deliveries from the gateway to your endpoint carry a different set of
        headers, including the <code>X-HMD-Signature</code> used for payload verification. Those are
        documented separately in <Link href="/docs/webhooks">Webhooks</Link> and are not part of the
        consumer request/response contract described here.
      </p>
    </article>
  );
}
