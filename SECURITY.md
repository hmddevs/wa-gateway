# Security policy

## Supported versions

The `main` branch and the latest tagged release receive security fixes.
Pre-release branches are not supported.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Email **security@hmddevs.org** with:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept welcome).
- Your GitHub handle if you would like credit in release notes.

**Service levels.** We aim to acknowledge reports within **72 hours** and to
coordinate disclosure within **90 days**. Critical issues affecting production
will be prioritised.

## Safe-harbour for good-faith research

We will not pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  service interruption.
- Use only their own test accounts / API keys.
- Give us reasonable time to remediate before public disclosure.
- Do not exploit an issue beyond what is necessary to confirm it.

## Out of scope

- Denial-of-service via brute volume against public endpoints.
- Reports relying on outdated dependencies without a working exploit.
- Self-XSS and issues requiring physical access to the worker host.

## Handling process

1. Triage and confirm within 72h.
2. Assign a CVSS severity, open a private GitHub Security Advisory.
3. Prepare a fix in a private branch; add a regression test.
4. Coordinate release window with reporter.
5. Publish advisory, credit reporter (opt-in), tag release.

No public bug bounty at this time; reporters will be credited in release notes.
