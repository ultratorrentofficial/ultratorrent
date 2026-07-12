# Docker Deployment

UltraTorrent ships a complete Compose stack: a database, a cache, the API, and
the web UI — plus optional services (a bundled rTorrent engine, a bundled
qBittorrent engine, a Prowlarr indexer manager, a FlareSolverr Cloudflare solver,
and an edge reverse proxy) behind Compose **profiles**. The real files at the
repo root are `docker-compose.yml` (full stack), `docker-compose.dev.yml`
(dependencies only), `apps/backend/Dockerfile`, `apps/frontend/Dockerfile`,
`apps/frontend/nginx.conf`, `deploy/Caddyfile`, and `.env.example`.

- [Services](#services)
- [Quick start](#quick-start)
- [Environment](#environment)
- [Volumes & networks](#volumes--networks)
- [Health checks](#health-checks)
- [Bundled documentation](#bundled-documentation)
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
| `backend` | build `apps/backend/Dockerfile` | NestJS API + WebSocket gateway | internal (`expose: 4000`) | always |
| `frontend` | build `apps/frontend/Dockerfile` (unprivileged nginx) | Built React SPA + bundled docs + `/api` & `/ws` proxy | `${FRONTEND_PORT:-8080}:8080` | always |
| `rtorrent` | built locally from `deploy/rtorrent/` (jesec/rtorrent `v0.9.8-r16` static binary) | Bundled torrent engine exposing SCGI `5000` | internal | `rtorrent` |
| `qbittorrent` | `lscr.io/linuxserver/qbittorrent:latest` | Bundled torrent engine (Web API) — sturdier than rTorrent at scale | `${QBITTORRENT_PORT:-8081}:8080` | `qbittorrent` |
| `prowlarr` | `lscr.io/linuxserver/prowlarr:latest` | Optional Prowlarr indexer manager (companion) | `${PROWLARR_PORT:-9696}:9696` | `prowlarr` |
| `flaresolverr` | `ghcr.io/flaresolverr/flaresolverr:latest` | Optional Cloudflare solver for Prowlarr indexers | internal | `flaresolverr` |
| `proxy` | `caddy:2-alpine` | Edge reverse proxy / automatic TLS | `80:80`, `443:443` | `proxy` |

All services share an `internal` bridge network. The `backend` waits for
`postgres` and `redis` to report healthy; `frontend` and `proxy` depend on
`backend`.

> The `frontend` nginx config proxies `/api/` and (with WebSocket upgrade)
> `/ws/` to `http://backend:4000`, so the web UI port is the **only** port
> published to the host and the browser talks only to it. The frontend image is
> built on `nginx-unprivileged`, so the container listens on **8080**, not 80;
> the host port is `FRONTEND_PORT` (default `8080`). The backend is not
> published — add a `ports` mapping only if you want direct API access.

## Quick start

```bash
cp .env.example .env          # then set strong JWT secrets, DB password, admin password
docker compose up -d --build

# First boot: the backend image runs `prisma migrate deploy` automatically on
# start (see its Dockerfile CMD). Seed the database once:
docker compose exec backend npx prisma db seed
```

Open `http://localhost:8080` and sign in as `admin` (or your `ADMIN_USERNAME`)
with the `ADMIN_PASSWORD` you set in `.env`. There is **no** default password:
Compose refuses to start without `ADMIN_PASSWORD` and `POSTGRES_PASSWORD`, and
the backend refuses to boot in production without strong, distinct
`JWT_ACCESS_SECRET` / `ENCRYPTION_KEY`.

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
CORS_ORIGIN=http://localhost:8080            # comma-separated origins; split in bootstrap.ts

# Docker: host port the web UI is published on (the container listens on 8080)
FRONTEND_PORT=8080

# Database — REQUIRED. Use an ALPHANUMERIC password: Compose DERIVES DATABASE_URL
# from POSTGRES_USER/PASSWORD/DB, so a URL-special char (@ : /) would break it.
# Do NOT set DATABASE_URL for Docker — it is only for manual (non-Docker) installs.
POSTGRES_USER=ultratorrent
POSTGRES_PASSWORD=<strong, alphanumeric>     # required — Compose won't start without it

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Auth secrets — REQUIRED in production; generate each with: openssl rand -base64 48
# The backend refuses to boot if these are unset, a known default, or <32 chars.
JWT_ACCESS_SECRET=<random>
JWT_REFRESH_SECRET=<random>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=30

# Encrypts 2FA (TOTP) secrets at rest — REQUIRED, must DIFFER from JWT_ACCESS_SECRET
ENCRYPTION_KEY=<random>

# Bootstrap super admin (used by the seed) — ADMIN_PASSWORD is REQUIRED
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@ultratorrent.local
ADMIN_PASSWORD=<your admin login password>

# File manager allow-list (comma-separated absolute roots)
FILE_MANAGER_ROOTS=/downloads

# SSRF allow-list for torrent fetches — hosts/IPs/CIDRs whose .torrent links may
# resolve to a private/internal address. Defaults to `prowlarr` so the bundled
# indexer works; add your own private-IP indexer host here (keep `prowlarr` if
# you use it). Empty = full SSRF protection. See "SSRF & self-hosted indexers".
SSRF_ALLOW_HOSTS=prowlarr

# Optional bundled qBittorrent engine (profile `qbittorrent`) — host port for its
# Web UI (8080 is the frontend's, so this defaults to 8081)
QBITTORRENT_PORT=8081

# Optional bundled rTorrent / qBittorrent runtime user (downloads are written as it)
PUID=1000
PGID=1000

# Optional Prowlarr companion (profile `prowlarr`) — see PROWLARR.md
PROWLARR_PORT=9696
PROWLARR_BASE_URL=http://prowlarr:9696
PROWLARR_PUBLIC_URL=http://localhost:9696
TZ=Etc/UTC                                   # timezone for companion containers
```

`.env.example` is the source of truth for this list — check it if anything here
looks out of date.

### SSRF & self-hosted indexers

Auto-downloads (RSS rules, Smart Download, missing-episode acquisition) fetch the
indexer's `.torrent` link over HTTP. The backend's SSRF guard (`common/ssrf.ts`)
**blocks any URL that resolves to a private/internal address** unless its host is
in `SSRF_ALLOW_HOSTS`. This matters because a self-hosted indexer — including the
**bundled Prowlarr** at `http://prowlarr:9696` — returns proxy links on a private
Docker/LAN IP.

- The stack **defaults `SSRF_ALLOW_HOSTS=prowlarr`**, so the bundled indexer works
  out of the box.
- Using a **different** self-hosted indexer (Prowlarr/Jackett on your LAN, etc.)?
  Add its host: `SSRF_ALLOW_HOSTS=prowlarr,indexer.lan,10.0.0.0/24`. Entries are
  comma-separated hostnames, IPs, or IPv4 CIDRs.
- **Symptom if missing:** grabs fail with *"Torrent URL resolves to a blocked
  internal address"* and auto-downloads silently do nothing (the Prowlarr
  connection test still passes — that health check trusts private hosts; the
  torrent *fetch* is the stricter, separate guard).
- Scheme allow-list (`http(s)` only), redirect refusal, and the 20 MB body cap
  **still apply** to allow-listed hosts; only the private-address block is lifted,
  and only for the hosts you list.

The **frontend** image takes its API/WS targets at **build time** via build args
(`VITE_API_URL=/api`, `VITE_WS_URL=/`); the compose file passes same-origin
defaults so the SPA uses relative URLs proxied by nginx.

> **Do not set `DATABASE_URL` for Docker.** The `backend` service *derives* it
> from `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` against the
> `postgres` service, so it can't drift from the DB password. `DATABASE_URL` is
> only for manual (non-Docker) installs — see [INSTALL.md](INSTALL.md).

## Volumes & networks

| Volume | Used by | Purpose |
|--------|---------|---------|
| `postgres_data` | `postgres` | Persistent database |
| `redis_data` | `redis` | Redis AOF persistence |
| `downloads` | `backend`, `rtorrent`, `qbittorrent` | Shared download tree — same path in each so engine `savePath`s line up with `FILE_MANAGER_ROOTS`. rTorrent's session/state lives here too at `/downloads/.session` (no separate volume). |
| `prowlarr_config` | `prowlarr` | Prowlarr database, indexer definitions & settings |
| `qbittorrent_config` | `qbittorrent` | qBittorrent config, session & WebUI credentials |
| `caddy_data` | `proxy` | Caddy certificates / state |

Network: a single `internal` bridge connects every service.

## Health checks

- **postgres** — `pg_isready -U $POSTGRES_USER`; the backend gates on
  `service_healthy`.
- **redis** — `redis-cli ping`.
- **backend** (in its Dockerfile) — probes
  `http://127.0.0.1:4000/api/system/live` (the public liveness endpoint).
- **frontend** (in its Dockerfile) — `wget` against `http://127.0.0.1:8080/`
  (unprivileged nginx listens on 8080).
- **rtorrent** (in `docker-compose.yml`) — checks the SCGI control port is
  listening (`ss -H -ltn 'sport = :5000'`), surfacing a wedged-but-alive
  rTorrent as `unhealthy`.

## Bundled documentation

The frontend image **bundles this documentation site**, so a self-hosted install
carries the full manual offline, matching the exact version it runs. The
`apps/frontend/Dockerfile` has a `docs` stage that builds the Docusaurus site in
`website/` (English only) with `DOCS_BASE_URL=/docs/`, and the runtime stage
copies it into nginx's web root. `apps/frontend/nginx.conf` serves it from its
own `location /docs/` block (so a mistyped docs URL 404s instead of returning the
SPA shell).

Browse it at `http://localhost:8080/docs/` once the stack is up. Search is a
build-time index, so it works air-gapped. To work on the docs themselves, see
[BUILD.md](BUILD.md#documentation-site) — no separate container or profile is
involved.

## Optional profiles

The optional services are behind Compose profiles and are **off by default**:

```bash
# Bring up the stack plus a bundled rTorrent engine
docker compose --profile rtorrent up -d --build
# Then register it in UltraTorrent: mode "scgi-tcp", host "rtorrent", port 5000.

# ...or the bundled qBittorrent engine (recommended for large libraries)
docker compose --profile qbittorrent up -d
# 1. Get the first-run temporary password: docker compose logs qbittorrent
# 2. Open the Web UI (http://<host>:8081), log in as admin with that password,
#    and set your own username/password under Options → Web UI.
# 3. If a later "Test connection" fails with 401/unauthorized, disable
#    "Enable Host header validation" (or set Server domains to *) under
#    Options → Web UI — the backend connects by the service name qbittorrent.
# 4. Register it in UltraTorrent: Infrastructure → Engines → qBittorrent,
#    base URL http://qbittorrent:8080 + those credentials.

# Add the Prowlarr indexer manager (companion container)
docker compose --profile prowlarr up -d
# Then link it in UltraTorrent: Settings → Integrations → Prowlarr
# (internal URL http://prowlarr:9696 + the Prowlarr API key). See docs/PROWLARR.md.

# Add FlareSolverr so Prowlarr can reach Cloudflare-protected indexers (e.g. EZTV)
docker compose --profile prowlarr --profile flaresolverr up -d
# Then in Prowlarr: Settings → Indexers → add a FlareSolverr proxy at
# http://flaresolverr:8191, tag it, and tag the Cloudflare indexers. See docs/PROWLARR.md.

# Add the Caddy edge proxy (TLS termination, single 80/443 entrypoint)
docker compose --profile proxy up -d

# Several at once
docker compose --profile rtorrent --profile prowlarr --profile proxy up -d --build
```

The `deploy/Caddyfile` routes `/api/*` and `/ws/*` to `backend:4000` and
everything else to `frontend:8080` (the frontend image runs nginx unprivileged,
so it listens on 8080 — proxying to `frontend:80` yields a 502); replace the
`:80` site label with your domain to get automatic HTTPS via Let's Encrypt.

> **Bundled rTorrent — stability at scale.** The bundled engine is rTorrent
> `0.9.8` (the maintained jesec `v0.9.8-r16` static binary — the newest release;
> it replaced Debian's crashier apt build). That codebase has a long-standing
> upstream bug — `internal_error: priority_queue_insert(...) called on an invalid
> item`, fired during tracker-announce scheduling — that has **no fix in the
> 0.9.8 lineage** and gets **more frequent the more active torrents you run**
> (observed: ~0 crashes at a handful of torrents, ~10/day at ~750). A crash
> exits the process and the `restart: unless-stopped` policy relaunches it,
> reloading the saved session (no torrents lost), but transfers briefly pause and
> everything re-announces. Mitigations, in order of impact: **(1) keep the active
> torrent count modest** — remove/stop completed seeds; **(2) for a large
> library, use a sturdier engine** — UltraTorrent's engine layer is
> multi-engine, and qBittorrent handles thousands of torrents comfortably; **(3)**
> UDP tracker announces are disabled in `deploy/rtorrent/rtorrent.rc` to remove a
> secondary `TrackerList::receive_failed` crash variant (HTTP/HTTPS trackers +
> PEX still find peers). DHT is also off by default for the same reason
> (`RT_DHT=on` to enable).

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
