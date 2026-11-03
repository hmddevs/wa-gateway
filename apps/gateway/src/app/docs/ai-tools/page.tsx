import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';

export const metadata: Metadata = {
  title: 'Use with AI tools',
  description:
    'Integrate the HMD WA Gateway with AI coding tools and agents: a machine-readable docs corpus plus a ready-to-paste prompt.',
};

const AGENT_PROMPT = `You are integrating the HMD WhatsApp Gateway, an HTTP API (there is no SDK or npm package).

Before writing any code, fetch and read the full reference:
- Full API reference (markdown): https://wa.example.com/llms-full.txt
- OpenAPI specification: https://wa.example.com/openapi.json

Key facts:
- Base URL: https://wa.example.com
- Every request sends "Authorization: Bearer <API_KEY>" and "Content-Type: application/json".
  Read the API key from an environment variable; never hard-code it.
- It is HTTP only. Do not look for, import, or install an SDK; one does not exist.

Follow the reference exactly. In particular:
- POST /v1/messages requires a "purpose" field. Body kinds are text, image, and document.
  "to" accepts either an E.164 phone number or a WhatsApp group JID (…@g.us) for a group send;
  group sends reject "replyTo" with 422 and are not subject to the opt-out registry.
- GET /v1/groups discovers the group JIDs the bound session belongs to (requires the
  "read:groups" scope) so you can pass one as "to".
- Send an "idempotencyKey" on each message so retries do not duplicate (the dedup window
  equals the message TTL, default about 30 minutes).
- For webhooks, verify the "X-HMD-Signature" HMAC exactly as the reference describes before
  trusting any payload.
- Handle the documented error codes, and respect the rate limits (including the per-recipient cap).

My task: <describe what you want, for example: send a login OTP, then handle the delivery webhook>.

Write the integration in <your language and framework>, using only the documented endpoints.`;

export default function AiToolsPage() {
  return (
    <article className="doc-prose">
      <h1>Use with AI tools</h1>
      <p className="doc-lead">
        If you build with an AI coding assistant or agent (Cursor, Copilot, and similar), you can
        hand it this gateway&rsquo;s machine-readable documentation and a short prompt, and it can
        write a correct integration without you transcribing the API by hand.
      </p>

      <h2 id="machine-readable-docs">Machine-readable docs</h2>
      <p>
        Three documents are published for tools to read directly. Point your AI tool at them (it
        needs web-fetch access enabled):
      </p>
      <ul>
        <li>
          <strong>
            <Link href="/llms-full.txt">/llms-full.txt</Link>
          </strong>{' '}
          the complete HTTP integration reference as a single clean Markdown document: auth, every
          endpoint with request and response examples, idempotency, rate limits, error codes, and
          webhook verification. This is the one file an agent needs to integrate end to end.
        </li>
        <li>
          <strong>
            <Link href="/llms.txt">/llms.txt</Link>
          </strong>{' '}
          a short index of the documentation, in the{' '}
          <Link href="https://llmstxt.org">llms.txt</Link> format.
        </li>
        <li>
          <strong>
            <Link href="/openapi.json">/openapi.json</Link>
          </strong>{' '}
          the OpenAPI specification, for type generation and request validation. See{' '}
          <Link href="/docs/openapi">OpenAPI spec</Link> for tooling.
        </li>
      </ul>

      <h2 id="ready-to-paste-prompt">Ready-to-paste prompt</h2>
      <p>
        Paste this into your AI coding tool, then replace the two placeholders with your own task
        and stack. It deliberately tells the agent to read the full reference first, so it stays
        correct as the API evolves rather than relying on a snapshot.
      </p>
      <CodeBlock code={AGENT_PROMPT} lang="text" title="Prompt for your AI agent" />

      <Callout type="note" title="You still need an API key">
        Access is invite-only. Request a key first (see{' '}
        <Link href="/docs/api-keys">Get an API key</Link>), give it to your tool through an
        environment variable, and never paste a live key into a shared prompt or chat.
      </Callout>

      <Callout type="warning" title="These docs are private, not public">
        The gateway and its documentation are deliberately undiscoverable: not indexed by search
        engines, not crawlable. The links above work when you (or your tool) fetch them directly
        with the URL, but they will not appear in search results. Share them out of band, not by
        publishing them.
      </Callout>
    </article>
  );
}
