import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'OpenAPI specification',
  description:
    'Download the OpenAPI 3.1 specification for the HMD WA Gateway public consumer API and import it into your tooling.',
};

export default function OpenApiPage() {
  return (
    <article className="doc-prose">
      <h1>OpenAPI specification</h1>
      <p className="doc-lead">
        The HMD WA Gateway publishes a machine-readable OpenAPI 3.1 description of its public
        consumer API. Use it to generate clients, drive request validation, or explore the API in
        your tool of choice.
      </p>

      <h2 id="download">Download</h2>
      <p>
        The specification is served as a static file at{' '}
        <Link href="/openapi.json">/openapi.json</Link>. It is versioned alongside the gateway, so
        the copy you fetch always matches the live API.
      </p>

      <CodeBlock
        lang="bash"
        title="Fetch the specification"
        code={`curl -O https://wa.example.com/openapi.json`}
      />

      <h2 id="scope">What it covers</h2>
      <p>
        The document describes only the public consumer API: sending messages, listing and
        inspecting message status, setting and clearing reactions, pushing presence, and reading
        worker status, together with the signed webhook events the gateway emits. Internal and
        administrative endpoints are deliberately excluded.
      </p>
      <ul>
        <li>
          <code>GET /api/health</code>: liveness, the only unauthenticated operation.
        </li>
        <li>
          <code>POST /v1/messages</code> and <code>GET /v1/messages</code>: send and list messages.
        </li>
        <li>
          <code>GET /v1/messages/&#123;id&#125;</code>: detailed status and history.
        </li>
        <li>
          <code>POST</code> and <code>DELETE /v1/messages/&#123;id&#125;/reactions</code>: set or
          clear a reaction.
        </li>
        <li>
          <code>POST /v1/sessions/&#123;sessionId&#125;/presence</code>: push a presence indicator.
        </li>
        <li>
          <code>GET /v1/worker/status</code>: session and worker health.
        </li>
      </ul>
      <p>
        Webhook events are documented under the OpenAPI 3.1 <code>webhooks</code> section, including
        the <code>X-HMD-Signature</code> header that authenticates each delivery. See{' '}
        <Link href="/docs/webhooks">Webhooks</Link> for verification details.
      </p>

      <h2 id="authentication">Authentication</h2>
      <p>
        Every operation except <code>GET /api/health</code> requires a Bearer API key. The
        specification declares this as the <code>bearerAuth</code> security scheme, applied
        globally, so generated clients prompt for a token automatically. Supply it in the{' '}
        <code>Authorization</code> header as <code>Bearer &lt;your-api-key&gt;</code>.
      </p>

      <h2 id="tooling">Importing into tooling</h2>
      <p>
        The file is a standard OpenAPI 3.1 document and works with any compatible tool. Common
        workflows:
      </p>
      <ul>
        <li>
          <strong>Postman</strong>: Import, then select the <code>openapi.json</code> URL or file to
          generate a collection.
        </li>
        <li>
          <strong>Insomnia</strong>: Import from URL and point it at <code>/openapi.json</code> to
          scaffold requests.
        </li>
        <li>
          <strong>openapi-generator</strong>: Generate a typed client in your language of choice.
        </li>
        <li>
          <strong>Swagger UI</strong> or <strong>Redoc</strong>: Render the document for interactive
          browsing.
        </li>
      </ul>

      <CodeBlock
        lang="bash"
        title="Generate a client with openapi-generator"
        code={`openapi-generator-cli generate \\
  -i https://wa.example.com/openapi.json \\
  -g typescript-fetch \\
  -o ./wa-client`}
      />

      <Callout type="note" title="Source of truth">
        The runtime gateway, not this document, is the final authority on behaviour. Where prose in
        these docs and the specification differ, treat the live API responses as correct and tell us
        so we can reconcile.
      </Callout>
    </article>
  );
}
