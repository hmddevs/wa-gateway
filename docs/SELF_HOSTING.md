# Self-hosting

> This is an unofficial project built on
> [Baileys](https://github.com/WhiskeySockets/Baileys), a reverse-engineered
> WhatsApp Web client. It is not affiliated with, endorsed by, or sponsored
> by WhatsApp or Meta. Automating WhatsApp this way may breach WhatsApp's
> Terms of Service, and the connected number can be banned. Self-host and
> use at your own risk; support is community-only.
>
> This repository ships source and documentation only. Baileys depends on
> the GPL-3.0-licensed libsignal and the LGPL-licensed codec-parser, check
> those licences yourself before redistributing any built image or binary.

## Topology

Both apps are plain Docker containers (Dockerfiles at the repo root and in
`apps/worker/`) and can run on any host that can reach your Redis and MongoDB
instances, a VPS, a Kubernetes cluster, Fly.io, Vercel (gateway only) or a
bare machine with Docker installed. The reference setup below is
provider-agnostic.

- **gateway**, a containerised Next.js app (Node.js). Handles the HTTP
  API, admin dashboard, and the in-process scheduled-message dispatcher.
- **worker**, a containerised daemon that holds the Baileys WebSocket
  session to WhatsApp. Session state and the rotating refresh token are
  stored on a persistent volume mounted at `/data`.

The two apps communicate over your own network path:

- Worker callbacks reach the gateway at whatever hostname/URL you configure
  via `HMD_WA_GATEWAY`.
- The gateway publishes send commands to Redis (`rediss://`); the worker
  subscribes on the same Redis instance.

Neither app requires an Apple-silicon Mac; the worker runs as a Docker
container on any Linux host.

## Prerequisites

- **A container host** of your choice (VPS, Kubernetes, Fly.io, etc.).
- **MongoDB** cluster (MongoDB Atlas or self-managed), same region as your host.
- **Redis** instance with TLS, same region as your host.
- **Domain** pointing at the gateway app (e.g. `wa.example.com`).
- **Email sender**: an SMTP/API provider for alerts.
- **WhatsApp number**: a dedicated personal number and SIM/eSIM you control,
  used to pair the worker.

## Environment variables

The gateway validates all env vars at boot
(`apps/gateway/src/lib/env.ts`); it refuses to start if anything is missing
or malformed. Set secrets via your host's secret manager, never commit them
to a config file.

Generate the symmetric secrets:

```bash
openssl rand -base64 32   # SERVER_PEPPER
openssl rand -base64 32   # INBOUND_ENCRYPTION_KEY
openssl rand -base64 32   # WEBHOOK_SIGNING_DEFAULT_SECRET
openssl rand -base64 32   # NEXTAUTH_SECRET
```

Generate the worker RS256 keypair:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out worker.key
openssl rsa -in worker.key -pubout -out worker.pub
# Set WORKER_JWT_SIGNING_KEY (private, gateway-side) and
# WORKER_JWT_PUBLIC_KEY (public, worker-side) via your host's secret manager.
```

Worker secrets (set via your host's secret manager):

- `HMD_WA_REFRESH_TOKEN`, rotating bearer token for the gateway callback auth.
- `HMD_WA_WIRE_SECRET`, shared HMAC secret for signing wire envelopes.
- `HMD_WA_SESSION_KEY`, AES key for encrypting Baileys session state at rest.
- `HMD_WA_REDIS`, Upstash Redis URL (`rediss://...`).
- `HMD_WA_GATEWAY`, URL of the gateway (`https://wa.example.com`).

### Client IP and reverse proxy

IP allowlists and per-IP rate limiting both rely on `TRUSTED_CLIENT_IP_HEADER`
naming a header that your own reverse proxy sets or overwrites on every
request, never one a client could send directly. There is no default: set
this to whatever your proxy actually supplies, for example
`cf-connecting-ip` behind Cloudflare, or `x-real-ip` behind an nginx that
sets it itself. Leaving it unset makes every request resolve to the same
`0.0.0.0` identity, so IP allowlists reject everything and per-IP rate
limits share one bucket across all clients. This gateway is deployable to
any Docker host, but IP allowlisting and per-IP rate limiting only work once
you have configured `TRUSTED_CLIENT_IP_HEADER` for the proxy actually in
front of it. Until it is set, raise `RATE_LIMIT_IP_PER_MIN` (default 1200)
to account for every client sharing that one `0.0.0.0` bucket.

## Deploying

Build and run each app's Docker image on your chosen host, or wire up your
own CI to build on push to `main`. Restart the worker only when its files
change, restarting it without cause tends to invalidate the WhatsApp
session and force a manual re-pair.

```bash
# Gateway
docker build -t wa-gateway -f Dockerfile .
docker run -p 3000:3000 --env-file .env wa-gateway

# Worker
docker build -t wa-worker -f apps/worker/Dockerfile .
docker run -v wa_sessions:/data --env-file .env wa-worker
```

## First-time setup and pairing

1. Create a persistent volume for the worker's session state (`/data`)
   before the first worker deploy.
2. Deploy both apps.
3. Open the admin portal (`https://wa.example.com/admin`) and use the
   **Pair session** flow to scan the QR code with your WhatsApp number.
   Re-pairing is done the same way if the session is lost.

## Database, retention and migrations

### Message retention (2026-06-28)

Messages, inbound messages, and chat events carry a 90-day TTL index
(`expireAfterSeconds = 7776000`). Audit logs are never expired (append-only
hash chain). The TTL is enforced by the MongoDB Atlas TTL monitor and
re-applied at boot by `apps/gateway/src/lib/mongo.ts#ensureRetentionTtl`.

### Infinite retention (2026-05-10, reverted 2026-06-28)

An earlier change removed the TTL indexes to allow the full WhatsApp history
to be browsed. This was reverted when retention TTLs were re-added. If your
Atlas cluster was provisioned between those dates and has no TTL indexes,
restart the gateway, `ensureRetentionTtl` will recreate them automatically.

## Upgrades

Roll the worker restart carefully; allow 30–60 seconds for the Baileys
WebSocket to reconnect after a restart.
