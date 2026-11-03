import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'Support',
  description:
    'How to get help with the HMD WA Gateway, what to include in a support request, and how to diagnose common issues.',
};

export default function SupportPage() {
  return (
    <article className="doc-prose">
      <h1>Support</h1>
      <p className="doc-lead">
        For issues with the API, your API key, or message delivery, email the HMD administrator.
        Including the right information up front means faster resolution.
      </p>

      <Callout type="note" title="Contact">
        Email{' '}
        <a href="mailto:security@hmddevs.org?subject=WA%20Gateway%20support">
          security@hmddevs.org
        </a>{' '}
        for all support requests. Always include the <code>X-Request-Id</code> from the failing
        response.
      </Callout>

      <h2 id="what-to-include">What to include in a support request</h2>
      <p>
        The more context you provide, the faster the issue can be diagnosed. Include the following:
      </p>
      <ul>
        <li>
          <strong>Request ID</strong>: every response from the gateway includes an{' '}
          <code>X-Request-Id</code> header. This is the single most useful piece of information for
          tracing a specific call in the server logs. Copy it from the response header or from the{' '}
          <code>requestId</code> field in the error response body.
        </li>
        <li>
          <strong>Timestamp</strong>: the time the request was made (including timezone).
        </li>
        <li>
          <strong>API key public reference</strong>: the shortened form of your key:{' '}
          <code>hmd_sk_&lt;division&gt;_&lt;env&gt;_&lt;first-8-hex&gt;</code>. Never include the
          full secret.
        </li>
        <li>
          <strong>Error code and HTTP status</strong>: the <code>code</code> field from the error
          response (for example <code>SCOPE_DENIED</code>, <code>WORKER_UNAVAILABLE</code>) and the
          HTTP status code.
        </li>
        <li>
          <strong>What you expected</strong> and <strong>what actually happened</strong>.
        </li>
      </ul>

      <h2 id="error-envelope">Error response shape</h2>
      <p>
        All non-2xx responses from the gateway use the same flat envelope. Always match on{' '}
        <code>code</code>; the <code>error</code> message string may change without notice.
      </p>
      <CodeBlock
        code={`{
  "error": "Missing scope: send:transactional",
  "code": "SCOPE_DENIED",
  "requestId": "req_01hzn7k8v2m3p4q5r6s7t8u9vw"
}`}
        lang="json"
        title="Error response"
      />
      <ul>
        <li>
          <code>error</code>: human-readable description. Do not match on this string
          programmatically; it may change.
        </li>
        <li>
          <code>code</code>: stable machine-readable identifier. Always match on this.
        </li>
        <li>
          <code>requestId</code>: unique identifier for this request, identical to the{' '}
          <code>X-Request-Id</code> response header.
        </li>
        <li>
          <code>details</code> (optional): structured context provided for certain errors.
        </li>
      </ul>
      <p>
        The complete catalogue of error codes is on the <Link href="/docs/errors">Errors</Link>{' '}
        reference page.
      </p>

      <h2 id="self-diagnosis">Self-diagnosis</h2>
      <p>Before raising a support request, check the following:</p>

      <h3 id="session-status">Check the session status</h3>
      <p>
        If you are receiving <code>503 WORKER_UNAVAILABLE</code> errors, the session may be offline
        or in a pairing state. If your key has the <code>read:status</code> scope, query the session
        status directly:
      </p>
      <CodeBlock
        code={`curl https://wa.example.com/v1/worker/status \\
  -H "Authorization: Bearer \${HMD_WA_API_KEY}"`}
        lang="bash"
        title="Check session status"
      />
      <p>
        The response will include a <code>status</code> field. Only <code>connected</code> accepts
        new sends. See the <Link href="/docs/endpoints/status">Session status</Link> reference for
        the full list of state values and what each means.
      </p>

      <h3 id="health-check">Check the gateway health endpoint</h3>
      <p>
        The public health endpoint does not require authentication and confirms the gateway process
        is running:
      </p>
      <CodeBlock code={`curl https://wa.example.com/api/health`} lang="bash" title="Health check" />
      <p>
        A healthy response returns <code>200</code> with <code>{`{ "ok": true }`}</code>. If this
        endpoint is unreachable, the issue is likely network connectivity or a gateway outage rather
        than an API configuration problem. See the <Link href="/docs/endpoints/health">Health</Link>{' '}
        reference.
      </p>

      <h3 id="authentication-issues">Authentication issues</h3>
      <p>
        If you are receiving <code>401 UNAUTHORIZED</code>, verify that the{' '}
        <code>Authorization</code> header is formatted correctly:
      </p>
      <CodeBlock
        code="Authorization: Bearer hmd_sk_developments_live_…"
        lang="http"
        title="Correct Authorization header"
      />
      <p>
        Common mistakes include including extra whitespace, using the public reference form (ending
        in 8 hex chars) instead of the full secret, or sending the key as a query parameter rather
        than a header.
      </p>
      <p>
        If the key was recently rotated or you believe it may have been revoked, email{' '}
        <a href="mailto:security@hmddevs.org?subject=WA%20Gateway%20key%20issue">
          security@hmddevs.org
        </a>
        .
      </p>
    </article>
  );
}
