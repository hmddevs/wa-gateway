import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';
import { Callout } from '@/components/docs/callout';

const QUICK_AGENT_PROMPT = `Read https://wa.example.com/llms-full.txt, the complete HTTP integration
reference for the HMD WhatsApp Gateway (HTTP only, no SDK). Then answer my
questions about it and write integrations using only the documented endpoints,
sending "Authorization: Bearer <API_KEY>" from an environment variable.`;

export const metadata: Metadata = {
  title: 'Introduction',
  description:
    'The HMD WA Gateway sends and receives WhatsApp messages over a hardened HTTP API, with signed webhooks and idempotent delivery.',
};

export default function IntroductionPage() {
  return (
    <article className="doc-prose">
      <h1>HMD WA Gateway</h1>
      <Callout type="warning" title="Unofficial, use at your own risk">
        Built on <a href="https://github.com/WhiskeySockets/Baileys">Baileys</a>, a
        reverse-engineered WhatsApp Web client. This project is not affiliated with, endorsed by, or
        sponsored by WhatsApp or Meta. Automating WhatsApp this way may breach WhatsApp&apos;s Terms
        of Service, and the connected number can be banned.
      </Callout>
      <p className="doc-lead">
        Send and receive WhatsApp messages over a single, hardened HTTP API. One Bearer token,
        signed webhooks, and idempotent delivery, no WhatsApp Business onboarding to manage on your
        side.
      </p>

      <p>
        The gateway exposes a small, stable REST surface under{' '}
        <code>https://wa.example.com/v1</code>. You send a message with one <code>POST</code>; the
        gateway handles delivery to WhatsApp and reports progress back to you through webhooks.
        Everything you need as an integrator lives in these docs, the moving parts behind the API
        are ours to run.
      </p>

      <Callout type="tip" title="Prefer to ask an AI agent?">
        Skip the reading. Paste this into your AI coding tool (Cursor, Copilot, and similar, with
        web-fetch enabled) and ask it anything about the gateway:
        <CodeBlock code={QUICK_AGENT_PROMPT} lang="text" title="Prompt for your AI agent" />
        See <Link href="/docs/ai-tools">Use with AI tools</Link> for the machine-readable corpus and
        a fuller integration prompt.
      </Callout>

      <Callout type="note" title="Access is invite-only">
        API keys are issued by the HMD administrator, there is no self-service signup. To request a
        key for your project, email{' '}
        <a href="mailto:security@hmddevs.org?subject=WA%20Gateway%20API%20key%20request">
          security@hmddevs.org
        </a>
        . See <Link href="/docs/api-keys">Get an API key</Link> for what to include.
      </Callout>

      <h2 id="what-you-can-do">What you can do</h2>
      <ul>
        <li>
          <strong>Send messages</strong>, text, images, and documents, to any WhatsApp number in
          E.164 format.
        </li>
        <li>
          <strong>Confirm delivery synchronously</strong>, wait for a terminal acknowledgement
          inline so you can fall back to email or SMS when a send does not land.
        </li>
        <li>
          <strong>Schedule sends</strong> for a future time, up to 30 days ahead.
        </li>
        <li>
          <strong>React</strong> to messages and push <strong>typing and presence</strong>{' '}
          indicators.
        </li>
        <li>
          <strong>Receive inbound messages and status updates</strong> through signed webhooks,
          delivered, read, replies, reactions, and opt-outs.
        </li>
        <li>
          <strong>Send to WhatsApp groups</strong>, pass a group JID as <code>to</code>, and
          discover the groups a session belongs to via <code>GET /v1/groups</code>.
        </li>
        <li>
          <strong>Stay idempotent</strong>, retry any send safely with an idempotency key and never
          double-deliver.
        </li>
      </ul>

      <h2 id="a-first-look">A first look</h2>
      <p>
        Sending a message is a single authenticated <code>POST</code>:
      </p>

      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl https://wa.example.com/v1/messages \\
  -H "Authorization: Bearer $HMD_WA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+447700900123",
    "purpose": "transactional",
    "body": { "kind": "text", "text": "Your order has shipped." }
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
    body: { kind: 'text', text: 'Your order has shipped.' },
  }),
});

const data = await res.json();
console.log(data.messageId, data.status); // "8e8f3a26-0c47-4f3e-...", "queued"`,
          },
        ]}
      />

      <h2 id="how-the-docs-are-organised">How these docs are organised</h2>
      <ul>
        <li>
          <strong>
            <Link href="/docs/quickstart">Quickstart</Link>
          </strong>
          , send your first message in a few minutes.
        </li>
        <li>
          <strong>
            <Link href="/docs/authentication">Authentication</Link>
          </strong>{' '}
          and{' '}
          <strong>
            <Link href="/docs/concepts">Core concepts</Link>
          </strong>
          , the model you build on: keys, sessions, purpose, and idempotency.
        </li>
        <li>
          <strong>Sending and Reading</strong>, the full endpoint reference for every call.
        </li>
        <li>
          <strong>Reliability</strong>, rate limits, idempotency, errors, opt-outs, and versioning.
        </li>
        <li>
          <strong>
            <Link href="/docs/webhooks">Webhooks</Link>
          </strong>
          , receive and verify events.
        </li>
      </ul>

      <Callout type="tip" title="New here?">
        Start with the <Link href="/docs/quickstart">Quickstart</Link>, then skim{' '}
        <Link href="/docs/concepts">Core concepts</Link>. Everything else is reference you can reach
        for as you build.
      </Callout>
    </article>
  );
}
