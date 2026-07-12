---
id: setup
title: Local setup
sidebar_position: 2
description: Get UltraTorrent running from source — install, Prisma generate/migrate/seed, run backend and frontend, and the gotchas that will bite you.
keywords: [setup, development environment, npm workspaces, prisma, seed, vite, nestjs, dev server]
---

# Local setup

## Overview

UltraTorrent is an npm-workspaces monorepo. `npm install` at the **repo root** links all
three workspaces; you then generate the Prisma client, migrate, seed, and run the backend
(`:4000`) and frontend (`:5173`) together.

## Purpose

A working dev loop: edit → hot reload → test.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js ≥ 20** | The root `package.json` declares `engines.node >= 20`. CI runs Node 22. |
| **PostgreSQL** | The store. Easiest via Docker. |
| **Redis** | Caching / coordination. Also easiest via Docker. |
| **A torrent engine** *(optional)* | rTorrent or qBittorrent. The app runs fine without one — you just have no engine to talk to. |

The fastest way to get Postgres + Redis is the Compose stack from
[Docker Compose install](/install/docker-compose) — bring up the database and cache, then
run the app from source against them.

## Step-by-step

### 1. Install

```bash
npm install                 # from the repo ROOT — links all workspaces
```

Always install from the root. Installing inside a workspace breaks the links.

### 2. Configure

Copy `.env.example` to `.env` and fill it in. The values you actually need for dev:

```bash
DATABASE_URL=postgresql://ultratorrent:PASSWORD@localhost:5432/ultratorrent?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379

# Dev defaults exist for these, and the app will WARN (not fail) if they're weak.
# In production it refuses to boot.
JWT_ACCESS_SECRET=
ENCRYPTION_KEY=

FILE_MANAGER_ROOTS=/path/to/your/downloads
```

The complete list is the [Environment reference](/reference/environment).

### 3. Database

```bash
npm run prisma:generate     # generate the Prisma client
npm run prisma:migrate      # apply migrations (prisma migrate deploy)
npm run prisma:seed         # permissions, roles, bootstrap admin, settings
```

:::note `prisma:migrate` is `migrate deploy`
The root `prisma:migrate` script maps to **`prisma migrate deploy`** — it applies existing
migrations. To *create* a new migration during development, use the workspace script:

```bash
npm run prisma:migrate:dev --workspace @ultratorrent/backend
```

See [Database & Prisma](/develop/database).
:::

The seed is idempotent. It creates the bootstrap super admin from
`ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` (defaults: `admin` /
`admin@ultratorrent.local` / `changeme123!`) — and because every write is an `upsert` with
`update: {}`, **re-seeding does not reset an existing admin's password**.

### 4. Run

```bash
npm run dev                 # backend (4000) + frontend (5173) together
```

Or separately:

| Command | Effect |
| --- | --- |
| `npm run dev:backend` | `nest start --watch` |
| `npm run dev:frontend` | Vite dev server with `/api` + `/ws` proxied to `:4000` |
| `npm run build` | builds `shared` → `backend` → `frontend`, in that order |
| `npm run lint` | ESLint in every workspace that defines it (`--max-warnings 0`) |
| `npm run test` | Jest (backend) + Vitest (frontend) |

Then:

- **App** — http://localhost:5173
- **API** — http://localhost:4000/api
- **Swagger** — http://localhost:4000/api/docs *(non-production only)*

## How the dev stack fits together

```mermaid
flowchart LR
  DEV["Vite dev server<br/>:5173"] -->|"proxy /api"| API["NestJS<br/>:4000"]
  DEV -->|"proxy /ws (ws: true)"| API
  API --> PG[("PostgreSQL<br/>:5432")]
  API --> RD[("Redis<br/>:6379")]
  API -->|"SCGI / Web API"| ENG[("rTorrent /<br/>qBittorrent")]
  SH["packages/shared<br/>(built or watched)"] -.->|"types · permissions · WS events"| API
  SH -.-> DEV
```

## Gotchas

### The shared package must be built

This is the single most common "why doesn't my change appear" in this repo. The backend and
frontend consume the **built or linked** `@ultratorrent/shared` package. When you edit
shared types, permissions or event names, run its watch build:

```bash
npm run dev --workspace @ultratorrent/shared
```

…or rebuild (`npm run build` from the root) so the other two pick the change up.

Note the asymmetry: **backend unit tests do not need this.** Jest maps
`@ultratorrent/shared` straight to `packages/shared/src/index.ts`, so tests see live source.
Your running dev server does not.

### `tsc` clean does not mean it boots

TypeScript and unit tests do **not** exercise NestJS dependency injection or module wiring.
A missing provider, a circular import, or a bad manifest only fails at boot. Before you call
a change done, **boot a clean build** — a dev server running from a stale `dist/` will
happily keep serving the old code.

### A new permission needs a re-seed

Adding a key to `packages/shared/src/permissions.ts` does not create the DB row that RBAC
assigns. Re-run `npm run prisma:seed`. (Manifest-declared permissions *are* upserted at boot
by `ModulePermissionSyncService`, but the **role grants** come from the seed.)

### The file manager is root-confined

`FILE_MANAGER_ROOTS` is a hard boundary. Every file, torrent and media path is canonicalized
(realpath) and confined to it — traversal, symlink escapes and system directories are
rejected. If media scanning "sees nothing", check this first.

### Self-hosted indexers on private IPs

The torrent-fetch SSRF guard blocks any `.torrent` URL that resolves to a private/internal
address. A LAN Prowlarr hands back exactly such links, so grabs fail with *"Torrent URL
resolves to a blocked internal address"* — while the **connection test still passes** (the
health check trusts private hosts; the fetch guard is stricter). Add the host to
`SSRF_ALLOW_HOSTS`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Insecure secrets (OK for dev, NOT production)` warning at boot | `JWT_ACCESS_SECRET` / `ENCRYPTION_KEY` are unset, weak, or identical. | Fine in dev. Set them properly before you go near production. |
| `Refusing to start: insecure secret configuration` | Same, but with `NODE_ENV=production`. | Set strong, **distinct** secrets ≥32 chars. |
| Prisma: `P1001 Can't reach database server` | Postgres isn't up, or `DATABASE_URL` is wrong. | Check the container/host and the URL. |
| Prisma: `P3009 migrate found failed migrations` | A migration was interrupted mid-flight. The backend will restart-loop. | Resolve the failed migration row by hand. And read the safe-migration rule in [Database](/develop/database) — this is exactly what it exists to prevent. |
| `Cannot find module '@ultratorrent/shared'` | Installed inside a workspace instead of the root, or shared not built. | `npm install` at the root; build shared. |
| Frontend loads but every call 401s | No engine/DB, or the token store is stale. | Check the API is up; clear the `ultratorrent.auth` localStorage key. |
| WS never connects | The Vite proxy needs `ws: true` — it has it — but the access token must exist. | Log in first; the socket connects after `me()` resolves. |
| Login always fails after a re-seed | The seed does **not** reset an existing admin's password. | Use the original password, or delete the user and re-seed. |

## Tips

- **Swagger is your API playground.** `http://localhost:4000/api/docs` shows every route,
  DTO shape and the bearer scheme. It is disabled in production on purpose.
- **The 2-second sync loop is chatty.** `TorrentSyncService` polls every engine every 2s.
  When you're debugging, that's a lot of log noise — and a lot of automation evaluation.
- **Run the parity test early.** If you touch UI strings, `npm run test --workspace
  @ultratorrent/frontend` will tell you immediately whether en-US and es-PR agree.

## FAQ

**Can I run without Redis?**
The stack expects it for caching/coordination. Run the Compose `redis` service; it's one
container.

**Can I run without a torrent engine?**
Yes — you just have no engine to add. Everything else (media, RSS rules, users, settings)
works. The engine status feed will report offline.

**Where does the frontend get its API URL?**
`VITE_API_URL` (default `http://localhost:4000/api`) and `VITE_WS_URL` (default
`http://localhost:4000`). In dev the Vite proxy handles both.

**How do I reset everything?**
Drop the database, re-run `prisma:migrate` + `prisma:seed`. There is no destructive reset
script, deliberately.

## Checklist

- [ ] `npm install` run at the repo **root**.
- [ ] `.env` has `DATABASE_URL`, Redis host/port, and `FILE_MANAGER_ROOTS`.
- [ ] `prisma:generate` → `prisma:migrate` → `prisma:seed` all succeeded.
- [ ] `npm run dev` serves :5173 and :4000.
- [ ] I can log in as the bootstrap admin.
- [ ] Swagger renders at `/api/docs`.

## See also

- [Environment reference](/reference/environment) — every variable
- [Docker Compose install](/install/docker-compose)
- [Database & Prisma](/develop/database)
- [Testing](/develop/testing)
- [Operate → Troubleshooting](/operate/troubleshooting)
