---
layout: home
title: HMD WA Gateway
---

# HMD WA Gateway

> Unofficial, self-hosted WhatsApp messaging gateway built on
> [Baileys](https://github.com/WhiskeySockets/Baileys). Not affiliated with,
> endorsed by, or sponsored by WhatsApp or Meta. Using this software to
> automate WhatsApp may breach WhatsApp's Terms of Service and can get the
> connected number banned. Use at your own risk, see
> [Self-hosting](./SELF_HOSTING) for details.

The hosted service this documentation originally described is discontinued.
This site now documents the source only, for anyone who wants to self-host
their own gateway from the [`wa-gateway`](https://github.com/hmddevs/wa-gateway)
repository.

This repository ships source and documentation only, no built binaries or
installers. Baileys depends on the GPL-3.0-licensed libsignal and the
LGPL-licensed codec-parser; if you redistribute built artefacts of this
project, check those licence obligations yourself.

## Where to start

- [Self-hosting](./SELF_HOSTING), run the gateway and worker from source.
- [Integration](./INTEGRATION), wire a service into the gateway.
- [API reference](./API), the raw HTTP surface.
- [SDK reference](./SDK), the typed `@hmddevs/wa-sdk` client.
- [Architecture](./ARCHITECTURE), how the gateway and worker fit together.

## SDK usage

```ts
import { hmdWA } from '@hmddevs/wa-sdk';

const wa = hmdWA({ baseUrl: 'https://wa.example.com' }); // reads HMD_WA_API_KEY
const res = await wa.send({
  to: '+447700900123',
  purpose: 'transactional',
  body: { kind: 'text', text: 'Hello' },
});
console.log(res.messageId, res.status); // → "8e8f3a26-…", "queued"
```

`baseUrl` is required, set it to your own self-hosted gateway's base URL. See
the [SDK reference](./SDK) for the full configuration and method list.

## Source

Full source, issue tracker and licence: [github.com/hmddevs/wa-gateway](https://github.com/hmddevs/wa-gateway).
