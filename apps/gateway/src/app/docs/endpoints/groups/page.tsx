import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout } from '@/components/docs/callout';
import { CodeSample } from '@/components/docs/code-sample';
import { CodeBlock } from '@/components/docs/code-block';
import { Endpoint } from '@/components/docs/endpoint';
import { ParamTable } from '@/components/docs/param-table';

export const metadata: Metadata = {
  title: 'List groups',
  description:
    "Discover the WhatsApp group JIDs the calling API key's bound session belongs to, using GET /v1/groups.",
};

export default function ListGroupsPage() {
  return (
    <article className="doc-prose">
      <h1>List groups</h1>
      <p className="doc-lead">
        Discover the WhatsApp group JIDs the calling API key&apos;s bound session belongs to, so one
        can be passed as <code>to</code> on <Link href="/docs/endpoints/send">Send a message</Link>.
        See <Link href="/docs/messages#group">Sending to a group</Link> for the send-side mechanics.
      </p>

      <Endpoint method="GET" path="/v1/groups" />

      <h2 id="authentication">Authentication and scope</h2>
      <p>
        Requires a Bearer API key in the <code>Authorization</code> header. The key must hold the{' '}
        <code>read:groups</code> scope. See <Link href="/docs/scopes">Scopes</Link> and{' '}
        <Link href="/docs/authentication">Authentication</Link>.
      </p>

      <h2 id="response">Response</h2>
      <p>
        Returns <code>200 OK</code> with a <code>groups</code> array. Results are strictly scoped to
        the calling key&apos;s own session: a key can never see another session&apos;s groups.
      </p>

      <CodeBlock
        lang="json"
        title="200 OK"
        code={`{
  "groups": [
    {
      "jid": "120363012345678901@g.us",
      "lastActivityAt": "2026-07-15T09:12:00.000Z",
      "subject": "Ops Team",
      "owner": "447700900123@s.whatsapp.net",
      "size": 3,
      "participants": [
        { "jid": "447700900123@s.whatsapp.net", "admin": "superadmin" },
        { "jid": "447700900456@s.whatsapp.net", "admin": null }
      ],
      "metadataFetchedAt": "2026-07-15T09:00:00.000Z"
    }
  ]
}`}
      />

      <Callout type="warning" title="participants exposes every member's phone number">
        When present, <code>participants</code> lists every group member&apos;s JID (their phone
        number, in effect) and admin role, not only members who have messaged the bound session
        directly. This is exposed to any API key holding the <code>read:groups</code> scope, which
        previously revealed only group JIDs. Bear this in mind before issuing that scope to a key.
      </Callout>

      <h2 id="response-fields">Response fields</h2>
      <ParamTable
        rows={[
          {
            name: 'groups',
            type: 'array',
            description: 'Array of group summary objects the session belongs to. May be empty.',
          },
          {
            name: 'groups[].jid',
            type: 'string (WhatsApp group JID)',
            description: (
              <>
                The group identifier, for example <code>120363012345678901@g.us</code>. Pass this as{' '}
                <code>to</code> on <code>POST /v1/messages</code> to send to the group.
              </>
            ),
          },
          {
            name: 'groups[].lastActivityAt',
            type: 'string (ISO 8601)',
            description: 'Timestamp of the most recent message the gateway observed in this group.',
          },
          {
            name: 'groups[].subject',
            type: 'string (optional)',
            description: "The group's name, when the gateway has captured it.",
          },
          {
            name: 'groups[].subjectOwner',
            type: 'string (optional)',
            description: 'JID of whoever last changed the subject, when captured.',
          },
          {
            name: 'groups[].subjectTime',
            type: 'string (ISO 8601, optional)',
            description: 'Timestamp of the last subject change, when captured.',
          },
          {
            name: 'groups[].creation',
            type: 'string (ISO 8601, optional)',
            description: 'Timestamp of group creation, when captured.',
          },
          {
            name: 'groups[].owner',
            type: 'string (optional)',
            description: 'Group owner JID, when captured.',
          },
          {
            name: 'groups[].desc',
            type: 'string (optional)',
            description: 'Group description, when captured.',
          },
          {
            name: 'groups[].descId',
            type: 'string (optional)',
            description: 'Opaque id of the current description, when captured.',
          },
          {
            name: 'groups[].announce',
            type: 'boolean (optional)',
            description: 'Only admins may post when true.',
          },
          {
            name: 'groups[].restrict',
            type: 'boolean (optional)',
            description: 'Only admins may change group settings when true.',
          },
          {
            name: 'groups[].size',
            type: 'number (optional)',
            description:
              'Participant count as reported by Baileys, independent of participants.length.',
          },
          {
            name: 'groups[].ephemeralDuration',
            type: 'number (optional)',
            description: 'Disappearing-messages duration in seconds; absent or 0 means off.',
          },
          {
            name: 'groups[].inviteCode',
            type: 'string (optional)',
            description: 'Current group invite code, when captured.',
          },
          {
            name: 'groups[].participants',
            type: 'array (optional)',
            description: (
              <>
                Every member&apos;s <code>{'{ jid, admin }'}</code> (<code>admin</code> is{' '}
                <code>&apos;admin&apos; | &apos;superadmin&apos; | null</code>). See the privacy
                note above.
              </>
            ),
          },
          {
            name: 'groups[].metadataFetchedAt',
            type: 'string (ISO 8601, optional)',
            description: "Timestamp of when the gateway last captured this group's metadata.",
          },
        ]}
      />
      <p>
        All metadata fields beyond <code>jid</code> and <code>lastActivityAt</code> are additive and
        optional: a group with chat activity but no captured metadata still appears in the list,
        simply without them. Metadata is fetched by the worker on connect and refreshed on group and
        participant-change events, so it can be briefly stale; this endpoint stays DB-only and keeps
        working when the worker is offline, serving whatever was last captured.
      </p>

      <h2 id="discovery">Discovering groups</h2>
      <p>
        A group only appears in this list once the session has seen at least one message in it,
        either live or via history sync. There is no way to enumerate a session&apos;s groups before
        any traffic has flowed through them.
      </p>
      <Callout type="note" title="Empty array, never an error">
        When there is no persisted group activity for the session, the response is{' '}
        <code>{'{ "groups": [] }'}</code>, not an error.
      </Callout>

      <h2 id="org-keys">Organization-bound keys</h2>
      <Callout type="warning" title="Listing reflects one number, not the whole organization">
        For a key bound to an <code>orgId</code>, this endpoint lists groups for the key&apos;s
        statically bound session only, while <code>POST /v1/messages</code> routes each send to
        whichever number the organization picks. If a send is routed to a number that is not a
        member of the listed group, it fails at the WhatsApp layer. Prefer a single-session key when
        working with groups.
      </Callout>

      <h2 id="examples">Examples</h2>
      <CodeSample
        samples={[
          {
            label: 'curl',
            lang: 'bash',
            code: `curl https://wa.example.com/v1/groups \\
  -H "Authorization: Bearer $HMD_WA_API_KEY"`,
          },
          {
            label: 'TypeScript',
            lang: 'typescript',
            code: `import { hmdWA } from '@hmddevs/wa-sdk';

const wa = hmdWA({ apiKey: process.env.HMD_WA_API_KEY });

const { groups } = await wa.listGroups();
const jid = groups[0]?.jid; // e.g. '120363012345678901@g.us'`,
          },
          {
            label: 'Response',
            lang: 'json',
            code: `{
  "groups": [
    {
      "jid": "120363012345678901@g.us",
      "lastActivityAt": "2026-07-15T09:12:00.000Z",
      "subject": "Ops Team",
      "metadataFetchedAt": "2026-07-15T09:00:00.000Z"
    }
  ]
}`,
          },
        ]}
      />

      <h2 id="status-codes">Status codes</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Code</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>200</td>
              <td></td>
              <td>
                Success. Returns the <code>groups</code> array (may be empty).
              </td>
            </tr>
            <tr>
              <td>401</td>
              <td>
                <code>UNAUTHORIZED</code>
              </td>
              <td>Missing or invalid bearer token.</td>
            </tr>
            <tr>
              <td>403</td>
              <td>
                <code>SCOPE_DENIED</code> / <code>IP_NOT_ALLOWED</code>
              </td>
              <td>
                Key lacks <code>read:groups</code>, or client IP is not in the key&apos;s allowlist.
              </td>
            </tr>
            <tr>
              <td>429</td>
              <td>
                <code>RATE_LIMITED</code>
              </td>
              <td>
                Rate limit exceeded. See <Link href="/docs/rate-limits">Rate limits</Link>.
              </td>
            </tr>
            <tr>
              <td>500</td>
              <td>
                <code>INTERNAL</code>
              </td>
              <td>
                Unhandled server error. Quote the <code>requestId</code> in support tickets.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <CodeBlock
        lang="json"
        title="Error envelope"
        code={`{
  "error": "Missing scope: read:groups",
  "code": "SCOPE_DENIED",
  "requestId": "req_01hvz…"
}`}
      />

      <Callout type="note" title="Error envelope shape">
        All non-2xx responses follow the flat shape{' '}
        <code>{'{ "error": "…", "code": "…", "requestId": "…" }'}</code>. Always match on{' '}
        <code>code</code>, not on <code>error</code>; the message text may change without notice.
        See the <Link href="/docs/errors">Error codes reference</Link> for the full catalogue.
      </Callout>
    </article>
  );
}
