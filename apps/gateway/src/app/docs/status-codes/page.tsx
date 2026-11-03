import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'HTTP status codes',
  description:
    'Every HTTP status code the HMD WA Gateway API returns, with the exact conditions that trigger each one.',
};

export default function StatusCodesPage() {
  return (
    <article className="doc-prose">
      <h1>HTTP status codes</h1>
      <p className="doc-lead">
        The gateway uses a small, consistent set of HTTP status codes. This page defines exactly
        when each code is returned. For the machine-readable error codes carried in the response
        body alongside these statuses, see <Link href="/docs/errors">Error codes</Link>.
      </p>

      <Callout type="note" title="Branch on the body code, not the status">
        HTTP status codes tell you the broad outcome category. For programmatic error handling,
        always match on the <code>code</code> field in the response body; the human-readable{' '}
        <code>error</code> string may change without notice. See{' '}
        <Link href="/docs/errors">Error codes</Link>.
      </Callout>

      <h2 id="status-table">Complete status code reference</h2>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>When it occurs</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>200</strong>
              </td>
              <td>OK</td>
              <td>
                Returned in two cases: (1) a synchronous confirm request (<code>confirm: true</code>
                ) completed and the gateway has a terminal status to return; (2) an idempotent
                replay where a prior request with the same <code>idempotencyKey</code> already
                succeeded. In both cases the body contains a full result including{' '}
                <code>requestId</code>. Note that a confirm timeout does not return a non-2xx code;
                it returns <code>200</code> with <code>status: &apos;queued&apos;</code>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>202</strong>
              </td>
              <td>Accepted</td>
              <td>
                The standard success code for write operations. The gateway accepted the request,
                persisted it, and enqueued it for asynchronous delivery. The response body contains{' '}
                <code>messageId</code> and <code>status: &apos;queued&apos;</code> for immediate
                sends, or <code>status: &apos;scheduled&apos;</code> with a{' '}
                <code>scheduledFor</code> timestamp when <code>sendAt</code> was supplied.
              </td>
            </tr>
            <tr>
              <td>
                <strong>400</strong>
              </td>
              <td>Bad Request</td>
              <td>
                The request body could not be parsed as valid JSON, a required field is absent, a
                field value fails schema validation, or the phone number in <code>to</code> could
                not be normalised to E.164. Body codes: <code>INVALID_BODY</code>,{' '}
                <code>INVALID_PHONE</code>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>401</strong>
              </td>
              <td>Unauthorised</td>
              <td>
                No <code>Authorization</code> header was supplied, the header does not use the{' '}
                <code>Bearer</code> scheme, the token is malformed, or the key has been revoked or
                does not exist. Body code: <code>UNAUTHORIZED</code>. Authenticated requests that
                are denied due to scope or IP return <code>403</code>, not <code>401</code>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>403</strong>
              </td>
              <td>Forbidden</td>
              <td>
                The API key is valid and recognised, but access is denied for one of two reasons:
                the key lacks the scope required by the endpoint and channel combination (
                <code>SCOPE_DENIED</code>), or the request originated from an IP address not in the
                key&apos;s CIDR allowlist (<code>IP_NOT_ALLOWED</code>).
              </td>
            </tr>
            <tr>
              <td>
                <strong>404</strong>
              </td>
              <td>Not Found</td>
              <td>
                A referenced resource does not exist or does not belong to this API key&apos;s
                session. Occurs when <code>replyTo.messageId</code> targets a message that does not
                exist or belongs to a different session (<code>RECIPIENT_NOT_FOUND</code>), or when{' '}
                <code>GET /v1/messages/:id</code> is called with an ID that cannot be found (
                <code>INVALID_BODY</code>).
              </td>
            </tr>
            <tr>
              <td>
                <strong>409</strong>
              </td>
              <td>Conflict</td>
              <td>
                Reserved for an idempotency conflict (the same <code>idempotencyKey</code> submitted
                with a different request body), body code <code>IDEMPOTENCY_CONFLICT</code>. Not
                currently enforced on <code>POST /v1/messages</code>: a replay of an{' '}
                <code>idempotencyKey</code> always returns the original result with{' '}
                <code>idempotent: true</code>, even if the request body differs. Choose a key that
                is unique per logical operation to avoid relying on this.
              </td>
            </tr>
            <tr>
              <td>
                <strong>413</strong>
              </td>
              <td>Content Too Large</td>
              <td>
                The request body exceeded the 64 KiB limit. Body code:{' '}
                <code>PAYLOAD_TOO_LARGE</code>. Reduce the body size; message text bodies are capped
                at 4 096 characters and caption fields at 1 024 characters, so hitting 64 KiB in
                practice indicates an unexpectedly large payload structure.
              </td>
            </tr>
            <tr>
              <td>
                <strong>415</strong>
              </td>
              <td>Unsupported Media Type</td>
              <td>
                The <code>Content-Type</code> request header was missing or was not{' '}
                <code>application/json</code>. Set the header to{' '}
                <code>application/json; charset=utf-8</code> on all write requests. Note: the
                gateway does not currently enforce a content-type guard, so this status is not
                actively returned.
              </td>
            </tr>
            <tr>
              <td>
                <strong>422</strong>
              </td>
              <td>Unprocessable Entity</td>
              <td>
                The request is structurally valid JSON but violates a business logic constraint.
                Examples: <code>sendAt</code> is in the past or more than 30 days ahead (
                <code>SEND_AT_PAST</code>); <code>sendAt</code> combined with{' '}
                <code>confirm: true</code> or <code>replyTo</code> (<code>INVALID_BODY</code>);
                recipient is on the opt-out registry (<code>OPTED_OUT</code>); reaction emoji is
                invalid or the target message has not yet been sent (<code>INVALID_REACTION</code>).
              </td>
            </tr>
            <tr>
              <td>
                <strong>429</strong>
              </td>
              <td>Too Many Requests</td>
              <td>
                One of three rate-limit tiers was exceeded or the per-recipient cap was reached. The
                only code currently returned on a <code>429</code> is <code>RATE_LIMITED</code>{' '}
                (global, per-key, per-IP, or per-recipient cap exceeded). Two additional codes are
                defined in the protocol but not currently emitted: <code>VELOCITY_EXCEEDED</code>{' '}
                and <code>NEW_RECIPIENT_BLOCKED</code>. The gateway does not return a{' '}
                <code>Retry-After</code> header; apply exponential backoff with jitter. See{' '}
                <Link href="/docs/rate-limits">Rate limits</Link>.
              </td>
            </tr>
            <tr>
              <td>
                <strong>500</strong>
              </td>
              <td>Internal Server Error</td>
              <td>
                An unhandled error occurred inside the gateway. The response body always contains a{' '}
                <code>requestId</code>; quote it when raising a support ticket. Body code:{' '}
                <code>INTERNAL</code>. These are transient in most cases and safe to retry with
                exponential backoff.
              </td>
            </tr>
            <tr>
              <td>
                <strong>503</strong>
              </td>
              <td>Service Unavailable</td>
              <td>
                The WhatsApp session is not currently connected. The bound session (or, for an
                organization key, none of its numbers) is offline, mid-pairing, or manually stopped.
                Body code: <code>WORKER_UNAVAILABLE</code>. Scheduled messages are not affected;
                they are parked and dispatched once the session reconnects, subject to their{' '}
                <code>ttlSeconds</code>. For live sends, retry after a delay.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="success-status-summary">Success status summary</h2>
      <p>The two success statuses have distinct semantics:</p>
      <ul>
        <li>
          <strong>202</strong>: the request was accepted and enqueued. Delivery is asynchronous.
          Subscribe to webhooks or poll <code>GET /v1/messages/:id</code> to track the outcome.
        </li>
        <li>
          <strong>200</strong>: either a synchronous confirm result (delivery outcome known before
          the response was returned) or an idempotent replay (the operation was not re-executed).
        </li>
      </ul>
      <p>
        Do not treat <code>202</code> as a lower-confidence success than <code>200</code>. It means
        the gateway accepted responsibility for the message; the difference is only in when the
        outcome is known.
      </p>

      <h2 id="retry-guidance">Retry guidance by status</h2>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Safe to retry?</th>
              <th>Strategy</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>200, 202</td>
              <td>Only with an idempotency key</td>
              <td>
                Retrying a successful request without an idempotency key creates a duplicate
                message. Always supply <code>idempotencyKey</code> on any request you may retry. See{' '}
                <Link href="/docs/idempotency">Idempotency</Link>.
              </td>
            </tr>
            <tr>
              <td>400, 415, 422</td>
              <td>No</td>
              <td>
                These are client errors; retrying the same request will produce the same result. Fix
                the request body or headers before retrying.
              </td>
            </tr>
            <tr>
              <td>401</td>
              <td>Only after fixing the key</td>
              <td>
                Verify the <code>Authorization</code> header format and that the key has not been
                revoked.
              </td>
            </tr>
            <tr>
              <td>403</td>
              <td>No</td>
              <td>
                Scope or IP restriction; retrying with the same key will not help. Use a key with
                the correct scope, or update the CIDR allowlist.
              </td>
            </tr>
            <tr>
              <td>404</td>
              <td>No</td>
              <td>
                The referenced resource does not exist. Correct the identifier in the request.
              </td>
            </tr>
            <tr>
              <td>409</td>
              <td>No</td>
              <td>
                Idempotency key reuse across different request bodies. Use a distinct key for each
                unique operation.
              </td>
            </tr>
            <tr>
              <td>413</td>
              <td>No</td>
              <td>Reduce the request body size below 64 KiB.</td>
            </tr>
            <tr>
              <td>429</td>
              <td>Yes, with back-off</td>
              <td>
                Exponential back-off with jitter. Start at 1 second, double on each retry, cap at 60
                seconds. See <Link href="/docs/rate-limits">Rate limits</Link>.
              </td>
            </tr>
            <tr>
              <td>500</td>
              <td>Yes, with back-off</td>
              <td>
                Typically transient. Retry with exponential back-off; include the{' '}
                <code>idempotencyKey</code> to prevent duplicates if the request had side effects.
              </td>
            </tr>
            <tr>
              <td>503</td>
              <td>Yes, with back-off</td>
              <td>
                Session temporarily unavailable. Retry after a delay; the session will reconnect
                automatically in most cases.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="error-body-shape">Error body shape</h2>
      <p>Every non-2xx response uses the same flat JSON envelope:</p>
      <CodeBlock
        lang="json"
        title="Error envelope"
        code={`{
  "error": "Human-readable description of what went wrong.",
  "code": "MACHINE_READABLE_CODE",
  "requestId": "req_8e8f3a26-0c47-4f3e-85cd-123456789abc"
}`}
      />
      <p>
        Branch on <code>code</code> in your error-handling logic, not on <code>error</code> or on
        the HTTP status alone. For the complete list of machine-readable codes and their
        descriptions, see <Link href="/docs/errors">Error codes</Link>.
      </p>
    </article>
  );
}
