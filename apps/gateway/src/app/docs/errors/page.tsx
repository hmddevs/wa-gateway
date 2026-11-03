import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'Errors',
  description:
    'The error envelope shape and a complete reference of every error code the gateway can return.',
};

export default function ErrorsPage() {
  return (
    <article className="doc-prose">
      <h1>Errors</h1>
      <p className="doc-lead">
        All non-2xx responses share a flat JSON envelope with a stable machine-readable{' '}
        <code>code</code>. Always branch on <code>code</code>, never on the human-readable{' '}
        <code>error</code> message.
      </p>

      <h2 id="error-envelope">Error envelope</h2>
      <p>Every error response has this shape:</p>

      <CodeBlock
        lang="json"
        title="Error envelope"
        code={`{
  "error": "Missing scope: send:transactional",
  "code": "SCOPE_DENIED",
  "requestId": "req_01hx7rk9p3fq4m8n5j6t2w0v1b"
}`}
      />

      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-semibold">Field</th>
              <th className="px-4 py-2.5 font-semibold">Type</th>
              <th className="px-4 py-2.5 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">
                <code>error</code>
              </td>
              <td className="px-4 py-2.5">string</td>
              <td className="px-4 py-2.5">
                Human-readable description. May change between releases; do not match on this.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">
                <code>code</code>
              </td>
              <td className="px-4 py-2.5">string</td>
              <td className="px-4 py-2.5">
                Stable machine-readable identifier. Always match on this. See the table below.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">
                <code>requestId</code>
              </td>
              <td className="px-4 py-2.5">string</td>
              <td className="px-4 py-2.5">
                Present in every error and echoed in the <code>X-Request-Id</code> response header.
                Quote this when raising a support ticket.
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5">
                <code>details</code>
              </td>
              <td className="px-4 py-2.5">object (optional)</td>
              <td className="px-4 py-2.5">
                Structured context included on certain validation errors.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="note" title="Match on code, not on error">
        The <code>error</code> string is a hint for human readers and may be rephrased at any time.
        Your code must always branch on <code>code</code>.
      </Callout>

      <h2 id="error-codes">Error codes reference</h2>
      <p>
        The table below lists the 21 error codes returned by this public API, grouped by HTTP
        status. Codes marked &ldquo;reserved&rdquo; are part of the contract and may be emitted in a
        future release, but are not currently returned by any gateway route. Do not build handling
        logic that depends on receiving them today.
      </p>
      <p>
        <code>packages/protocol/src/errors.ts</code> defines one further code,{' '}
        <code>NOT_FOUND</code> (404), which is used only by admin/pairing-invite routes and is never
        returned by the public endpoints documented here.
      </p>

      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-semibold">Code</th>
              <th className="px-4 py-2.5 font-semibold">HTTP</th>
              <th className="px-4 py-2.5 font-semibold">When it happens</th>
              <th className="px-4 py-2.5 font-semibold">How to resolve</th>
            </tr>
          </thead>
          <tbody>
            {/* 400 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>INVALID_PHONE</code>
              </td>
              <td className="px-4 py-2.5 align-top">400</td>
              <td className="px-4 py-2.5 align-top">
                The <code>to</code> field could not be normalised to E.164 (invalid format, missing
                country code, or digit count out of range).
              </td>
              <td className="px-4 py-2.5 align-top">
                Supply a valid E.164 number such as <code>+447700900123</code>.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>INVALID_CONTENT</code>
              </td>
              <td className="px-4 py-2.5 align-top">400</td>
              <td className="px-4 py-2.5 align-top">
                Reserved. Intended for media URL failures (SSRF guard, fetch failure, unsupported
                MIME type). Not currently emitted.
              </td>
              <td className="px-4 py-2.5 align-top">
                No action required. This code is reserved and not currently returned.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>INVALID_BODY</code>
              </td>
              <td className="px-4 py-2.5 align-top">400 / 404 / 422</td>
              <td className="px-4 py-2.5 align-top">
                The HTTP status depends on context:
                <ul className="mt-1 list-disc pl-4 space-y-1">
                  <li>
                    <strong>400</strong>, JSON parse failure, schema violation, missing required
                    field (including <code>purpose</code>), unsupported body type, or a forbidden
                    field combination (e.g. <code>sendAt</code> with <code>confirm</code>).
                  </li>
                  <li>
                    <strong>404</strong>, a path resource was not found: a missing or unrecognised{' '}
                    <code>messageId</code>, session id, or cursor. Returning 404 rather than a
                    distinct code is intentional anti-enumeration behaviour.
                  </li>
                  <li>
                    <strong>422</strong>, the request is syntactically valid but semantically
                    rejected (for example, a <code>replyTo</code> target that belongs to a different
                    session).
                  </li>
                </ul>
              </td>
              <td className="px-4 py-2.5 align-top">
                Fix the request body or path parameter; check the <code>error</code> string for
                which field failed.
              </td>
            </tr>
            {/* 401 / 403 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>UNAUTHORIZED</code>
              </td>
              <td className="px-4 py-2.5 align-top">401</td>
              <td className="px-4 py-2.5 align-top">
                Missing, malformed, revoked, or unrecognised bearer token.
              </td>
              <td className="px-4 py-2.5 align-top">
                Check the <code>Authorization: Bearer …</code> header; confirm the key has not been
                revoked.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>SCOPE_DENIED</code>
              </td>
              <td className="px-4 py-2.5 align-top">403</td>
              <td className="px-4 py-2.5 align-top">
                Key is authenticated but lacks the required scope for the operation (e.g.{' '}
                <code>send:notification</code> for the notification channel), or the{' '}
                <code>sessionId</code> in the path does not match the key&apos;s bound session.
              </td>
              <td className="px-4 py-2.5 align-top">
                Contact <a href="mailto:security@hmddevs.org">security@hmddevs.org</a> to update the
                key&apos;s scopes.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>IP_NOT_ALLOWED</code>
              </td>
              <td className="px-4 py-2.5 align-top">403</td>
              <td className="px-4 py-2.5 align-top">
                Client IP is not in the key&apos;s CIDR allowlist.
              </td>
              <td className="px-4 py-2.5 align-top">
                Update the allowlist or send from a permitted IP.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>WEBAUTHN_REQUIRED</code>
              </td>
              <td className="px-4 py-2.5 align-top">403</td>
              <td className="px-4 py-2.5 align-top">
                Reserved. Intended for admin step-up flows. Not currently emitted on any route,
                including admin routes.
              </td>
              <td className="px-4 py-2.5 align-top">
                No action required. This code is reserved and not currently returned.
              </td>
            </tr>
            {/* 404 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>RECIPIENT_NOT_FOUND</code>
              </td>
              <td className="px-4 py-2.5 align-top">404</td>
              <td className="px-4 py-2.5 align-top">
                A <code>replyTo</code> target or reaction target is unknown to this session, or
                belongs to a different session.
              </td>
              <td className="px-4 py-2.5 align-top">
                Verify the <code>messageId</code> is from the same session.
              </td>
            </tr>
            {/* 409 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>IDEMPOTENCY_CONFLICT</code>
              </td>
              <td className="px-4 py-2.5 align-top">409</td>
              <td className="px-4 py-2.5 align-top">
                The same <code>idempotencyKey</code> was reused with a different request body.
                Currently reserved; not yet enforced.
              </td>
              <td className="px-4 py-2.5 align-top">
                Use a different <code>idempotencyKey</code>, or resubmit the original body. See{' '}
                <Link href="/docs/idempotency">Idempotency</Link>.
              </td>
            </tr>
            {/* 413 / 415 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>PAYLOAD_TOO_LARGE</code>
              </td>
              <td className="px-4 py-2.5 align-top">413</td>
              <td className="px-4 py-2.5 align-top">Request body exceeded the 64 KiB limit.</td>
              <td className="px-4 py-2.5 align-top">
                Reduce the body size; reference large assets by URL rather than embedding them.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>UNSUPPORTED_MEDIA_TYPE</code>
              </td>
              <td className="px-4 py-2.5 align-top">415</td>
              <td className="px-4 py-2.5 align-top">
                Reserved. Intended for wrong <code>Content-Type</code> rejections. Not currently
                emitted; the gateway does not enforce a content-type guard at this time.
              </td>
              <td className="px-4 py-2.5 align-top">
                Send <code>Content-Type: application/json</code> as a matter of good practice, but
                this code will not be returned today.
              </td>
            </tr>
            {/* 422 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>INVALID_REACTION</code>
              </td>
              <td className="px-4 py-2.5 align-top">422</td>
              <td className="px-4 py-2.5 align-top">
                Reaction emoji fails validation (empty string on POST, non-emoji string), or the
                target message has not yet been sent (still queued).
              </td>
              <td className="px-4 py-2.5 align-top">
                Supply a valid Unicode emoji and ensure the target message has reached{' '}
                <code>sent</code> status.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>INVALID_PRESENCE_STATE</code>
              </td>
              <td className="px-4 py-2.5 align-top">422</td>
              <td className="px-4 py-2.5 align-top">
                Presence <code>state</code> value is not one of the allowed enum members.
              </td>
              <td className="px-4 py-2.5 align-top">
                Use one of <code>available</code>, <code>unavailable</code>, <code>composing</code>,{' '}
                <code>recording</code>, or <code>paused</code>.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>SEND_AT_PAST</code>
              </td>
              <td className="px-4 py-2.5 align-top">422</td>
              <td className="px-4 py-2.5 align-top">
                <code>sendAt</code> is in the past, less than 30 seconds in the future, or more than
                30 days away.
              </td>
              <td className="px-4 py-2.5 align-top">
                Supply a <code>sendAt</code> value between 30 seconds and 30 days from now.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>OPTED_OUT</code>
              </td>
              <td className="px-4 py-2.5 align-top">422</td>
              <td className="px-4 py-2.5 align-top">
                Recipient is on this session&apos;s opt-out registry. The message is not enqueued.
              </td>
              <td className="px-4 py-2.5 align-top">
                Do not send to this contact. See <Link href="/docs/opt-outs">Opt-outs</Link> for
                managing the registry.
              </td>
            </tr>
            {/* 429 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>RATE_LIMITED</code>
              </td>
              <td className="px-4 py-2.5 align-top">429</td>
              <td className="px-4 py-2.5 align-top">
                One of the three rate-limit tiers was exceeded: global (10,000/min), per-IP
                (300/min), or per-key (default 60/min, configured at key issuance). Also returned
                when the per-recipient cap (5 sends per 10 minutes) is breached.
              </td>
              <td className="px-4 py-2.5 align-top">
                Back off and retry with exponential backoff. See{' '}
                <Link href="/docs/rate-limits">Rate limits</Link> for the authoritative tier
                breakdown, the per-recipient cap, and the reserved 429 codes below.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>VELOCITY_EXCEEDED</code>
              </td>
              <td className="px-4 py-2.5 align-top">429</td>
              <td className="px-4 py-2.5 align-top">
                Reserved. Intended for a per-recipient burst guard distinct from the 5/10-min cap.
                Not currently emitted. The only active per-recipient mechanism returns{' '}
                <code>RATE_LIMITED</code>. See{' '}
                <Link href="/docs/rate-limits#related-429-codes">Rate limits: reserved codes</Link>.
              </td>
              <td className="px-4 py-2.5 align-top">
                No action required. This code is reserved and not currently returned.
              </td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>NEW_RECIPIENT_BLOCKED</code>
              </td>
              <td className="px-4 py-2.5 align-top">429</td>
              <td className="px-4 py-2.5 align-top">
                Reserved. Intended for a new-recipient consent gate. Not currently emitted; the gate
                was removed and this code is not returned by any route. See{' '}
                <Link href="/docs/rate-limits#related-429-codes">Rate limits: reserved codes</Link>.
              </td>
              <td className="px-4 py-2.5 align-top">
                No action required. This code is reserved and not currently returned.
              </td>
            </tr>
            {/* 500 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>INTERNAL</code>
              </td>
              <td className="px-4 py-2.5 align-top">500</td>
              <td className="px-4 py-2.5 align-top">
                Unhandled server error. The request reached the gateway but failed in an unexpected
                way.
              </td>
              <td className="px-4 py-2.5 align-top">
                Quote the <code>requestId</code> and approximate timestamp in a support ticket to{' '}
                <a href="mailto:security@hmddevs.org">security@hmddevs.org</a>.
              </td>
            </tr>
            {/* 503 */}
            <tr className="border-b border-border">
              <td className="px-4 py-2.5 align-top">
                <code>WORKER_UNAVAILABLE</code>
              </td>
              <td className="px-4 py-2.5 align-top">503</td>
              <td className="px-4 py-2.5 align-top">
                The bound session (or, for an organization key, none of its numbers) is not
                currently connected. The session is offline, mid-pairing, or has been stopped.
              </td>
              <td className="px-4 py-2.5 align-top">
                Check <Link href="/docs/endpoints/status">Session status</Link>. Fall back to an
                alternative channel or retry once the session comes online.
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5 align-top">
                <code>MAINTENANCE</code>
              </td>
              <td className="px-4 py-2.5 align-top">503</td>
              <td className="px-4 py-2.5 align-top">
                Reserved. Intended for gateway maintenance mode. Not currently emitted.
              </td>
              <td className="px-4 py-2.5 align-top">
                No action required. This code is reserved and not currently returned.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="handling-errors">Handling errors in code</h2>
      <p>
        Branch on <code>code</code>, not on HTTP status alone. Some codes share a status: for
        example, <code>INVALID_BODY</code> appears on 400, 404, and 422 depending on context. Parse
        the response JSON and switch on <code>code</code>; log the <code>requestId</code> alongside
        your own trace context for every error path.
      </p>

      <CodeBlock
        lang="typescript"
        title="Branching on code (fetch)"
        code={`const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ to, purpose, body }),
});

if (!res.ok) {
  const err = await res.json();
  switch (err.code) {
    case 'OPTED_OUT':
      // Recipient has unsubscribed; do not retry
      await markContactOptedOut(to);
      break;
    case 'RATE_LIMITED':
      // Transient; back off and retry
      logger.warn({ code: err.code, requestId: err.requestId });
      break;
    case 'WORKER_UNAVAILABLE':
      // Session is offline; fall back to another channel
      await sendViaSMS(to, message);
      break;
    default:
      // Unexpected; log requestId for support
      logger.error({ code: err.code, requestId: err.requestId });
      throw new Error(err.code);
  }
}`}
      />

      <Callout type="note" title="Always log requestId">
        Every error includes a <code>requestId</code>. Log it alongside your own trace context. When
        reporting an issue to <a href="mailto:security@hmddevs.org">security@hmddevs.org</a>,
        providing the <code>requestId</code> and approximate timestamp dramatically reduces
        diagnosis time.
      </Callout>
    </article>
  );
}
