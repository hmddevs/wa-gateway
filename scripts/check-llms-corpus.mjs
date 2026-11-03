#!/usr/bin/env node
/**
 * Guard against drift between the API's source of truth and the hand-maintained
 * reference docs.
 *
 * Why this exists: `llms-full.txt` is served publicly and `/docs` tells agents it
 * is "the complete HTTP integration" reference, but nothing generated or checked
 * it. Between 2026-06-28 and 2026-07-17 it silently drifted, missing group
 * sending, `GET /v1/groups`, the `read:groups` scope and `GET /api/health`, while
 * also asserting a fabricated `GET /v1/worker/status` shape. Agents integrating
 * from it were being misled. `docs/API.md` is hand-maintained with the same
 * exposure, so it is gated here too.
 *
 * These files stay hand-written on purpose: the prose and guidance are what make
 * them useful. This check only asserts COVERAGE, so a human still writes the
 * words but cannot forget the endpoint.
 *
 * Asserts, for each target file:
 *   1. Every operation in `openapi.json` appears as `METHOD /path` (path params
 *      normalised, so `/v1/messages/{id}` matches `:messageId`).
 *   2. Every scope in the protocol's `ApiKeyScopeSchema` appears.
 *
 * Deliberately NOT asserted: response shapes and numeric bounds. Matching those
 * reliably needs prose parsing, and a flaky guard gets disabled. Those remain a
 * review concern: note that the worst drift found in July 2026 (a fabricated
 * response shape and a wrong `to` bound) was of exactly that class, so this
 * check is a floor, not a guarantee.
 *
 * Run: `pnpm check:llms` (also runs in CI).
 */
import { readFileSync } from 'node:fs';

const OPENAPI = 'apps/gateway/public/openapi.json';
const PROTOCOL_DB = 'packages/protocol/src/db.ts';

/** Hand-maintained references that must cover the whole public API surface. */
const TARGETS = ['apps/gateway/public/llms-full.txt', 'docs/API.md'];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * openapi schemas whose enum values are part of the request contract (a caller
 * picks them), so every value must be documented. Kept to request-side enums to
 * avoid firing on internal/reserved states.
 */
const ENUM_CONTRACT_SCHEMAS = ['MessagePurpose', 'MessageChannel'];

/** `/v1/messages/{id}` and `/v1/messages/:messageId` both become `/v1/messages/{}`. */
function normalisePath(path) {
  return path.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z0-9_]+/g, '{}');
}

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`check-llms-corpus: cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
}

const spec = JSON.parse(read(OPENAPI));

const operations = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(item)) {
    if (!HTTP_METHODS.includes(method)) continue;
    operations.push({ method: method.toUpperCase(), path, operationId: op.operationId });
  }
}
if (operations.length === 0) {
  console.error(`check-llms-corpus: parsed zero operations from ${OPENAPI}; refusing to pass.`);
  process.exit(2);
}

const enumBlock = read(PROTOCOL_DB).match(/ApiKeyScopeSchema = z\.enum\(\[([\s\S]*?)\]\)/);
if (!enumBlock) {
  console.error(
    `check-llms-corpus: could not parse ApiKeyScopeSchema from ${PROTOCOL_DB}. The guard cannot verify scopes, so failing loudly rather than passing silently.`,
  );
  process.exit(2);
}
const scopes = [...enumBlock[1].matchAll(/'([a-z:_]+)'/g)].map((m) => m[1]);
if (scopes.length === 0) {
  console.error(`check-llms-corpus: parsed zero scopes from ${PROTOCOL_DB}; refusing to pass.`);
  process.exit(2);
}

const failures = [];

for (const target of TARGETS) {
  const text = read(target);
  const documented = new Set(
    [...text.matchAll(/(GET|POST|PUT|PATCH|DELETE)\s+`?(\/[A-Za-z0-9_/:{}.-]*)/g)].map(
      (m) => `${m[1]} ${normalisePath(m[2])}`,
    ),
  );

  for (const op of operations) {
    if (!documented.has(`${op.method} ${normalisePath(op.path)}`)) {
      failures.push(
        `${target}: ${op.method} ${op.path} (operationId: ${op.operationId ?? 'none'}) is defined in ${OPENAPI} but absent`,
      );
    }
  }
  for (const scope of scopes) {
    if (!text.includes(scope)) {
      failures.push(`${target}: scope \`${scope}\` is in ApiKeyScopeSchema but absent`);
    }
  }
  // Request-contract enum values: a caller chooses these, so a missing value is
  // an undocumented-but-accepted input. This is the class that drifted in July
  // 2026 (openapi listed 7 `purpose` values while the route accepted 10), which
  // the operation/scope checks above could not catch.
  for (const schema of ENUM_CONTRACT_SCHEMAS) {
    const values = spec.components?.schemas?.[schema]?.enum ?? [];
    for (const value of values) {
      if (!text.includes(value)) {
        failures.push(`${target}: ${schema} value \`${value}\` is in ${OPENAPI} but absent`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\ncheck-llms-corpus: the reference docs have drifted from the API.\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nThese files are the public contract: llms-full.txt is served to agents as the complete\nHTTP reference, and docs/API.md is the human one. Update them in this PR so they stay\ntrue, then re-run \`pnpm check:llms\`.\n`,
  );
  process.exit(1);
}

console.log(
  `check-llms-corpus: OK (${operations.length} operations, ${scopes.length} scopes covered in ${TARGETS.length} reference docs)`,
);
