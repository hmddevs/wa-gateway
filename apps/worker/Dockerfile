# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# hmd-wa-worker, multi-stage container for any Docker host
#
# Stage overview:
#   build, install the whole workspace (source present so workspace symlinks
#             resolve), compile @hmddevs/protocol, then run the worker tsup
#             bundle which inlines ALL dependencies via noExternal:[/.*/].
#   runner, minimal runtime image; copies only apps/worker/dist (self-
#             contained CJS bundle, no node_modules required at runtime).
#
# Build context: REPO ROOT (build from the repo root with dockerfile =
# "apps/worker/Dockerfile"). The root .dockerignore applies, which already
# strips **/*.tsbuildinfo, critical because a stale tsbuildinfo causes tsc
# to skip emitting @hmddevs/protocol/dist, breaking the worker build.
#
# Node 20 on Debian bookworm-slim (glibc) mirrors the gateway image choice.
# Alpine (musl) is avoided, Baileys depends on native WebCrypto bindings
# that are not musl-compatible.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20
ARG DEBIAN_CODENAME=bookworm

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${DEBIAN_CODENAME}-slim AS build

WORKDIR /repo

# Pin corepack to the exact pnpm version declared in packageManager.
# No native deps in the worker, so build-essential / python3 are not needed.
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

# Copy the whole workspace. .dockerignore strips node_modules, dist, .git,
# secrets, and *.tsbuildinfo so we get source + manifests only.
COPY . .

# Install with the full workspace present so pnpm creates correct workspace
# symlinks (apps/worker/node_modules/@hmddevs/protocol → packages/protocol).
# --frozen-lockfile is the reproducibility gate.
RUN pnpm install --frozen-lockfile

# Build @hmddevs/protocol first (emits packages/protocol/dist).
# The worker's tsup bundle resolves the workspace package at build time via
# the symlink above, so protocol/dist must exist before tsup runs.
RUN pnpm --filter @hmddevs/protocol build

# Build the worker. tsup bundles with noExternal:[/.*/], every dependency,
# including @hmddevs/protocol and Baileys, is inlined into dist/index.js.
RUN pnpm --filter @hmddevs/worker build

# Confirm the bundle exists and is non-trivial (exits 1 if file is missing or
# suspiciously small, guards against a silent tsup no-op).
RUN test -f apps/worker/dist/index.js && \
    [ "$(wc -c < apps/worker/dist/index.js)" -gt 1000000 ] && \
    echo "Worker bundle OK ($(wc -c < apps/worker/dist/index.js) bytes)"


# ── Stage 2: runner ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${DEBIAN_CODENAME}-slim AS runner

WORKDIR /app

# Non-root user for defence in depth.
RUN addgroup --system --gid 1001 worker && \
    adduser  --system --uid 1001 --ingroup worker workeruser

# Copy only the self-contained bundle, no node_modules required at runtime.
COPY --from=build --chown=workeruser:worker \
  /repo/apps/worker/dist ./dist

USER workeruser

ENV NODE_ENV=production

# No EXPOSE: the worker's Fastify UI binds to 127.0.0.1:7823 (loopback only)
# and is never reachable from outside the VM. All external traffic is outbound
# (Upstash Redis + HTTPS to gateway).

CMD ["node", "dist/index.js"]
