import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';

export const metadata: Metadata = {
  title: 'Scopes',
  description:
    'The six API key scopes for HMD WA Gateway: what each grants, which endpoints require it, and how scope violations are reported.',
};

export default function ScopesPage() {
  return (
    <article className="doc-prose">
      <h1>Scopes</h1>
      <p className="doc-lead">
        Every API key carries a set of scopes that declare what it is permitted to do. The gateway
        enforces these on every request; a missing scope returns <code>403 SCOPE_DENIED</code>{' '}
        immediately, before any business logic runs.
      </p>

      <h2 id="overview">The six scopes</h2>
      <p>
        There are six scopes in total. Four govern outbound sends; two govern read access. Scopes
        are assigned when a key is created and cannot be changed without rotating the key.
      </p>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>What it grants</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>send:notification</code>
              </td>
              <td>
                Send outbound messages on the <code>notification</code> channel. Intended for
                user-facing alerts, reminders, and announcements that are not transactional in
                nature (for example: shipping updates, appointment reminders, promotional
                notifications).
              </td>
            </tr>
            <tr>
              <td>
                <code>send:transactional</code>
              </td>
              <td>
                Send outbound messages on the <code>transactional</code> channel (the default
                channel). Covers OTPs, magic links, order confirmations, password resets, and any
                message triggered directly by a user action. Also required for reactions (set and
                clear) and presence updates.
              </td>
            </tr>
            <tr>
              <td>
                <code>send:internal</code>
              </td>
              <td>
                Send outbound messages on the <code>internal</code> channel. Intended for
                machine-to-machine alerts, ops notifications, and system health messages directed at
                internal recipients rather than customers.
              </td>
            </tr>
            <tr>
              <td>
                <code>send:new_recipients</code>
              </td>
              <td>
                Reserved for a future new-recipient consent gate. The scope exists in the schema and
                can be assigned to a key, but it is <strong>not currently enforced</strong> by any
                endpoint: sending to a number the session has never messaged before requires only
                the relevant channel scope. See{' '}
                <Link href="/docs/rate-limits#related-429-codes">
                  Rate limits: reserved 429 codes
                </Link>
                .
              </td>
            </tr>
            <tr>
              <td>
                <code>read:status</code>
              </td>
              <td>
                Query session connection state via <code>GET /v1/worker/status</code>. This scope
                carries no write capability. Note that <code>GET /v1/messages</code> and{' '}
                <code>GET /v1/messages/:id</code> require no scope at all: any valid key can read
                its own message history.
              </td>
            </tr>
            <tr>
              <td>
                <code>read:groups</code>
              </td>
              <td>
                Discover the WhatsApp group JIDs the bound session belongs to via{' '}
                <code>GET /v1/groups</code>, so a group JID can be passed as <code>to</code> on{' '}
                <code>POST /v1/messages</code>. This scope carries no write capability.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="scope-mapping">Scope-to-endpoint mapping</h2>
      <p>
        The table below shows which scope is checked for each endpoint. A key must hold the listed
        scope; additional scopes on the key are ignored for that check.
      </p>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Endpoint(s)</th>
              <th>Condition</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>send:notification</code>
              </td>
              <td>
                <code>POST /v1/messages</code>
              </td>
              <td>
                When <code>channel</code> is <code>notification</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>send:transactional</code>
              </td>
              <td>
                <code>POST /v1/messages</code>, <code>POST /v1/messages/:id/reactions</code>,{' '}
                <code>DELETE /v1/messages/:id/reactions</code>,{' '}
                <code>POST /v1/sessions/:sessionId/presence</code>
              </td>
              <td>
                For messages: when <code>channel</code> is <code>transactional</code> or omitted
                (default). Always required for reactions and presence.
              </td>
            </tr>
            <tr>
              <td>
                <code>send:internal</code>
              </td>
              <td>
                <code>POST /v1/messages</code>
              </td>
              <td>
                When <code>channel</code> is <code>internal</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>send:new_recipients</code>
              </td>
              <td>None</td>
              <td>
                Reserved for future use. No endpoint currently checks this scope; sending to a new
                recipient only requires the relevant channel scope.
              </td>
            </tr>
            <tr>
              <td>
                <code>read:status</code>
              </td>
              <td>
                <code>GET /v1/worker/status</code>
              </td>
              <td>
                Always required for this endpoint. <code>GET /v1/messages</code> and{' '}
                <code>GET /v1/messages/:id</code> require no scope at all.
              </td>
            </tr>
            <tr>
              <td>
                <code>read:groups</code>
              </td>
              <td>
                <code>GET /v1/groups</code>
              </td>
              <td>Always required for this endpoint.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="note" title="Health check is public">
        <code>GET /api/health</code> requires no authentication and carries no scope check. It is
        safe to call from monitoring systems without an API key.
      </Callout>

      <Callout type="note" title="send:new_recipients is reserved, not enforced">
        <code>send:new_recipients</code> and the corresponding{' '}
        <code>429 NEW_RECIPIENT_BLOCKED</code> error code are both defined but not wired up to any
        route today. A key with only a channel scope (for example <code>send:transactional</code>)
        can already send to a phone number the session has never messaged before. Do not build a
        consent-gate integration around this scope until it is confirmed live. See{' '}
        <Link href="/docs/rate-limits#related-429-codes">Rate limits: reserved 429 codes</Link> for
        the current status.
      </Callout>

      <h2 id="scope-errors">Scope error reference</h2>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>SCOPE_DENIED</code>
              </td>
              <td>403</td>
              <td>
                The key is valid but does not hold the scope required by this endpoint and channel
                combination.
              </td>
            </tr>
            <tr>
              <td>
                <code>IP_NOT_ALLOWED</code>
              </td>
              <td>403</td>
              <td>
                The key is valid and has the correct scope, but the request originated from an IP
                address outside the key&apos;s CIDR allowlist.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        See <Link href="/docs/errors">Error codes</Link> for the complete catalogue of all
        machine-readable codes the API returns. For an explanation of how <code>channel</code>,{' '}
        <code>purpose</code>, and the <code>category</code> webhook field relate to one another, see{' '}
        <Link href="/docs/concepts#purpose">Core concepts: purpose field</Link>.
      </p>

      <h2 id="key-design">Designing keys for least privilege</h2>
      <p>Issue one key per service with only the scopes that service genuinely needs:</p>
      <ul>
        <li>
          An OTP or magic-link service needs <code>send:transactional</code> only.
        </li>
        <li>
          A notification or campaign service needs <code>send:notification</code>.
        </li>
        <li>
          An internal alerting daemon needs <code>send:internal</code>.
        </li>
        <li>
          A dashboard that only checks session connectivity needs <code>read:status</code> only; it
          should hold no send scope at all. A dashboard that only reads its own message history
          needs no scope at all: <code>GET /v1/messages</code> and <code>GET /v1/messages/:id</code>{' '}
          enforce none.
        </li>
      </ul>
      <p>
        See <Link href="/docs/authentication">Authentication</Link> for key creation, rotation, and
        CIDR allowlist configuration.
      </p>
    </article>
  );
}
