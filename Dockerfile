# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# hmd-wa-gateway, multi-stage container for any Docker host
#
# Stage overview:
#   build, install the whole workspace with source present (so pnpm's
#             workspace symlinks resolve), compile @hmddevs/protocol, then run
#             the Next.js standalone build.
#   runner, minimal runtime image; copies only the standalone output.
#
# Node 20 on Debian bookworm-slim (glibc) is intentional. argon2@0.41.1 ships a
# prebuilt linux-x64-glibc binary; build-essential and python3 are present as a
# node-gyp fallback. Alpine (musl) is avoided, the glibc prebuild is not ABI
# compatible with musl.
#
# Why a single install with source present (not a split deps/build stage):
# @hmddevs/protocol is a workspace package resolved via a relative symlink
# (apps/gateway/node_modules/@hmddevs/protocol -> ../../../../packages/protocol)
# whose `exports` point at ./dist/*. Copying node_modules between stages and
# then layering source on top leaves that link unresolvable at `next build`
# time. Installing once, after the source is in place, mirrors the working
# local build exactly.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20
ARG DEBIAN_CODENAME=bookworm

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${DEBIAN_CODENAME}-slim AS build

WORKDIR /repo

# Toolchain for any native dependency that must compile from source (argon2
# falls back to node-gyp if its prebuild ABI does not match).
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

# Pin corepack to the exact pnpm version declared in the packageManager field.
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

# Copy the whole workspace. .dockerignore strips node_modules, .next, .git and
# all secrets, so this is source + manifests only.
COPY . .

# Install with the full workspace present so pnpm creates correct workspace
# symlinks. --frozen-lockfile is the reproducibility gate; argon2 is on the
# onlyBuiltDependencies allow-list so its postinstall selects the native binary.
RUN pnpm install --frozen-lockfile

# Confirm argon2 loads (catches ABI mismatch before the expensive Next build).
RUN node -e "require('./node_modules/.pnpm/argon2@0.41.1/node_modules/argon2/argon2.cjs'); console.log('argon2 load OK')"

# Build @hmddevs/protocol (emits packages/protocol/dist) then the Next.js
# gateway in standalone mode. The gateway build script chains both.
# SKIP_ENV_VALIDATION=1 stops the runtime env-validation module aborting the
# build when secrets are absent at image-build time.
ENV SKIP_ENV_VALIDATION=1
RUN pnpm --filter @hmddevs/gateway build


# ── Stage 2: runner ───────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${DEBIAN_CODENAME}-slim AS runner

WORKDIR /repo

# Non-root user for defence in depth.
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# ── Standalone output ──────────────────────────────────────────────────────
# next.config.mjs output:'standalone' + outputFileTracingRoot:'../..'.
# Next emits a self-contained server under .next/standalone/, preserving the
# monorepo structure. The entrypoint is apps/gateway/server.js once WORKDIR is
# the standalone root.
COPY --from=build --chown=nextjs:nodejs \
  /repo/apps/gateway/.next/standalone ./

# Static assets, Next standalone does NOT embed them; they sit alongside.
COPY --from=build --chown=nextjs:nodejs \
  /repo/apps/gateway/.next/static \
  ./apps/gateway/.next/static

# Public directory (robots.txt, icons, etc.).
COPY --from=build --chown=nextjs:nodejs \
  /repo/apps/gateway/public \
  ./apps/gateway/public

# ── Argon2 native binary safety net ───────────────────────────────────────
# nft traces argon2 into standalone, but only the platform-matching prebuild.
# Copy the full package from the pnpm store as belt-and-braces, a no-op if the
# trace already captured it, a fix if nft's behaviour shifts across versions.
COPY --from=build --chown=nextjs:nodejs \
  /repo/node_modules/.pnpm/argon2@0.41.1/node_modules/argon2 \
  ./node_modules/.pnpm/argon2@0.41.1/node_modules/argon2

USER nextjs

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000

# Standalone entrypoint, relative to WORKDIR (/repo = standalone root).
CMD ["node", "apps/gateway/server.js"]
