---
id: environment
title: Environment Variables
sidebar_position: 4
description: Every environment variable UltraTorrent reads, its default, and what it does.
keywords: [environment, env, configuration, docker, compose, settings, secrets]
---

# Environment Variables

:::info Auto-generated
This page is generated from `.env.example` at build time. **Do not edit it by hand** — change the source and rebuild. This guarantees the reference always matches the code that ships.
:::

UltraTorrent is configured with environment variables (typically via `.env` next to your
`docker-compose.yml`). **38 variables** are recognised.

:::warning Secrets
Never commit a real `.env`. Rotate `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` if they leak —
doing so invalidates every issued token. See [Security](/operate/security).
:::

## Required in production

The backend **refuses to boot** in production if these are unset, left at a known default, or too weak.

| Variable | Notes |
| --- | --- |
| `POSTGRES_PASSWORD` | Database (PostgreSQL) REQUIRED: set a strong, ALPHANUMERIC password (Compose won't start without it). For DOCKER installs this is the only DB value you need — the backend derives DATABASE_URL from POSTGRES_USER/PASSWORD/DB automatically. |
| `JWT_ACCESS_SECRET` | Auth secrets — REQUIRED in production; generate each with: openssl rand -base64 48 The backend REFUSES to boot in production if these are unset, a known default, or shorter than 32 chars. JWT_ACCESS_SECRET and ENCRYPTION_KEY must DIFFER. |
| `JWT_REFRESH_SECRET` | Auth secrets — REQUIRED in production; generate each with: openssl rand -base64 48 The backend REFUSES to boot in production if these are unset, a known default, or shorter than 32 chars. JWT_ACCESS_SECRET and ENCRYPTION_KEY must DIFFER. |
| `ENCRYPTION_KEY` | Encrypts 2FA (TOTP) secrets at rest — REQUIRED, must be different from JWT_ACCESS_SECRET. Generate with: openssl rand -base64 48 Changing it invalidates stored TOTP secrets. |
| `ADMIN_PASSWORD` | Bootstrap super admin (used by the seed script) REQUIRED: set a strong password (only used to create the admin on first seed). |

Generate strong secrets:

```bash
openssl rand -base64 48   # run once per secret — they must differ
```

## All variables

| Variable | Default | Set by default | Description |
| --- | --- | :---: | --- |
| `PRODUCT_NAME` | `UltraTorrent` | ✅ | Product |
| `PORT` | `4000` | ✅ | Backend |
| `NODE_ENV` | `production` | ✅ | Backend |
| `CORS_ORIGIN` | `http://localhost:5173` | ✅ | Backend |
| `FRONTEND_PORT` | `8080` | ✅ | Docker: host port the web UI is published on (change if 8080 is already in use — common on NAS devices). The backend is not published to the host. |
| `POSTGRES_USER` | `ultratorrent` | ✅ | Database (PostgreSQL) REQUIRED: set a strong, ALPHANUMERIC password (Compose won't start without it). For DOCKER installs this is the only DB value you need — the backend derives DATABASE_URL from POSTGRES_USER/PASSWORD/DB automatically. |
| `POSTGRES_PASSWORD` | _(empty)_ | ✅ | Database (PostgreSQL) REQUIRED: set a strong, ALPHANUMERIC password (Compose won't start without it). For DOCKER installs this is the only DB value you need — the backend derives DATABASE_URL from POSTGRES_USER/PASSWORD/DB automatically. |
| `POSTGRES_DB` | `ultratorrent` | ✅ | Database (PostgreSQL) REQUIRED: set a strong, ALPHANUMERIC password (Compose won't start without it). For DOCKER installs this is the only DB value you need — the backend derives DATABASE_URL from POSTGRES_USER/PASSWORD/DB automatically. |
| `DATABASE_URL` | `postgresql://ultratorrent:REPLACE_WITH_PASSWORD@localhost:5432/ultratorrent?schema=public` | — | DATABASE_URL: only needed for MANUAL (non-Docker) installs; point at your DB (host is usually localhost). Ignored by the Docker stack. |
| `REDIS_HOST` | `redis` | ✅ | Redis (cache / BullMQ) |
| `REDIS_PORT` | `6379` | ✅ | Redis (cache / BullMQ) |
| `JWT_ACCESS_SECRET` | _(empty)_ | ✅ | Auth secrets — REQUIRED in production; generate each with: openssl rand -base64 48 The backend REFUSES to boot in production if these are unset, a known default, or shorter than 32 chars. JWT_ACCESS_SECRET and ENCRYPTION_KEY must DIFFER. |
| `JWT_REFRESH_SECRET` | _(empty)_ | ✅ | Auth secrets — REQUIRED in production; generate each with: openssl rand -base64 48 The backend REFUSES to boot in production if these are unset, a known default, or shorter than 32 chars. JWT_ACCESS_SECRET and ENCRYPTION_KEY must DIFFER. |
| `JWT_ACCESS_TTL` | `15m` | ✅ | Auth secrets — REQUIRED in production; generate each with: openssl rand -base64 48 The backend REFUSES to boot in production if these are unset, a known default, or shorter than 32 chars. JWT_ACCESS_SECRET and ENCRYPTION_KEY must DIFFER. |
| `JWT_REFRESH_TTL_DAYS` | `30` | ✅ | Auth secrets — REQUIRED in production; generate each with: openssl rand -base64 48 The backend REFUSES to boot in production if these are unset, a known default, or shorter than 32 chars. JWT_ACCESS_SECRET and ENCRYPTION_KEY must DIFFER. |
| `ENCRYPTION_KEY` | _(empty)_ | ✅ | Encrypts 2FA (TOTP) secrets at rest — REQUIRED, must be different from JWT_ACCESS_SECRET. Generate with: openssl rand -base64 48 Changing it invalidates stored TOTP secrets. |
| `ADMIN_USERNAME` | `admin` | ✅ | Bootstrap super admin (used by the seed script) REQUIRED: set a strong password (only used to create the admin on first seed). |
| `ADMIN_EMAIL` | `admin@ultratorrent.local` | ✅ | Bootstrap super admin (used by the seed script) REQUIRED: set a strong password (only used to create the admin on first seed). |
| `ADMIN_PASSWORD` | _(empty)_ | ✅ | Bootstrap super admin (used by the seed script) REQUIRED: set a strong password (only used to create the admin on first seed). |
| `FILE_MANAGER_ROOTS` | `/downloads` | ✅ | File manager — comma-separated absolute roots the browser may access |
| `TMDB_API_KEY` | _(empty)_ | — | Media metadata providers The IMDb provider needs NO environment variables: it is configured entirely from the UI (Media > Settings > IMDb) and works from user-provided IMDb datasets and/or an optional licensed IMDb API. UltraTorrent does not scrape IMDb web pages. The IMDb API base URL and key are stored in Settings (the key is AES-GCM encrypted at rest), never in this file. The optional keys below are ONLY fallbacks for cross-provider enrichment (TMDB /find and OMDb lookups by IMDb id). They are read only if the matching Settings value is unset. Leave blank to configure them in the UI instead. |
| `OMDB_API_KEY` | _(empty)_ | — | Media metadata providers The IMDb provider needs NO environment variables: it is configured entirely from the UI (Media > Settings > IMDb) and works from user-provided IMDb datasets and/or an optional licensed IMDb API. UltraTorrent does not scrape IMDb web pages. The IMDb API base URL and key are stored in Settings (the key is AES-GCM encrypted at rest), never in this file. The optional keys below are ONLY fallbacks for cross-provider enrichment (TMDB /find and OMDb lookups by IMDb id). They are read only if the matching Settings value is unset. Leave blank to configure them in the UI instead. |
| `VITE_API_URL` | `http://localhost:4000/api` | ✅ | Frontend (build-time) |
| `VITE_WS_URL` | `http://localhost:4000` | ✅ | Frontend (build-time) |
| `RTORRENT_SCGI_HOST` | `rtorrent` | ✅ | Optional bundled rTorrent engine (see docker-compose) |
| `RTORRENT_SCGI_PORT` | `5000` | ✅ | Optional bundled rTorrent engine (see docker-compose) |
| `PUID` | `1000` | — | Run the bundled rtorrent (and thus downloaded files) as this user/group. Default 1000 matches the app. If your downloads folder is owned by another user (e.g. Plex), set these to that user's id/gid — find them with `id plex` — so downloads are written as that user without changing the folder's owner. |
| `PGID` | `1000` | — | Run the bundled rtorrent (and thus downloaded files) as this user/group. Default 1000 matches the app. If your downloads folder is owned by another user (e.g. Plex), set these to that user's id/gid — find them with `id plex` — so downloads are written as that user without changing the folder's owner. |
| `RT_DHT` | `off` | — | Enable DHT on the bundled rtorrent (default off — this build can crash on a DHT internal_error; trackers + PEX still find peers). Set to on to enable. |
| `QBITTORRENT_PORT` | `8081` | ✅ | Optional bundled qBittorrent engine (profile `qbittorrent`) — the sturdier alternative to rTorrent for large libraries. Enable with: docker compose --profile qbittorrent up -d Then grab the first-run temporary password from `docker compose logs qbittorrent`, set your own in the Web UI, and register the engine in UltraTorrent (Infrastructure → Engines → qBittorrent, base URL http://qbittorrent:8080). Host port the Web UI is published on (8080 is the frontend's, so this defaults to 8081): |
| `TZ` | `Etc/UTC` | — | Timezone for bundled companion containers (e.g. Prowlarr). Any tz database name, e.g. America/New_York. Defaults to Etc/UTC. |
| `PROWLARR_PORT` | `9696` | ✅ | Optional Prowlarr companion (indexer manager) — see docker-compose profile `prowlarr` and docs/PROWLARR.md. Prowlarr runs as a SEPARATE optional container; UltraTorrent only links to it. Enable with: docker compose --profile prowlarr up -d UltraTorrent boots fine without it. The API key is entered in the UI (Settings → Integrations → Prowlarr) and stored AES-GCM encrypted — never here. Host port the Prowlarr web UI is published on (change if 9696 is taken). Internal URL the backend uses to reach Prowlarr over the Docker network. Public URL the browser uses for the "Open Prowlarr" link / nav shortcut. Convenience default only; the real toggle lives in UltraTorrent settings. |
| `PROWLARR_BASE_URL` | `http://prowlarr:9696` | ✅ | Optional Prowlarr companion (indexer manager) — see docker-compose profile `prowlarr` and docs/PROWLARR.md. Prowlarr runs as a SEPARATE optional container; UltraTorrent only links to it. Enable with: docker compose --profile prowlarr up -d UltraTorrent boots fine without it. The API key is entered in the UI (Settings → Integrations → Prowlarr) and stored AES-GCM encrypted — never here. Host port the Prowlarr web UI is published on (change if 9696 is taken). Internal URL the backend uses to reach Prowlarr over the Docker network. Public URL the browser uses for the "Open Prowlarr" link / nav shortcut. Convenience default only; the real toggle lives in UltraTorrent settings. |
| `PROWLARR_PUBLIC_URL` | `http://localhost:9696` | ✅ | Optional Prowlarr companion (indexer manager) — see docker-compose profile `prowlarr` and docs/PROWLARR.md. Prowlarr runs as a SEPARATE optional container; UltraTorrent only links to it. Enable with: docker compose --profile prowlarr up -d UltraTorrent boots fine without it. The API key is entered in the UI (Settings → Integrations → Prowlarr) and stored AES-GCM encrypted — never here. Host port the Prowlarr web UI is published on (change if 9696 is taken). Internal URL the backend uses to reach Prowlarr over the Docker network. Public URL the browser uses for the "Open Prowlarr" link / nav shortcut. Convenience default only; the real toggle lives in UltraTorrent settings. |
| `PROWLARR_ENABLED` | `false` | ✅ | Optional Prowlarr companion (indexer manager) — see docker-compose profile `prowlarr` and docs/PROWLARR.md. Prowlarr runs as a SEPARATE optional container; UltraTorrent only links to it. Enable with: docker compose --profile prowlarr up -d UltraTorrent boots fine without it. The API key is entered in the UI (Settings → Integrations → Prowlarr) and stored AES-GCM encrypted — never here. Host port the Prowlarr web UI is published on (change if 9696 is taken). Internal URL the backend uses to reach Prowlarr over the Docker network. Public URL the browser uses for the "Open Prowlarr" link / nav shortcut. Convenience default only; the real toggle lives in UltraTorrent settings. |
| `SSRF_ALLOW_HOSTS` | `prowlarr,indexer.lan,10.0.0.0/24` | — | SSRF allow-list for torrent fetches. Auto-downloads fetch the indexer's .torrent link over HTTP; the SSRF guard blocks any URL resolving to a private/internal address UNLESS its host is listed here (comma-separated hostnames, IPs, or IPv4 CIDRs). This is REQUIRED for any self-hosted indexer on a private IP — WITHOUT it, grabs fail with "Torrent URL resolves to a blocked internal address" and auto-downloads silently do nothing. Defaults to `prowlarr` (docker-compose.yml) so the bundled Prowlarr just works. Add your own indexer host and KEEP `prowlarr` if you use the bundled one: Leave unset for the `prowlarr` default; set empty for full SSRF protection. |
| `SSRF_ALLOW_HOSTS` | `prowlarr` | — | SSRF allow-list for torrent fetches. Auto-downloads fetch the indexer's .torrent link over HTTP; the SSRF guard blocks any URL resolving to a private/internal address UNLESS its host is listed here (comma-separated hostnames, IPs, or IPv4 CIDRs). This is REQUIRED for any self-hosted indexer on a private IP — WITHOUT it, grabs fail with "Torrent URL resolves to a blocked internal address" and auto-downloads silently do nothing. Defaults to `prowlarr` (docker-compose.yml) so the bundled Prowlarr just works. Add your own indexer host and KEEP `prowlarr` if you use the bundled one: Leave unset for the `prowlarr` default; set empty for full SSRF protection. |
| `FLARESOLVERR_LOG_LEVEL` | `info` | — | Optional FlareSolverr companion (indexer proxy) — see docker-compose profile `flaresolverr` and docs/PROWLARR.md. Solves Cloudflare anti-bot challenges for Prowlarr indexers (e.g. EZTV). Internal-only; Prowlarr reaches it at http://flaresolverr:8191. Enable with: docker compose --profile prowlarr --profile flaresolverr up -d |

A **—** in _Set by default_ means the variable is commented out in `.env.example`: it is optional, and only needed for the case its description names (typically a manual, non-Docker install).

## See also

- [Docker Compose install](/install/docker-compose)
- [Configuration profiles](/operate/configuration-profiles) — home vs. large library vs. enterprise
