import type { Metadata } from 'next';
import { Callout } from '@/components/docs/callout';

export const metadata: Metadata = {
  title: 'Versioning',
  description:
    'The /v1 URL prefix, what the backwards-compatibility guarantee covers, and how breaking changes are handled.',
};

export default function VersioningPage() {
  return (
    <article className="doc-prose">
      <h1>Versioning</h1>
      <p className="doc-lead">
        All consumer endpoints are prefixed with <code>/v1</code>. The prefix is a stability
        guarantee: the rules below define precisely what changes within <code>/v1</code> are safe
        and what would require a new major version.
      </p>

      <h2 id="url-structure">URL structure</h2>
      <p>
        The base URL is <code>https://wa.example.com</code>. Every versioned consumer endpoint lives
        under <code>/v1</code>, for example:
      </p>
      <ul>
        <li>
          <code>POST https://wa.example.com/v1/messages</code>
        </li>
        <li>
          <code>GET https://wa.example.com/v1/messages/:messageId</code>
        </li>
      </ul>
      <p>
        The health endpoint (<code>GET /api/health</code>) is unversioned; it is a liveness probe
        and carries no stability guarantee beyond always returning a JSON body with an{' '}
        <code>ok</code> field.
      </p>

      <h2 id="backwards-compatibility">Backwards-compatibility policy</h2>
      <p>
        Within <code>/v1</code>, the following rules apply:
      </p>

      <h3 id="additive-changes">What is allowed (additive changes)</h3>
      <ul>
        <li>
          <strong>New fields in responses.</strong> Fields will only be added, never removed or
          renamed. Write your deserialisation to ignore unknown fields.
        </li>
        <li>
          <strong>New optional fields in request bodies.</strong> New parameters are introduced as
          optional with sensible defaults so existing callers need not change.
        </li>
        <li>
          <strong>New enum values.</strong> Enum values (such as <code>purpose</code>, message{' '}
          <code>status</code>) will only be appended. Existing values are never reordered or
          removed.
        </li>
        <li>
          <strong>New endpoints.</strong> Additional routes may be added under <code>/v1</code>{' '}
          without notice.
        </li>
        <li>
          <strong>New error codes.</strong> New <code>code</code> values may appear. Your error
          handler should have a default branch for unrecognised codes.
        </li>
      </ul>

      <h3 id="breaking-changes">What requires a new major version</h3>
      <ul>
        <li>Removing or renaming a field in a request or response body.</li>
        <li>Changing the type of an existing field.</li>
        <li>Removing or renaming an existing enum value.</li>
        <li>Removing an endpoint.</li>
        <li>
          Changing the semantics of an existing field in a way that alters existing callers&apos;
          behaviour.
        </li>
      </ul>

      <p>
        Any such change would be introduced under a new version prefix (for example,{' '}
        <code>/v2</code>), giving consumers time to migrate while <code>/v1</code> continues to
        operate.
      </p>

      <h3 id="unknown-request-fields">Unknown fields in requests</h3>
      <p>
        Unknown fields in request bodies are <strong>silently ignored</strong>, not rejected. The
        gateway does not return <code>400 INVALID_BODY</code> for an extra or misspelt field; it is
        stripped before validation and the request proceeds as if the field were never sent. Do not
        rely on the API to catch a typo&apos;d field name for you: validate your own request
        construction, and do not send fields that are not documented.
      </p>

      <h2 id="how-changes-are-communicated">How changes are communicated</h2>
      <p>
        Additive changes within <code>/v1</code> may be deployed at any time without advance notice,
        as they are backwards-compatible by definition. No change is made that would break a
        correctly written client.
      </p>

      <Callout type="note" title="Write defensive clients">
        Deserialise responses in a way that tolerates new fields (for example, do not use strict
        exhaustive matching on response shapes). Handle unrecognised enum values and error codes
        with a default branch. This ensures your integration continues to work as the API evolves.
      </Callout>

      <p>
        For questions about planned changes or to be notified before a future major-version
        transition, contact <a href="mailto:security@hmddevs.org">security@hmddevs.org</a>.
      </p>
    </article>
  );
}
