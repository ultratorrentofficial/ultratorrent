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

# ---- Runtime stage (unprivileged nginx) --------------------------------
# nginx-unprivileged runs as uid 101 and listens on 8080 (no root needed).
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
