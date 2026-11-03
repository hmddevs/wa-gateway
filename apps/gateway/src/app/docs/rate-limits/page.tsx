import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'Rate limits',
  description:
    'How the three-tier rate-limiting system works and how to handle 429 responses safely.',
};

export default function RateLimitsPage() {
  return (
    <article className="doc-prose">
      <h1>Rate limits</h1>
      <p className="doc-lead">
        Every authenticated request passes through three independent fixed-window tiers. Exceeding
        any single tier immediately returns <code>429 RATE_LIMITED</code>. Send requests also
        enforce a per-recipient cap that returns the same code.
      </p>

      <h2 id="tiers">The three tiers</h2>
      <p>
        Tiers are evaluated in order. The first one that rejects the request wins; the remaining
        tiers are not checked.
      </p>

      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-semibold">Tier</th>
              <th className="px-4 py-2.5 font-semibold">Limit</th>
              <th className="px-4 py-2.5 font-semibold">Keyed by</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">Global</td>
              <td className="px-4 py-2.5">10,000 req/min across all clients combined</td>
              <td className="px-4 py-2.5">All requests</td>
            </tr>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">Per API key</td>
              <td className="px-4 py-2.5">
                Default 60 req/min; range 1–10,000 req/min, configured at issuance
              </td>
              <td className="px-4 py-2.5">API key ID</td>
            </tr>
            <tr>
              <td className="px-4 py-2.5">Per IP</td>
              <td className="px-4 py-2.5">1,200 req/min (default)</td>
              <td className="px-4 py-2.5">
                Client IP, derived from the configured <code>TRUSTED_CLIENT_IP_HEADER</code>, or{' '}
                <code>CF-Connecting-IP</code> only when the request is provably proxied through
                Cloudflare). <code>X-Forwarded-For</code> is never trusted for this decision: it is
                fully client-controlled.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        The per-key limit is set at key issuance. The default is <strong>60 req/min</strong>; the
        configurable range is 1 to 10,000 req/min. When the key limit is exceeded the gateway
        returns <code>429 RATE_LIMITED</code> with the same envelope as the other tiers. Contact{' '}
        <a href="mailto:security@hmddevs.org">security@hmddevs.org</a> if the default does not fit
        your send volume.
      </p>

      <h2 id="rate-limited-response">The 429 RATE_LIMITED response</h2>
      <p>
        When any tier is exceeded the gateway returns <code>429</code> with{' '}
        <code>code: &quot;RATE_LIMITED&quot;</code>. The error envelope is the same as all other
        errors:
      </p>

      <CodeBlock
        lang="json"
        title="429 RATE_LIMITED"
        code={`{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMITED",
  "requestId": "req_01hx7rk9p3fq4m8n5j6t2w0v1b"
}`}
      />

      <h2 id="headers">Rate-limit response headers</h2>
      <p>
        The gateway does <strong>not</strong> emit <code>X-RateLimit-*</code>,{' '}
        <code>X-RateLimit-Remaining</code>, or <code>Retry-After</code> headers. Remaining quota
        cannot be inspected from the response. Treat every <code>429</code> as a signal to back off
        and retry.
      </p>

      <h2 id="per-recipient-cap">Per-recipient cap (OTP-bomb protection)</h2>
      <p>
        In addition to the three throughput tiers above, <code>POST /v1/messages</code> enforces a
        per-recipient cap: at most{' '}
        <strong>5 sends to the same E.164 number within any 10-minute window</strong>. This cap is{' '}
        <strong>global across all API keys</strong>, it is keyed on the recipient number, not on the
        caller, so an attacker cannot spread a flood across multiple keys to bypass it.
      </p>
      <p>
        Its purpose is OTP-bomb / abuse protection: a legitimate send flow should never need to
        deliver more than a handful of messages to the same number in a 10-minute period. When the
        cap is breached the gateway returns <code>429 RATE_LIMITED</code> (the same code as the
        throughput tiers, not a distinct code). Scheduled sends bypass this check at enqueue time
        and are subject to it at fire time.
      </p>

      <Callout type="warning" title="Fail-closed behaviour">
        If the gateway cannot reach Redis to check the per-recipient counter, it rejects the send
        with <code>503</code> rather than allowing an unbounded flood through. A Redis outage on the
        send path returns a service-unavailable error, not a silent pass-through.
      </Callout>

      <h2 id="related-429-codes">Reserved 429 codes</h2>
      <p>
        Two additional codes are defined in the protocol and carry HTTP 429, but are not currently
        emitted by any gateway route:
      </p>

      <div className="my-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              <th className="px-4 py-2.5 font-semibold">Code</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className="px-4 py-2.5">
                <code>VELOCITY_EXCEEDED</code>
              </td>
              <td className="px-4 py-2.5">Reserved, not currently emitted</td>
              <td className="px-4 py-2.5">
                Intended for a per-recipient burst guard distinct from the 5/10-min OTP cap. The
                only active per-recipient mechanism is the cap described above, which returns{' '}
                <code>RATE_LIMITED</code>.
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2.5">
                <code>NEW_RECIPIENT_BLOCKED</code>
              </td>
              <td className="px-4 py-2.5">Reserved, not currently emitted</td>
              <td className="px-4 py-2.5">
                Intended for a new-recipient consent gate. That gate has been removed; the code is
                not returned by any route. The <code>send:new_recipients</code> scope is still
                defined but is not enforced at this time.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="backoff">Handling 429 responses: exponential backoff</h2>

      <Callout type="note" title="Use exponential backoff with jitter">
        A <code>RATE_LIMITED</code> 429 is transient. A flat-interval retry loop will simply hit the
        limit again. Exponential backoff with random jitter spreads retries and prevents
        thundering-herd effects when multiple clients back off simultaneously.
      </Callout>

      <p>
        A recommended strategy for <code>RATE_LIMITED</code>:
      </p>
      <ol>
        <li>On receiving a 429, wait an initial interval (for example, 1 second).</li>
        <li>
          On each subsequent failure, double the interval and add a random jitter of up to
          ±20&thinsp;%.
        </li>
        <li>Cap the maximum wait at a reasonable ceiling (for example, 60 seconds).</li>
        <li>After a configurable number of attempts, surface the error to the caller.</li>
      </ol>

      <Callout
        type="warning"
        title="RATE_LIMITED from the per-recipient cap is not a throughput error"
      >
        The per-recipient cap is not caused by overall request volume. It resets after 10 minutes;
        retrying immediately will not help. Back off and retry after the window has elapsed.
      </Callout>

      <p>
        See the <Link href="/docs/errors">Error codes reference</Link> for the full error catalogue
        and how to branch on <code>code</code>.
      </p>
    </article>
  );
}
