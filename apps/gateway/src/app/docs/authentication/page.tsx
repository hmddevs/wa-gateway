import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Authentication',
  description:
    'How to authenticate with the HMD WA Gateway using Bearer tokens, key formats, scopes, and IP allowlists.',
};

export default function AuthenticationPage() {
  return (
    <article className="doc-prose">
      <h1>Authentication</h1>
      <p className="doc-lead">
        Every request to the HMD WA Gateway is authenticated with a Bearer token. Keys are issued by
        the HMD administrator and carry scopes, an optional IP allowlist, and a binding to a
        specific WhatsApp session.
      </p>

      <h2 id="bearer-token">Bearer token</h2>
      <p>
        Include your API key in the <code>Authorization</code> header on every request:
      </p>
      <CodeBlock
        code="Authorization: Bearer hmd_sk_developments_live_…"
        lang="http"
        title="Authorization header"
      />
      <p>
        All consumer endpoints require this header. Requests without it, or with a malformed or
        revoked token, receive <code>401 UNAUTHORIZED</code>.
      </p>

      <h2 id="authenticated-request-example">Authenticated request</h2>
      <p>A complete authenticated send looks like this:</p>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl -X POST https://wa.example.com/v1/messages \\
  -H "Authorization: Bearer \${HMD_WA_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+447700900123",
    "purpose": "transactional",
    "body": { "kind": "text", "text": "Hello from the gateway." }
  }'`,
          },
          {
            label: 'JavaScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.HMD_WA_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: '+447700900123',
    purpose: 'transactional',
    body: { kind: 'text', text: 'Hello from the gateway.' },
  }),
});`,
          },
        ]}
      />

      <Callout type="security" title="Never expose your key client-side">
        API keys carry scopes that allow sending messages. Never include a key in browser
        JavaScript, a mobile app bundle, or any public-facing resource. Store keys in environment
        variables or a secrets manager, and make calls server-side only.
      </Callout>

      <h2 id="key-format">Key format</h2>
      <p>Keys follow a structured format that encodes the issuing division and environment:</p>
      <CodeBlock
        code="hmd_sk_<division>_<env>_<secret>"
        lang="http"
        title="Full key format (shown once at creation)"
      />
      <ParamTable
        rows={[
          {
            name: 'division',
            type: 'string',
            required: true,
            description: 'HMD division identifier, for example: developments, payments, core.',
          },
          {
            name: 'env',
            type: 'string',
            required: true,
            description: (
              <>
                <code>test</code> or <code>live</code>. Test keys work only against test sessions
                and are safe to use during development.
              </>
            ),
          },
          {
            name: 'secret',
            type: 'string',
            required: true,
            description:
              '32 random bytes, base64url-encoded, 43 characters, no padding. Generated at key creation and shown once.',
          },
        ]}
      />
      <p>
        In logs and the admin UI, keys are displayed in a shortened public reference form that
        replaces the secret with its first eight hex characters:{' '}
        <code>hmd_sk_developments_live_a1b2c3d4</code>. This form is safe to include in support
        requests.
      </p>

      <h2 id="key-issuance">Key issuance</h2>
      <p>
        Keys are <strong>admin-issued only</strong>. There is no self-service signup. To request a
        key, see <Link href="/docs/api-keys">Get an API key</Link>.
      </p>

      <h2 id="key-binding-and-scopes">Key binding and scopes</h2>
      <p>
        Every key is bound to a WhatsApp session, one or more scopes, a project, and optionally an
        IP allowlist.
      </p>

      <h3 id="session-binding">Session binding</h3>
      <p>
        All sends through a key route to the same WhatsApp phone number. You cannot choose a
        different session per message; session routing is determined by the key.
      </p>

      <h3 id="scopes">Scopes</h3>
      <p>
        Scopes gate which operations a key may perform. A request that requires a scope the key does
        not have returns <code>403 SCOPE_DENIED</code>.
      </p>
      <ParamTable
        rows={[
          {
            name: 'send:notification',
            type: 'scope',
            description: 'Send messages to the notification channel.',
          },
          {
            name: 'send:transactional',
            type: 'scope',
            description: 'Send messages to the transactional channel.',
          },
          {
            name: 'send:internal',
            type: 'scope',
            description: 'Send messages to the internal channel.',
          },
          {
            name: 'send:new_recipients',
            type: 'scope',
            description:
              'Reserved for a future new-recipient consent gate. Not currently enforced by any endpoint; sending to a number the session has not seen before only requires the relevant channel scope.',
          },
          {
            name: 'read:status',
            type: 'scope',
            description: (
              <>
                Call <code>GET /v1/worker/status</code> to query the session connection state. Does
                not gate <code>GET /v1/messages</code> or <code>GET /v1/messages/:id</code>, which
                require no scope.
              </>
            ),
          },
          {
            name: 'read:groups',
            type: 'scope',
            description: (
              <>
                Call <code>GET /v1/groups</code> to discover the WhatsApp group JIDs the bound
                session belongs to.
              </>
            ),
          },
        ]}
      />

      <h3 id="ip-allowlist">IP allowlist</h3>
      <p>
        A key may optionally be restricted to one or more CIDR (Classless Inter-Domain Routing)
        ranges, for example <code>203.0.113.0/24</code>. Requests from an IP outside the allowlist
        receive <code>403 IP_NOT_ALLOWED</code>. If no allowlist is configured, any IP may use the
        key. Specify your source IPs when requesting a key; they can be updated by the administrator
        later.
      </p>

      <h2 id="rotation">Rotation</h2>
      <p>
        To rotate a key, request a new one from the administrator and deploy it to your environment.
        Then ask the administrator to revoke the old key. The old key remains valid until
        revocation, so there is no service interruption during the switchover. No atomic swap is
        required.
      </p>
      <p>
        Contact <a href="mailto:security@hmddevs.org">security@hmddevs.org</a> to initiate a
        rotation.
      </p>

      <h2 id="authentication-errors">Authentication errors</h2>
      <p>
        The following errors are returned when authentication or authorisation fails. Always match
        on the <code>code</code> field, not the <code>error</code> message string.
      </p>
      <ParamTable
        rows={[
          {
            name: 'UNAUTHORIZED',
            type: 'HTTP 401',
            description:
              'The Authorization header is missing, malformed, revoked, or the key is not recognised. Check the header format and confirm the key has not been rotated.',
          },
          {
            name: 'SCOPE_DENIED',
            type: 'HTTP 403',
            description:
              'The key is valid but lacks the scope required for this operation. Contact the administrator to add the scope to your key.',
          },
          {
            name: 'IP_NOT_ALLOWED',
            type: 'HTTP 403',
            description:
              "The request originated from an IP address outside the key's CIDR allowlist. Ask the administrator to add your IP to the allowlist.",
          },
          {
            name: 'WEBAUTHN_REQUIRED',
            type: 'HTTP 403',
            description:
              'The requested operation is an admin endpoint that requires a WebAuthn step-up. Not applicable to consumer API calls.',
          },
        ]}
      />
      <p>
        Every error response includes a <code>requestId</code> field and a matching{' '}
        <code>X-Request-Id</code> response header. Include both when contacting support.
      </p>

      <Callout type="note" title="Rate limits">
        Authenticated requests are also subject to three fixed-window rate-limit tiers: global,
        per-IP, and per-key. Exceeding any tier returns <code>429 RATE_LIMITED</code>. See{' '}
        <Link href="/docs/rate-limits">Rate limits</Link>.
      </Callout>
    </article>
  );
}
