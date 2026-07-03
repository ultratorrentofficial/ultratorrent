# Docker Deployment

UltraTorrent ships a complete Compose stack: a database, a cache, the API, and
the web UI — plus two optional services (a bundled rTorrent engine and an edge
reverse proxy) behind Compose **profiles**. The real files at the repo root are
`docker-compose.yml` (full stack), `docker-compose.dev.yml` (dependencies only),
`apps/backend/Dockerfile`, `apps/frontend/Dockerfile`,
`apps/frontend/nginx.conf`, `deploy/Caddyfile`, and `.env.example`.

- [Services](#services)
- [Quick start](#quick-start)
- [Environment](#environment)
- [Volumes & networks](#volumes--networks)
- [Health checks](#health-checks)
- [Optional profiles](#optional-profiles)
- [Development dependencies only](#development-dependencies-only)
- [Common commands](#common-commands)

---

## Services

From `docker-compose.yml`:

| Service | Image / build | Role | Ports | Profile |
|---------|---------------|------|-------|---------|
| `postgres` | `postgres:17-alpine` | PostgreSQL database | internal | always |
| `redis` | `redis:7-alpine` (AOF on) | Cache / jobs | internal | always |
| `backend` | build `apps/backend/Dockerfile` | NestJS API + WebSocket gateway | `4000:4000` | always |
| `frontend` | build `apps/frontend/Dockerfile` (nginx) | Built React SPA + `/api` & `/ws` proxy | `8080:80` | always |
| `rtorrent` | `crazymax/rtorrent-rutorrent:latest` | Bundled torrent engine exposing SCGI `5000` | internal | `rtorrent` |
| `proxy` | `caddy:2-alpine` | Edge reverse proxy / automatic TLS | `80:80`, `443:443` | `proxy` |

All services share an `internal` bridge network. The `backend` waits for
`postgres` and `redis` to report healthy; `frontend` and `proxy` depend on
`backend`.

> The `frontend` nginx config proxies `/api/` and (with WebSocket upgrade)
> `/ws/` to `http://backend:4000`, so in the default two-port setup the browser
> talks only to `:8080`.

## Quick start

```bash
cp .env.example .env          # then set strong JWT secrets, DB password, admin password
docker compose up -d --build

# First boot: the backend image runs `prisma migrate deploy` automatically on
# start (see its Dockerfile CMD). Seed the database once:
docker compose exec backend node -e "require('child_process')" >/dev/null 2>&1 || true
docker compose exec backend npx prisma db seed
```

Open `http://localhost:8080` and sign in with the default credentials
(`admin` / `changeme123!`), then change the password.

> The backend container's `CMD` is `prisma migrate deploy && node dist/main.js`,
> so migrations apply on every start. Seeding (permissions, roles, admin, default
> settings) is intentionally a separate one-time step.

## Environment

Compose reads variables from a root `.env` file; copy `.env.example` and adjust.
The keys the stack actually consumes:

```dotenv
# Backend
PORT=4000
NODE_ENV=production
CORS_ORIGIN=http://localhost:8080            # comma-separated origins allowed; split in main.ts

# Database
POSTGRES_USER=ultratorrent
POSTGRES_PASSWORD=change-me-postgres
POSTGRES_DB=ultratorrent
DATABASE_URL=postgresql://ultratorrent:change-me-postgres@postgres:5432/ultratorrent?schema=public

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Auth secrets — generate with: openssl rand -base64 48
JWT_ACCESS_SECRET=change-me-access-secret
JWT_REFRESH_SECRET=change-me-refresh-secret
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=30

# Bootstrap super admin (used by the seed)
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@ultratorrent.local
ADMIN_PASSWORD=changeme123!

# File manager allow-list (comma-separated absolute roots)
FILE_MANAGER_ROOTS=/downloads
```

The **frontend** image takes its API/WS targets at **build time** via build args
(`VITE_API_URL=/api`, `VITE_WS_URL=/`); the compose file passes same-origin
defaults so the SPA uses relative URLs proxied by nginx.

> `DATABASE_URL` must be set (the backend service references `${DATABASE_URL}`
> with no default). Point its host at the `postgres` service name and reuse the
> `POSTGRES_*` credentials, as in `.env.example`.

## Volumes & networks

| Volume | Used by | Purpose |
|--------|---------|---------|
| `postgres_data` | `postgres` | Persistent database |
| `redis_data` | `redis` | Redis AOF persistence |
| `downloads` | `backend`, `rtorrent` | Shared download tree — same path in both so engine `savePath`s line up with `FILE_MANAGER_ROOTS` |
| `rtorrent_data` | `rtorrent` | rTorrent session/state |
| `caddy_data` | `proxy` | Caddy certificates / state |

Network: a single `internal` bridge connects every service.

## Health checks

- **postgres** — `pg_isready -U $POSTGRES_USER`; the backend gates on
  `service_healthy`.
- **redis** — `redis-cli ping`.
- **backend** (in its Dockerfile) — probes
  `http://127.0.0.1:4000/api/system/live` (the public liveness endpoint).
- **frontend** (in its Dockerfile) — `wget` against `http://127.0.0.1/`.

## Optional profiles

The two optional services are behind Compose profiles and are **off by default**:

```bash
# Bring up the stack plus a bundled rTorrent engine
docker compose --profile rtorrent up -d --build
# Then register it in UltraTorrent: mode "scgi-tcp", host "rtorrent", port 5000.

# Add the Caddy edge proxy (TLS termination, single 80/443 entrypoint)
docker compose --profile proxy up -d

# Both
docker compose --profile rtorrent --profile proxy up -d --build
```

The `deploy/Caddyfile` routes `/api/*` and `/ws/*` to `backend:4000` and
everything else to `frontend:80`; replace the `:80` site label with your domain
to get automatic HTTPS via Let's Encrypt.

## Development dependencies only

To run the apps locally with `npm run dev` but get Postgres + Redis from Docker,
use the dev compose file (which publishes `5432` and `6379` to the host):

```bash
docker compose -f docker-compose.dev.yml up -d
# then, on the host:
npm run prisma:migrate && npm run prisma:seed && npm run dev
```

## Common commands

```bash
# Build and start everything
docker compose up -d --build

# Logs (all, or one service)
docker compose logs -f
docker compose logs -f backend

# Seed the database (first run)
docker compose exec backend npx prisma db seed

# Shell into the API container
docker compose exec backend sh

# Restart the backend after a config change
docker compose restart backend

# Status & health
docker compose ps

# Stop (keep data)
docker compose down

# Stop and DELETE all volumes (destroys the database!)
docker compose down -v
```
</content>
