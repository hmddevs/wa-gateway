import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';
import { Endpoint } from '@/components/docs/endpoint';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Health',
  description:
    'Public liveness check for the HMD WA Gateway. No authentication required. GET /api/health.',
};

export default function HealthPage() {
  return (
    <article className="doc-prose">
      <h1>Health</h1>
      <p className="doc-lead">
        A public liveness endpoint that confirms the gateway process is running and able to accept
        requests. No authentication is required and no data stores are touched.
      </p>

      <Callout type="note" title="Liveness only, not session status">
        This endpoint reports whether the gateway HTTP process is up. It does not reflect the state
        of your WhatsApp session or your ability to send messages. For that, use{' '}
        <Link href="/docs/endpoints/status">Session status</Link> (
        <code>GET /v1/worker/status</code>).
      </Callout>

      <Endpoint method="GET" path="/api/health" />

      <h2 id="authentication">Authentication</h2>
      <p>
        None. This endpoint is public. No <code>Authorization</code> header is required or expected.
      </p>

      <h2 id="response-shape">Response shape</h2>
      <p>
        Returns <code>200 OK</code> with a fixed JSON body.
      </p>

      <CodeBlock
        lang="json"
        title="200 OK"
        code={`{
  "ok": true,
  "service": "hmd-wa-gateway",
  "time": "2026-06-24T12:34:56.789Z"
}`}
      />

      <h2 id="response-fields">Response fields</h2>
      <ParamTable
        rows={[
          {
            name: 'ok',
            type: 'boolean',
            description: 'Always true when the gateway is running and accepting requests.',
          },
          {
            name: 'service',
            type: 'string',
            description: 'Fixed service identifier: hmd-wa-gateway.',
          },
          {
            name: 'time',
            type: 'string (ISO 8601)',
            description: 'Current UTC timestamp at the moment the request was processed.',
          },
        ]}
      />

      <h2 id="usage">Typical usage</h2>
      <p>
        Use this endpoint for uptime monitoring, load balancer health checks, and CI smoke tests. It
        is safe to poll frequently; the endpoint has negligible cost and no side effects.
      </p>

      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl https://wa.example.com/api/health`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `const res = await fetch('https://wa.example.com/api/health');

if (!res.ok) {
  throw new Error(\`Unexpected status \${res.status}\`);
}

const { ok, service, time } = await res.json();

if (!ok) {
  throw new Error(\`Gateway unhealthy at \${time}\`);
}

console.log(\`\${service} is up at \${time}\`);`,
          },
          {
            label: 'Python',
            lang: 'python',
            code: `import httpx

resp = httpx.get("https://wa.example.com/api/health")
resp.raise_for_status()

data = resp.json()
print(data["service"], "is up at", data["time"])`,
          },
        ]}
      />

      <h2 id="status-codes">Status codes</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>200</td>
              <td>Gateway is running and accepting requests.</td>
            </tr>
            <tr>
              <td>503</td>
              <td>
                Gateway is in maintenance mode. The response body may include{' '}
                <code>{'{ "code": "MAINTENANCE" }'}</code>.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Callout type="tip" title="Session health is separate">
        A <code>200</code> from <code>/api/health</code> does not mean your WhatsApp session is
        ready to send messages. Check <Link href="/docs/endpoints/status">Session status</Link> (
        <code>GET /v1/worker/status</code>) to verify the session is <code>connected</code>.
      </Callout>
    </article>
  );
}
