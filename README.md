<div align="center">

# UltraTorrent

**A modern, self-hosted Media Acquisition & Management Platform.**

UltraTorrent is far more than a torrent downloader: it acquires, organizes, and
manages media end to end. It puts a clean, fast, multi-user web UI in front of
your existing BitTorrent engines, speaking to engines like **rTorrent** through a
pluggable provider abstraction, then layers on RSS automation, media
identification, metadata/artwork/subtitle management, NFO generation, a rename
engine, media-server integrations, real-time updates, granular role-based access
control, and a full audit trail.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](#license)
![Node](https://img.shields.io/badge/node-%3E%3D20-43853d.svg)
![Version](https://img.shields.io/badge/version-0.10.0-blue.svg)

</div>

---

## Table of contents

- [What is UltraTorrent?](#what-is-ultratorrent)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Screenshots](#screenshots)
- [Architecture at a glance](#architecture-at-a-glance)
- [Quick start](#quick-start)
  - [Option A — Docker Compose](#option-a--docker-compose)
  - [Option B — Manual / local dev](#option-b--manual--local-dev)
- [Admin account](#admin-account)
- [Project structure](#project-structure)
- [Documentation](#documentation)
- [Security](#security)
- [License](#license)

---

## What is UltraTorrent?

UltraTorrent is a **Media Acquisition & Management Platform**, not a desktop
BitTorrent app. Downloading is only the first step: it controls one or more
existing torrent engines over their native control protocol, then identifies,
enriches, renames, files, and publishes the result to your media servers. The
browser UI never talks to an engine directly — it talks to the UltraTorrent API,
which translates requests into the engine's protocol and returns **normalized**
data. That single seam (the `TorrentEngineProvider` interface) is one of several
provider abstractions that let UltraTorrent add engines, metadata sources, and
integrations without touching any UI or business logic.

The current release ships a complete **rTorrent** provider (XML-RPC over SCGI);
qBittorrent, Transmission, and Deluge are first-class targets of the same
interface and are planned. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full platform
architecture.

## Features

- **Engine-agnostic core** — all torrents, files, peers, and trackers are
  exposed as normalized DTOs. Adding an engine never changes the UI.
- **rTorrent provider** — full control via XML-RPC over SCGI (TCP, Unix socket)
  or HTTP, including add / remove / start / stop / recheck / move / file
  priorities / trackers / rate limits.
- **Add torrents many ways** — magnet links, `.torrent` file upload, or remote
  `.torrent` URL.
- **Real-time UI** — a background sync loop polls each engine and fans live
  torrent lists, global stats, and engine status out to clients over WebSocket.
- **Role-based access control** — granular, dot-namespaced permissions (e.g.
  `torrents.delete_data`) grouped into system roles from Super Admin to
  Read-Only.
- **Secure auth** — Argon2id password hashing, short-lived JWT access tokens,
  and rotating refresh tokens with reuse detection.
- **Audit logging** — every destructive and security-relevant action is recorded
  with actor, IP, user agent, and result.
- **Dashboard** — at-a-glance totals, transfer rates, state breakdown, ratio,
  and recent activity.
- **Categories & tags** — organize torrents with managed taxonomies.
- **Built-in file manager** — browse, preview, download, rename, move, copy,
  delete, and mkdir within a strict allow-list of roots.
- **Media Manager** — organize a media library: root-restricted folder scanning,
  filename identification, metadata (local NFO + optional TMDB, plus compliant
  IMDb metadata from user-provided IMDb datasets or a licensed IMDb API — never
  web scraping), artwork and subtitle management, NFO generation, template
  renaming (hardlink/symlink/move), duplicate detection, and
  Plex/Jellyfin/Emby/Kodi integrations, with a post-download workflow and live
  job progress over WebSocket.
- **RSS automation** — feeds with include/exclude rules that auto-download
  matches to the default engine.
- **Rules engine** — condition/action automation triggered by events such as
  `torrent.completed`, with logging and failure notifications.
- **Notifications** — in-app plus fan-out to webhook, Discord, Slack, and
  Telegram; completed downloads notify automatically.
- **User & role management** — create users, assign roles, manage API keys, and
  edit platform settings from the API.
- **Global search** — fast lookup across persisted torrent snapshots.
- **Health & probes** — public liveness/readiness endpoints plus an authenticated
  health report (process, per-engine, and disk usage).
- **OpenAPI / Swagger** — interactive API docs generated from the controllers.
- **Implemented React + Vite UI** — auth flow, dashboard, real-time torrents
  grid, detail drawer, and add-torrent dialog, styled with Tailwind.

## Tech stack

| Layer        | Technology |
|--------------|------------|
| Monorepo     | npm workspaces (`packages/*`, `apps/*`), TypeScript 5.5 |
| Backend      | NestJS 10, Node.js ≥ 20 |
| Database     | PostgreSQL via Prisma 5 |
| Cache / jobs | Redis (ioredis, BullMQ) |
| Real-time    | Socket.IO WebSocket gateway |
| Auth         | Passport JWT, Argon2id, `@nestjs/throttler`, Helmet |
| Engine I/O   | Hand-rolled XML-RPC + SCGI client, bencode info-hash reader |
| Frontend     | React 18 + Vite 5, React Router, TanStack Query, Tailwind CSS, Recharts, Socket.IO client |
| Shared       | `@ultratorrent/shared` — types, permission catalog, and event contracts shared by API and UI |

## Screenshots

> _Screenshots coming soon._ Drop images into `docs/images/` and reference them
> here once the frontend is built out.

| Dashboard | Torrent list | Torrent details |
|-----------|--------------|-----------------|
| _placeholder_ | _placeholder_ | _placeholder_ |

## Architecture at a glance

UltraTorrent follows **Clean Architecture**. Dependencies point inward; the
domain knows nothing about HTTP, Prisma, or rTorrent.

```
            ┌───────────────────────────────────────────────┐
            │                  React SPA                     │
            │      (REST over /api  +  WebSocket /ws)         │
            └───────────────────────────────────────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │                    API layer                         │  Controllers, DTOs,
        │        Auth · Torrents · Dashboard · Engines ·        │  Guards, WS gateway
        │                  Audit · Realtime                     │
        ├──────────────────────────────────────────────────────┤
        │                 Application layer                     │  Services orchestrate
        │   TorrentsService · EngineRegistry · TorrentSync      │  use cases & RBAC
        ├──────────────────────────────────────────────────────┤
        │                    Domain layer                       │  TorrentEngineProvider
        │   TorrentEngineProvider interface · Normalized types  │  interface (the seam)
        ├──────────────────────────────────────────────────────┤
        │                Infrastructure layer                   │  RTorrentProvider,
        │   RTorrentProvider · XML-RPC/SCGI · Prisma · Redis    │  factory, persistence
        └──────────────────────────────────────────────────────┘
                                   │
                      XML-RPC over SCGI / HTTP
                                   │
                            ┌──────────────┐
                            │   rTorrent   │
                            └──────────────┘
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the Core architecture
breakdown.

## Quick start

### Option A — Docker Compose

The fastest path. Compose brings up the database, cache, backend, and frontend
together. See [`docs/DOCKER.md`](docs/DOCKER.md) for the full service reference.

```bash
git clone https://github.com/damirabal/ultratorrent-core.git
cd ultratorrent-core

# Configure secrets and connection details
cp .env.example .env        # then set the REQUIRED values (see below)

# Build and start the stack (backend runs `prisma migrate deploy` on start)
docker compose up -d --build
```

> **Required before it will start.** There are no insecure defaults. Compose
> refuses to start without `POSTGRES_PASSWORD` and `ADMIN_PASSWORD`, and in
> production the backend refuses to boot unless `JWT_ACCESS_SECRET` and
> `ENCRYPTION_KEY` are set, ≥32 chars, and different from each other. Generate
> each secret with `openssl rand -base64 48`.

```bash
# Seed the database once (permissions, roles, admin, default settings)
docker compose exec backend npx prisma db seed
```

Then open the UI (frontend, default `http://localhost:8080`) and sign in with the
[admin account](#admin-account) you configured.

### Option B — Manual / local dev

Prerequisites: **Node.js ≥ 20**, **PostgreSQL**, and **Redis** running locally.
Full details in [`docs/INSTALL.md`](docs/INSTALL.md).

```bash
# 1. Install all workspaces from the repo root
npm install

# 2. Configure the backend environment
cp .env.example apps/backend/.env     # set DATABASE_URL, JWT secrets, etc.

# 3. Generate the Prisma client, run migrations, and seed
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed

# 4. Run backend + frontend together
npm run dev
#   backend  → http://localhost:4000  (Swagger at /api/docs)
#   frontend → http://localhost:5173  (proxies /api and /ws to the backend)
```

To connect an rTorrent instance, see
[Connecting an rTorrent instance](docs/INSTALL.md#connecting-an-rtorrent-instance).

## Admin account

The seed script bootstraps a single **Super Admin** whose credentials come from
the `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` environment variables —
there is **no shipped default password**. Docker Compose requires you to set
`ADMIN_PASSWORD` before it will start. (For a bare `npm run prisma:seed` in local
dev without the variable set, the seed falls back to a well-known
development-only password, `changeme123!`, which you must change immediately.)

The password can be rotated from the UI or `POST /api/auth/change-password`. A
super admin implicitly holds every permission.

## Project structure

```
ultratorrent/
├── apps/
│   ├── backend/                  # NestJS API (@ultratorrent/backend)
│   │   ├── prisma/
│   │   │   ├── schema.prisma      # PostgreSQL data model
│   │   │   └── seed.ts            # permissions, roles, admin, default settings
│   │   └── src/
│   │       ├── common/            # decorators (Public, CurrentUser, RequirePermissions)
│   │       ├── config/            # typed configuration loader
│   │       ├── domain/
│   │       │   └── engine/        # TorrentEngineProvider interface (the seam)
│   │       ├── infrastructure/
│   │       │   ├── engine/        # provider factory + RTorrentProvider
│   │       │   ├── rtorrent/      # XML-RPC, SCGI client, bencode info-hash
│   │       │   └── prisma/        # PrismaService / PrismaModule
│   │       ├── modules/           # auth, users, torrents, dashboard, engine, search,
│   │       │                       #   settings, taxonomy, files, rss, automation,
│   │       │                       #   notifications, apikeys, audit, system, realtime
│   │       ├── app.module.ts       # root module — wires all modules + global guards
│   │       └── main.ts             # bootstrap: helmet, CORS, /api prefix, Swagger
│   └── frontend/                 # React + Vite + Tailwind SPA (@ultratorrent/frontend)
├── packages/
│   └── shared/                   # @ultratorrent/shared — types, permissions, events
│       └── src/
│           ├── permissions.ts     # canonical RBAC permission catalog & roles
│           ├── torrent.ts         # Normalized* domain types
│           ├── events.ts          # WebSocket event contract
│           └── api.ts             # request/response envelopes
├── docs/                         # the documentation set (see below)
├── package.json                  # workspace root + scripts
└── tsconfig.base.json
```

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Core clean-architecture layers, the engine provider abstraction, data flow, real-time design, RBAC |
| [MEDIA_MANAGER.md](docs/MEDIA_MANAGER.md) | Media libraries, identification, metadata/artwork/subtitles, rename templates, NFO, media-server integrations, automation, security |
| [INSTALL.md](docs/INSTALL.md)           | Prerequisites, env setup, Prisma, running dev, connecting rTorrent |
| [DOCKER.md](docs/DOCKER.md)             | Docker Compose services, volumes, env, health checks, commands |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)   | Local workflow, adding an engine provider, adding a module, testing, standards |
| [CONTRIBUTING.md](docs/CONTRIBUTING.md) | Branching, conventional commits, PRs, DCO, CLA |
| [CHANGELOG.md](CHANGELOG.md)            | Release notes (Keep a Changelog) |

## Security

UltraTorrent's Core security model — Argon2id hashing, JWT + rotating hashed
refresh tokens, server-enforced RBAC, canonicalized root-limited file/path
handling, SSRF-guarded remote fetches, and audit logging — is summarized in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

**Reporting a vulnerability:** please report security issues **privately** — do
not open a public issue. Use GitHub's *Report a vulnerability* (Security tab →
Advisories) or email the maintainers. We aim to acknowledge reports promptly.

## License

UltraTorrent is a single, self-hosted community product — one codebase, with no
separate editions or add-on overlay. It is licensed under the **GNU Affero
General Public License v3.0 or later (AGPL-3.0-or-later)**. If you run a modified
version as a network service, the AGPL requires you to make the corresponding
source available to its users. See the `LICENSE` file for the full text.
</content>
