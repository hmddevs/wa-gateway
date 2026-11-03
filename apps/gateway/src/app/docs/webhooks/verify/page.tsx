import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeBlock } from '@/components/docs/code-block';
import { CodeSample } from '@/components/docs/code-sample';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'Verifying signatures',
  description:
    'How to validate the X-HMD-Signature header on incoming webhook requests using HMAC-SHA256.',
};

export default function WebhookVerifyPage() {
  return (
    <article className="doc-prose">
      <h1>Verifying signatures</h1>
      <p className="doc-lead">
        Every webhook request is signed with HMAC-SHA256. Verifying the <code>X-HMD-Signature</code>{' '}
        header before processing ensures the request genuinely originated from the gateway and has
        not been tampered with in transit.
      </p>

      <Callout type="security" title="Always verify before parsing">
        Verify the signature on the <strong>raw request body bytes</strong> before parsing JSON.
        Re-serialising the parsed object can silently alter whitespace and field ordering, causing a
        valid signature to fail verification, or worse, allowing a tampered payload to appear valid
        if you verify a re-stringified copy.
      </Callout>

      <h2 id="header-format">Header format</h2>
      <p>
        The <code>X-HMD-Signature</code> header contains two comma-separated key-value pairs:
      </p>

      <CodeBlock
        lang="http"
        title="X-HMD-Signature"
        code={`X-HMD-Signature: t=1719245696,v1=a1b2c3d4e5f6789abcdef0123456789abcdef0123456789abcdef0123456789ab`}
      />

      <ParamTable
        rows={[
          {
            name: 't',
            type: 'integer',
            required: true,
            description:
              'Unix timestamp in seconds of when the request was signed. Used to enforce the replay window.',
          },
          {
            name: 'v1',
            type: 'hex string',
            required: true,
            description:
              'HMAC-SHA256 of the signed payload, encoded as lowercase hex (64 characters).',
          },
        ]}
      />

      <h2 id="signing-scheme">Signing scheme</h2>
      <p>
        The gateway constructs the signed payload by concatenating the timestamp, a literal dot, and
        the raw request body:
      </p>

      <CodeBlock
        lang="text"
        title="Signed payload construction"
        code={`signed_payload = t + "." + rawBody

// Example:
// t       = 1719245696
// rawBody = '{"type":"message.sent","messageId":"550e8400-e29b-41d4-a716-446655440001",...}'
// signed  = "1719245696.{\"type\":\"message.sent\",...}"
//
// signature = HMAC-SHA256(webhookSecret, signed_payload)`}
      />

      <p>Where:</p>
      <ul>
        <li>
          <code>t</code> is the integer extracted from the header (unix seconds).
        </li>
        <li>
          <code>rawBody</code> is the exact UTF-8 string received over the wire. Do not pre-parse or
          re-serialise it.
        </li>
        <li>
          <code>webhookSecret</code> is the base64url-encoded 32-byte signing secret shown when your
          webhook was registered. Pass it as-is to the HMAC function (as a string or decoded bytes,
          depending on your library).
        </li>
      </ul>

      <h2 id="verification-steps">Step-by-step verification</h2>
      <ol>
        <li>
          Read the <code>X-HMD-Signature</code> header. If absent, reject with <code>400</code>.
        </li>
        <li>
          Parse the header: split on <code>,</code>, then on the first <code>=</code> to extract{' '}
          <code>t</code> and <code>v1</code>. If either is missing, reject.
        </li>
        <li>
          Enforce the replay window: compute <code>|now &minus; t|</code> in seconds. Reject if
          greater than 300 (five minutes).
        </li>
        <li>
          Construct the signed payload: <code>{`\`\${t}.\${rawBody}\``}</code>.
        </li>
        <li>
          Compute <code>expected = HMAC-SHA256(webhookSecret, signedPayload)</code> and encode as
          hex.
        </li>
        <li>
          Compare <code>expected</code> and <code>v1</code> using{' '}
          <strong>constant-time comparison</strong>. A character-by-character string comparison
          leaks timing information that can be used to forge signatures.
        </li>
        <li>If the comparison passes, the request is authentic. Proceed to parse and process.</li>
      </ol>

      <h2 id="replay-window">Replay window</h2>
      <p>
        The tolerance window is <strong>±300 seconds</strong> (five minutes). Requests with a
        timestamp outside this window are rejected regardless of signature validity. Ensure your
        server clock is synchronised via NTP; significant clock drift will cause legitimate
        deliveries to fail verification.
      </p>

      <h2 id="examples">Verification code examples</h2>

      <CodeSample
        samples={[
          {
            label: 'TypeScript (node:crypto)',
            lang: 'typescript',
            code: `import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an incoming HMD webhook request.
 * Call this before parsing the JSON body.
 *
 * @param rawBody  The raw UTF-8 string body from the request (do NOT pre-parse)
 * @param header   The value of the X-HMD-Signature header
 * @param secret   Your webhook signing secret (base64url-encoded 43-char string)
 * @returns true when valid; false when the signature is wrong or the request is stale
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string,
  secret: string,
): boolean {
  // 1. Parse header
  const parts: Record<string, string> = {};
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx !== -1) {
      parts[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }

  const t  = parts['t']  ? Number(parts['t'])  : null;
  const v1 = parts['v1'] ?? null;

  if (!t || !v1 || !Number.isFinite(t)) return false;

  // 2. Enforce replay window (±300 s)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > 300) return false;

  // 3. Compute expected signature
  const signedPayload = \`\${t}.\${rawBody}\`;
  const expected = createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // 4. Constant-time comparison
  const eBuf = Buffer.from(expected, 'hex');
  const vBuf = Buffer.from(v1,       'hex');

  if (eBuf.length !== vBuf.length) return false;
  return timingSafeEqual(eBuf, vBuf);
}`,
          },
          {
            label: 'Express handler',
            lang: 'typescript',
            code: `import express from 'express';
import { verifyWebhookSignature } from './verify'; // function above

const app = express();

app.post(
  '/webhooks/wa',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8');
    const header  = req.header('x-hmd-signature') ?? '';
    const secret  = process.env.HMD_WA_WEBHOOK_SECRET!;

    if (!verifyWebhookSignature(rawBody, header, secret)) {
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }

    // Respond immediately; process in background
    res.status(204).end();

    const event = JSON.parse(rawBody);
    void processEvent(event); // your async handler
  },
);`,
          },
          {
            label: 'Python (hmac/hashlib)',
            lang: 'python',
            code: `import hashlib
import hmac
import os
import time

def verify_webhook_signature(
    raw_body: bytes,
    header: str,
    secret: str,
) -> bool:
    """
    Verify an incoming HMD webhook request.

    :param raw_body: The raw request body bytes (do NOT pre-parse)
    :param header:   The value of the X-HMD-Signature header
    :param secret:   Your webhook signing secret (base64url-encoded string)
    :returns: True when valid; False when signature is wrong or request is stale
    """
    # 1. Parse header
    parts: dict[str, str] = {}
    for part in header.split(","):
        if "=" in part:
            k, _, v = part.strip().partition("=")
            parts[k.strip()] = v.strip()

    t_str = parts.get("t")
    v1    = parts.get("v1")

    if not t_str or not v1:
        return False

    try:
        t = int(t_str)
    except ValueError:
        return False

    # 2. Enforce replay window (±300 s)
    if abs(time.time() - t) > 300:
        return False

    # 3. Construct signed payload and compute expected signature
    signed_payload = f"{t}.".encode() + raw_body
    expected = hmac.new(
        secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()

    # 4. Constant-time comparison
    return hmac.compare_digest(expected, v1)


# --- Flask example ---
# from flask import Flask, request, abort
# app = Flask(__name__)
#
# @app.route('/webhooks/wa', methods=['POST'])
# def webhook():
#     raw_body = request.get_data()  # read raw bytes before any parsing
#     header   = request.headers.get('X-HMD-Signature', '')
#     secret   = os.environ['HMD_WA_WEBHOOK_SECRET']
#
#     if not verify_webhook_signature(raw_body, header, secret):
#         abort(400)
#
#     event = request.get_json()
#     # ... process in background ...
#     return '', 204`,
          },
        ]}
      />

      <h2 id="related">Related</h2>
      <ul>
        <li>
          <Link href="/docs/webhooks">Webhooks overview</Link>: delivery semantics, retry schedule,
          and response expectations.
        </li>
        <li>
          <Link href="/docs/webhooks/events">Event payloads</Link>: the full list of event types and
          their fields.
        </li>
      </ul>
    </article>
  );
}
