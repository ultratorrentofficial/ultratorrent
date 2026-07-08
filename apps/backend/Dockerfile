# syntax=docker/dockerfile:1
# ---- Build stage --------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Prisma needs OpenSSL to detect the correct query-engine target when it
# generates the client below.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Install root + workspace manifests first for better layer caching.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
# VERSION is the source of truth for the product version; baked in so the
# runtime resolver reports the right version without a build arg.
COPY VERSION ./VERSION
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
# npm may keep some workspace deps NESTED (e.g. otplib under apps/backend/
# node_modules) instead of hoisting to root. mkdir guarantees the dirs exist so
# the runtime COPYs below never fail regardless of npm's hoisting decision.
RUN npm install && mkdir -p apps/backend/node_modules packages/shared/node_modules

# Copy sources and build shared + backend (incl. prisma client).
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN npm run build --workspace @ultratorrent/shared \
  && npx --workspace @ultratorrent/backend prisma generate \
  && npm run build --workspace @ultratorrent/backend

# ---- Runtime stage ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# Version/edition surfaced by GET /api/system/version. The version resolver
# reads ULTRATORRENT_VERSION env → the baked-in VERSION file → fallback, so a
# plain `docker compose up --build` reports the real version. The build arg is
# an optional override (npm run package:community passes $(cat VERSION)); it
# defaults to empty so it doesn't shadow the VERSION file.
ARG ULTRATORRENT_VERSION=
ARG GIT_SHA=
# Optional exact `git describe` tag (.git is not in the build context, so it must
# be passed in). Empty → backend falls back to `v<VERSION>`.
ARG GIT_TAG=
# Optional ISO build timestamp, surfaced in About. Empty → backend reports "dev".
ARG BUILD_TIME=
ENV NODE_ENV=production \
    ULTRATORRENT_EDITION=community \
    ULTRATORRENT_VERSION=${ULTRATORRENT_VERSION} \
    GIT_SHA=${GIT_SHA} \
    GIT_TAG=${GIT_TAG} \
    BUILD_TIME=${BUILD_TIME}
WORKDIR /app

# OpenSSL so Prisma detects the right query engine at runtime (else it warns and
# defaults to a wrong target).
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# argon2 needs no build tools at runtime when prebuilt; copy node_modules.
# `--chown=node:node` so the non-root user below can write the Prisma engine
# cache under node_modules at runtime.
COPY --from=build --chown=node:node /app/VERSION ./VERSION
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# Nested (non-hoisted) workspace deps live here — must be copied too or Node
# can't resolve them at runtime (e.g. `Cannot find module 'otplib'`).
COPY --from=build --chown=node:node /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=build --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/apps/backend/dist ./apps/backend/dist
COPY --from=build --chown=node:node /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build --chown=node:node /app/apps/backend/prisma ./apps/backend/prisma

WORKDIR /app/apps/backend
# Drop privileges: the node:22 image ships an unprivileged `node` user (uid
# 1000). Files are chowned to it above so migrations/Prisma can write.
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/system/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply migrations then start. (Seed is run separately on first boot.)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
