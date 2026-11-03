import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';

export const metadata: Metadata = {
  title: 'Get an API key',
  description:
    'API keys for the HMD WA Gateway are invite-only and issued by the HMD administrator. Learn how to request access.',
};

export default function ApiKeysPage() {
  return (
    <article className="doc-prose">
      <h1>Get an API key</h1>
      <p className="doc-lead">
        Access to the HMD WA Gateway is invite-only. Keys are issued by the HMD administrator; there
        is no self-service signup or registration flow.
      </p>

      <Callout type="note" title="Request a key">
        Email{' '}
        <a href="mailto:security@hmddevs.org?subject=WA%20Gateway%20API%20key%20request">
          security@hmddevs.org
        </a>{' '}
        with the information listed below. The administrator will reply with your key and confirm
        the scopes and session binding.
      </Callout>

      <h2 id="what-to-include">What to include in your request</h2>
      <p>
        To issue a key, the administrator needs the following information. Include as much as you
        know; any missing details will be followed up before the key is created.
      </p>
      <ul>
        <li>
          <strong>Project name</strong>: a short slug that identifies your project, for example{' '}
          <code>acme-notifications</code>. This becomes your immutable <code>projectId</code> and
          groups all messages sent through this key for audit and billing.
        </li>
        <li>
          <strong>Intended use</strong>: describe what you are building and what kind of messages
          you will send (OTP, order updates, support replies, and so on). This determines which
          scopes your key needs.
        </li>
        <li>
          <strong>Expected message volume</strong>: approximate sends per minute or per day. This
          sets the per-key rate limit.
        </li>
        <li>
          <strong>Source IP addresses</strong>: the IP addresses or CIDR ranges from which your
          application will make API calls. If you provide these, the key will be locked to those
          ranges and requests from any other IP will receive <code>403 IP_NOT_ALLOWED</code>. If you
          do not provide IPs, the key will accept requests from any IP.
        </li>
        <li>
          <strong>WhatsApp session</strong>: the phone number or session identifier you want the key
          bound to, if known. If you are unsure, the administrator can confirm the available
          sessions.
        </li>
      </ul>

      <h2 id="what-you-receive">What you receive</h2>
      <p>
        The administrator will issue a key in the format{' '}
        <code>hmd_sk_&lt;division&gt;_&lt;env&gt;_&lt;secret&gt;</code>. The full secret is shown
        only once at creation; store it immediately in a secrets manager or environment variable.
        After that, only the public reference form (with the first 8 hex characters of the SHA-256
        hash of the secret replacing the secret) is visible in logs and the admin UI.
      </p>
      <p>Along with the key, the administrator will confirm:</p>
      <ul>
        <li>
          The scopes granted (<code>send:transactional</code>, <code>send:notification</code>, etc.)
        </li>
        <li>The session binding (which WhatsApp number sends will go out from)</li>
        <li>The per-minute rate limit</li>
        <li>Whether an IP allowlist was applied</li>
      </ul>
      <p>
        See <Link href="/docs/authentication">Authentication</Link> for a full explanation of key
        format, scopes, and IP allowlists.
      </p>

      <h2 id="environments">Test and live keys</h2>
      <p>
        Keys include an <code>env</code> segment that is either <code>test</code> or{' '}
        <code>live</code>. Test keys work only against test sessions and are safe to use during
        development. Live keys route to production sessions.
      </p>
      <p>If you need a test key for development or staging, mention this in your request email.</p>

      <h2 id="rotation-policy">Rotation policy</h2>
      <p>
        Keys do not expire automatically. To rotate a key, request a new one, deploy it, and then
        ask the administrator to revoke the old key. The old key remains valid until revocation, so
        there is no gap in service during the switchover.
      </p>
      <p>
        Rotate immediately if you suspect a key has been leaked. Email{' '}
        <a href="mailto:security@hmddevs.org?subject=WA%20Gateway%20key%20rotation">
          security@hmddevs.org
        </a>{' '}
        to initiate an emergency rotation.
      </p>

      <h2 id="scope-changes">Changing scopes or limits</h2>
      <p>
        Scopes and rate limits are configured at key creation. If your requirements change (for
        example you need to add the <code>send:new_recipients</code> scope or increase your rate
        limit), email{' '}
        <a href="mailto:security@hmddevs.org?subject=WA%20Gateway%20key%20update">
          security@hmddevs.org
        </a>{' '}
        and describe the change. The administrator can update the key without requiring a rotation.
      </p>
    </article>
  );
}
