# syntax=docker/dockerfile:1
# ---- Build stage --------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG VITE_API_URL=/api
ARG VITE_WS_URL=/
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/frontend/package.json apps/frontend/
RUN npm install

COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN npm run build --workspace @ultratorrent/shared \
  && npm run build --workspace @ultratorrent/frontend

# ---- Docs stage ---------------------------------------------------------
# The documentation ships inside the image, so a self-hosted install has the full
# manual offline — no internet, no wiki, matching the exact version it is running.
# Search is a build-time index (no Algolia), so it works air-gapped too.
#
# The reference pages are generated from the app's real exports. That needs
# @ultratorrent/shared compiled — already done in `build` above, which is why this
# stage extends it — plus the backend *sources* (controllers, module manifests,
# schema) that the generator reads. It deliberately does NOT need a compiled
# backend: the generator transpiles the one data file it imports on the fly.
FROM build AS docs
COPY apps/backend/src apps/backend/src
COPY apps/backend/prisma apps/backend/prisma
COPY .env.example ./
COPY website website
WORKDIR /app/website
RUN npm ci
# English only. es-PR is scaffolded but not yet translated, so bundling it would
# add ~20MB of duplicate English to every image for no reader benefit. Add it here
# once the translations actually exist.
# DOCS_NO_GIT: .dockerignore excludes .git, and Docusaurus' last-updated-time
# feature reads git history — it hard-fails without a worktree rather than
# degrading, so turn it off for this build only.
RUN npm run gen \
  && DOCS_URL=http://localhost:8080 DOCS_BASE_URL=/docs/ DOCS_NO_GIT=1 npm run build:en

# ---- Runtime stage (unprivileged nginx) --------------------------------
# nginx-unprivileged runs as uid 101 and listens on 8080 (no root needed).
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
COPY --from=docs /app/website/build /usr/share/nginx/html/docs
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
