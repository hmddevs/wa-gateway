# Contributing

Thanks for your interest. This is a small project run by HMD Developments;
contributions are welcome.

## Ground rules

- All work happens in the open. No private `main`.
- **Never commit secrets, customer data, or HMD-specific configuration.**
  `gitleaks` runs in CI; violations block the PR.
- **TypeScript strict mode.** No `any` without a justifying comment.
- **British English** in all user-facing copy.
- **Conventional Commits** for commit messages and PR titles.
- **DCO sign-off** (`git commit -s`) required on every commit.
- **Signed commits** are appreciated, though not currently enforced.

## Workflow

1. Fork, branch off `main`.
2. `pnpm install --frozen-lockfile`.
3. Make your change; add tests.
4. `pnpm lint && pnpm typecheck && pnpm test` must pass locally.
5. Open a PR. Fill out the template in full.

## Security-sensitive changes

Any PR that touches auth, crypto, input validation, webhooks, Mongo writes,
Redis protocol, or the installer **must include a `SECURITY-IMPACT:`
paragraph** in the PR description explaining:

- What attack surface the change affects.
- Which threats from `docs/SECURITY.md` are impacted.
- Tests or review that mitigate regression risk.

## API changes

Any change to a public endpoint requires a row in `docs/API.md` in the same
PR.

## Reporting vulnerabilities

Please do not open a public issue. Email **security@hmddevs.org**, see
`/SECURITY.md`.

## Code of conduct

This project adopts the Contributor Covenant v2.1. By participating you
agree to abide by it.
