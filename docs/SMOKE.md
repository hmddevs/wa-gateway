# Smoke test

An end-to-end check that a running gateway and worker can pair a WhatsApp session and
send a message. Run this after a fresh deploy or any change to the pairing/send path.

## 1. Prerequisites

- Node 20 (`fnm use 20` or `nvm use 20`; the repo rejects other majors).
- pnpm 10.10.0 (`corepack enable && corepack prepare pnpm@10.10.0 --activate`).
- A MongoDB URI and a Redis URL you control.
- The gateway running, either via `pnpm --filter @hmddevs/gateway dev` or any
  Docker/Vercel deploy.

## 2. Configure and start the gateway

Set the environment variables described in [`docs/SELF_HOSTING.md`](./SELF_HOSTING.md)
in `apps/gateway/.env.local`, then:

```sh
pnpm install --frozen-lockfile
pnpm --filter @hmddevs/gateway dev
open http://localhost:3000/admin
```

Sign in with an account listed in `ADMIN_EMAILS` and register a passkey when prompted.

## 3. Issue a worker bootstrap token

From `/admin`, click **Issue bootstrap token**. Copy the JWT and the displayed Redis
URL and wire secret; these are consumed by the worker in the next step.

## 4. Run the worker

```sh
cd apps/worker
HMD_WA_GATEWAY=http://localhost:3000 \
HMD_WA_WORKER_ID=primary \
HMD_WA_REFRESH_TOKEN=<bootstrap-jwt> \
HMD_WA_WIRE_SECRET=<base64 from admin UI> \
HMD_WA_REDIS=<redis URL from admin UI> \
pnpm dev
```

Open `http://127.0.0.1:7823`. You should see a WhatsApp QR code. Scan it from
**WhatsApp → Settings → Linked devices**. The admin UI should switch to **Connected**
within a few seconds.

## 5. Send a message

Create an API key from `/admin` (requires step-up passkey), then:

```sh
curl -X POST http://localhost:3000/v1/messages \
  -H "authorization: Bearer <your-api-key>" \
  -H "content-type: application/json" \
  -H "idempotency-key: $(uuidgen)" \
  -d '{"to":"+1XXXXXXXXXX","body":{"kind":"text","text":"Smoke test"}}'
```

Healthy response: HTTP `202` with a `messageId`. The worker terminal should log a
send acknowledgement, and the destination phone should receive the message.

## 6. Cron smoke test

If you have the audit-verify cron configured:

```sh
curl -H "authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/audit-verify
```

Healthy response: `{ ok: true, chainValid: true }`.

## 7. Conversation capture

Confirms the admin conversation viewer captures messages regardless of which linked
device sent or received them, and that group messages are stored but not rendered in
the DM viewer.

1. Send a message from the paired phone to a contact. Confirm it appears in
   `/admin → Conversations` within a few seconds.
2. Send a message from another linked device (e.g. `web.whatsapp.com`) on the same
   account. Confirm it appears the same way.
3. Have a peer reply. Confirm the inbound message arrives.
4. Send a message into a WhatsApp group. Confirm it is stored but does not appear in
   the DM viewer.
5. Restart the worker mid-conversation. Confirm no message is duplicated on restart.

## 8. History sync on first pair

Confirms that pairing a session for the first time backfills chat history from the
linked phone, without triggering webhook fan-out.

1. Pair a session whose phone already has chat history. Within roughly 30 seconds the
   worker should start sending history batches to the gateway.
2. Open the Conversations panel for that session. Historical messages should render in
   their threads; media from history shows a placeholder rather than being re-fetched.
3. While the sync runs, confirm no webhook deliveries are triggered for the historical
   messages (only live events should fan out to webhooks).
4. Restart the worker mid-sync. Confirm no duplicate rows appear once it resumes.
