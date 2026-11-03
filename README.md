# HMD WhatsApp Gateway (`wa-gateway`)

> Unofficial, self-hosted WhatsApp messaging gateway built on
> [Baileys](https://github.com/WhiskeySockets/Baileys). Not affiliated with,
> endorsed by, or sponsored by WhatsApp or Meta. Using this software to
> automate WhatsApp may breach WhatsApp's Terms of Service and can get the
> connected number banned. Use at your own risk, see
> [`docs/SELF_HOSTING.md`](./docs/SELF_HOSTING.md) for details.
>
> Hardened HTTP API in front of a Baileys-backed worker process.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-20_LTS-green.svg)](./.nvmrc)

This repository ships source and documentation only, no built binaries or
installers. Baileys depends on the GPL-3.0-licensed libsignal and the
LGPL-licensed codec-parser; if you redistribute built artefacts of this
project, check those licence obligations yourself.

## Using the SDK

Adding `@hmddevs/wa-sdk` to your service:

- [`docs/INTEGRATION.md`](./docs/INTEGRATION.md), onboard your service in 10 minutes.
- [`docs/SDK.md`](./docs/SDK.md), `@hmddevs/wa-sdk` reference.
- [`docs/API.md`](./docs/API.md), REST API reference.

## Architecture

Two components communicate over an always-outbound TLS Redis channel:

1. **`apps/gateway`**, Next.js 15, deployable to any Docker host or to Vercel.
   Public HTTPS API, admin dashboard, audit log, queue management.
2. **`apps/worker`**, Node process running the Baileys WhatsApp session,
   typically on a machine with no inbound ports.

Redis is the single ingress from the worker. The gateway is the single
ingress for all client services.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design.

## Repository layout

```
wa-gateway/
├── apps/
│   ├── gateway/         Next.js 15 HTTP API + admin (Docker or Vercel)
│   └── worker/          Baileys worker process (Docker or bare Node)
├── packages/
│   ├── sdk/             @hmddevs/wa-sdk, public client library
│   ├── protocol/        Shared Zod schemas + TS types (single source of truth)
│   └── config/          Shared tsconfig / eslint / prettier
├── scripts/             rotate-worker-token.sh, check-llms-corpus.mjs
├── docs/                ARCHITECTURE, SECURITY, SELF_HOSTING, CONTRIBUTING, API
├── docs-site/           VitePress site publishing docs/ to wa.hmd.bio
└── .github/             CI, Dependabot, issue templates
```

## Quick start (development)

```bash
# Prereqs: Node 20 LTS, pnpm 10
nvm use                           # reads .nvmrc
corepack enable && corepack prepare pnpm@10.10.0 --activate

pnpm install --frozen-lockfile    # scripts are disabled (.npmrc)
cp .env.example apps/gateway/.env.local
pnpm dev:gateway                  # http://localhost:3000
```

Worker development and Baileys pairing: see [`docs/SELF_HOSTING.md`](./docs/SELF_HOSTING.md).

## Docs site

The `docs/` folder is also published as a static VitePress site at
[wa.hmd.bio](https://wa.hmd.bio). Run it locally with:

```bash
cd docs-site && pnpm install && pnpm dev
```

## Security

- Vulnerability disclosure: see [`SECURITY.md`](./SECURITY.md).
- Public threat model: [`docs/SECURITY.md`](./docs/SECURITY.md).
- `SECURITY-IMPACT:` paragraphs are required on security-relevant PRs.

## Contributing

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md). Conventional Commits,
DCO sign-off; signed commits are appreciated.

## Licence

MIT, see [`LICENSE`](./LICENSE).
