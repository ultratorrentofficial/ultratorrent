---
id: configuration-profiles
title: Configuration Profiles
sidebar_position: 7
description: Known-good UltraTorrent configurations for each deployment size — Default, Small home server, Large media library, High availability, Enterprise, Performance and Security profiles with concrete settings.
keywords:
  - configuration
  - profiles
  - settings
  - recommended settings
  - small server
  - large library
  - high availability
  - HA
  - enterprise
  - performance profile
  - security profile
  - Raspberry Pi
  - NAS
  - Synology
  - QNAP
  - sizing
  - reference architecture
  - example config
  - .env example
---

# Configuration Profiles

Seven opinionated, known-good configurations. Find the one that matches your
deployment, apply it, and move on.

Each profile is a **starting point**, not a straitjacket — but each is built from
what has actually worked (and what has actually broken) on real deployments.

## Purpose

To skip the trial and error. Most tuning questions have a right answer once you
know how big the deployment is and what it is for.

## Choosing a profile

```mermaid
flowchart TD
    A{"What are you running?"} --> B{"How many torrents,<br/>and how big a library?"}
    B -->|"< 50 torrents<br/>< 500 media items"| SMALL["Small home server"]
    B -->|"hundreds of torrents<br/>thousands of items"| LARGE["Large media library"]
    B -->|"just trying it out"| DEF["Default"]

    A --> C{"Special requirement?"}
    C -->|"must not go down"| HA["High availability"]
    C -->|"multi-user, audited,<br/>least-privilege"| ENT["Enterprise"]
    C -->|"it works, but it's slow"| PERF["Performance"]
    C -->|"internet-facing"| SEC["Security"]

    style SMALL fill:#2e7d32,color:#fff
    style LARGE fill:#f9a825,color:#000
    style HA fill:#1565c0,color:#fff
    style ENT fill:#6a1b9a,color:#fff
    style SEC fill:#c62828,color:#fff
```

| Profile | For | The one thing that matters |
|---------|-----|----------------------------|
| [Default](#default) | Evaluating, first install | Get the secrets right |
| [Small home server](#small-home-server) | A Pi, a NAS, a mini-PC | Keep it lean; rTorrent is fine here |
| [Large media library](#large-media-library) | Hundreds of torrents, thousands of items | **Use qBittorrent, not rTorrent** |
| [High availability](#high-availability) | It must not go down | External Postgres + real backups |
| [Enterprise](#enterprise) | Many users, audit requirements | RBAC + 2FA + audit review |
| [Performance](#performance) | It works but it's slow | Trigram indexes + Postgres tuning |
| [Security](#security) | Internet-facing | Publish nothing you don't have to |

---

## Default

The shipped configuration. Sensible, safe, and unopinionated — this is what you
get from `cp .env.example .env`.

**Use it when:** you are installing for the first time or evaluating.

```dotenv
# --- Required. The stack REFUSES to start without these. -------------------
POSTGRES_PASSWORD=<strong ALPHANUMERIC password>
ADMIN_PASSWORD=<strong password>

# Generate each separately with: openssl rand -base64 48
JWT_ACCESS_SECRET=<48+ random chars>
JWT_REFRESH_SECRET=<48+ random chars>
ENCRYPTION_KEY=<48+ random chars — MUST DIFFER from JWT_ACCESS_SECRET>

# --- Sensible defaults ----------------------------------------------------
NODE_ENV=production
PORT=4000
FRONTEND_PORT=8080
CORS_ORIGIN=http://localhost:8080

POSTGRES_USER=ultratorrent
POSTGRES_DB=ultratorrent
REDIS_HOST=redis
REDIS_PORT=6379

JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=30

FILE_MANAGER_ROOTS=/downloads
SSRF_ALLOW_HOSTS=prowlarr

ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@ultratorrent.local

PUID=1000
PGID=1000
TZ=Etc/UTC
```

```bash
docker compose --profile qbittorrent up -d --build
docker compose exec backend npx prisma db seed
```

:::warning The four rules that stop the backend from booting
1. `JWT_ACCESS_SECRET` and `ENCRYPTION_KEY` must each be **32+ chars**.
2. They must be **different from each other**.
3. Neither may be a `dev-*` / `change-me` default.
4. `POSTGRES_PASSWORD` must be **alphanumeric** (it is embedded in a URL).

These are enforced. If the backend starts in production, you satisfied them.
:::

**Checklist**
- [ ] All three secrets generated with `openssl rand -base64 48`
- [ ] `ENCRYPTION_KEY` ≠ `JWT_ACCESS_SECRET`
- [ ] Seeded admin password changed after first login
- [ ] `.env` backed up off the host

---

## Small home server

A Raspberry Pi 4/5, a Synology/QNAP NAS, an old laptop, a mini-PC. Modest CPU,
2–4 GB RAM, a handful of users.

**Use it when:** under ~50 active torrents and a library of a few hundred items.

```dotenv
# Start from Default, then:

# The NAS admin UI usually owns 8080.
FRONTEND_PORT=8123
CORS_ORIGIN=http://nas.local:8123

# Own the media as the user that already owns it (e.g. Plex).
# Find it with: id plex
PUID=1000
PGID=1000
TZ=America/New_York

# Keep the file-manager boundary tight.
FILE_MANAGER_ROOTS=/downloads

# Longer sessions — it's a trusted LAN, and re-logins are annoying.
JWT_ACCESS_TTL=30m
JWT_REFRESH_TTL_DAYS=60
```

**Engine: the bundled rTorrent is genuinely fine at this size.** Its crash bug is
load-driven and effectively invisible below ~100 torrents (a 7-torrent host went
**zero** crashes over the same period a 752-torrent host crashed 44 times).

```bash
docker compose --profile rtorrent up -d --build
```

**Skip the IMDb catalogue** unless you need missing-episode detection. It is 8.9M
rows and it is optional. If you *do* import it, budget the RAM and let the trigram
indexes finish building before you scan.

:::tip NAS gotchas that will cost you an hour
- **Port 8080 is usually taken.** Set `FRONTEND_PORT`. Do **not** try to remap it
  with a Compose override — Compose *appends* `ports`, so the original mapping
  survives and still conflicts.
- **Synology DSM strips `SETUID`/`SETGID`** from the container's default
  capabilities, which breaks rTorrent's privilege drop and makes it run as **root**
  (so downloads land root-owned). The shipped Compose file re-adds them with
  `cap_add: ["SETUID", "SETGID"]`. Keep that line.
- **Media owned by another app?** Don't `chown` it. Set `PUID`/`PGID` to *that*
  user (`id plex`) so downloads are written as them.
:::

**Checklist**
- [ ] `FRONTEND_PORT` set to something free
- [ ] `PUID`/`PGID` match whoever should own the media
- [ ] `cap_add: ["SETUID","SETGID"]` still present (Synology)
- [ ] rTorrent profile enabled
- [ ] IMDb catalogue skipped, or imported deliberately

---

## Large media library

Hundreds to thousands of torrents. Thousands of media items. The IMDb catalogue
imported. This is where the interesting failures live.

**Use it when:** you are past ~100 active torrents, or ~2,000 media items.

### The one decision that matters: **do not use rTorrent**

```dotenv
# Start from Default, then:
QBITTORRENT_PORT=8081
```

```bash
docker compose --profile qbittorrent up -d
docker compose logs qbittorrent | grep -i password   # first-run temp password
```

Register it under **Infrastructure → Engines** (kind qBittorrent, base URL
`http://qbittorrent:8080`).

:::danger rTorrent 0.9.8 has an unfixable, load-driven crash bug
`internal_error: priority_queue_insert(...)` fires during tracker-announce
scheduling. It has **no fix in the 0.9.8 lineage**, and it scales with your torrent
count. Real measurements from two hosts running the identical build:

| Torrents | Crashes |
|----------|---------|
| **7** | **0** |
| **752** | **44 in 4 days** (~10/day) |

qBittorrent handles thousands of torrents comfortably. Move before you feel it, not
after.
:::

If the qBittorrent connection test fails with 401: disable **Enable Host header
validation** under **Options → Web UI** (the backend connects by the service name
`qbittorrent`, which qBittorrent does not trust by default).

### The second decision: **every indexer needs a `minSeeders`**

This is not a nicety. The per-indexer seeder filter **only applies when the column
is set** — so an indexer with no `minSeeders` hands you 0-seeder releases, and:

> **A 0-seeder magnet can never fetch its metadata — yet the engine counts it as an
> active download the whole time it tries.**

The real outcome was an engine holding **1,137 torrents and moving 0 bytes**:
**1,114 of them had zero seeders**, and with `max_active_downloads: 100`, exactly
**88 `metaDL` + 12 `stalledDL` = 100 slots** were permanently held by torrents that
would never finish. The 1,034 healthy ones sat queued behind them.

Set `minSeeders` on **every** indexer, and **enable the parking queue** (it ships
disabled — it pauses dead torrents so they stop holding slots, then periodically
force-starts them to re-check whether seeders appeared).

### The third decision: **trigram indexes**

With the 8.9M-row IMDb catalogue, `ILIKE` lookups without GIN trigram indexes take
**47.8 seconds each** and will **starve Postgres until scans never complete**. With
them: **180 ms**.

Current builds build these automatically at runtime. **Verify** they are valid:

```sql
SELECT c.relname, i.indisvalid
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname LIKE '%trgm%';   -- all must be `t`
```

See [Performance](/operate/performance).

**Checklist**
- [ ] **qBittorrent**, not rTorrent
- [ ] `minSeeders` set on **every** indexer
- [ ] Parking queue enabled
- [ ] All three trigram indexes exist **and are valid**
- [ ] Postgres has 4 GB+ and `random_page_cost` lowered for SSD
- [ ] Scans are not run concurrently with the IMDb import

---

## High availability

Downtime is unacceptable. Note honestly: UltraTorrent is a **single-instance
application** — the backend is not designed to be horizontally scaled behind a load
balancer (job bodies run in-process; a second instance would duplicate scheduled
work). HA here means **fast, reliable recovery**, not active-active.

**Use it when:** you need a hard recovery-time objective.

```dotenv
# Point at an EXTERNAL, managed, replicated Postgres — the single most
# valuable HA change you can make.
DATABASE_URL=postgresql://ultratorrent:PASSWORD@postgres.internal:5432/ultratorrent?schema=public

# Redis can also be external, but it holds no durable state — losing it is cheap.
REDIS_HOST=redis.internal
REDIS_PORT=6379
```

### The HA architecture

```mermaid
flowchart TD
    subgraph edge["Edge"]
        LB["Reverse proxy / TLS"]
    end
    subgraph app["App host — REPLACEABLE"]
        BE["backend + frontend<br/>(single instance)"]
    end
    subgraph state["State — REPLICATED"]
        PG[("Managed PostgreSQL<br/>streaming replication<br/>PITR")]
        NAS[("Media on NAS / RAID")]
    end
    subgraph backup["Off-host"]
        BK[("Nightly pg_dump<br/>+ .env in a secret store")]
    end

    LB --> BE
    BE --> PG
    BE --> NAS
    PG -.nightly.-> BK

    style PG fill:#2e7d32,color:#fff
    style BK fill:#1565c0,color:#fff
```

The app host becomes **cattle**: if it dies, you rebuild it from the repo, restore
`.env`, point it at the same database, and you are back.

### What actually buys you availability

| Do this | Why |
|---------|-----|
| **External, replicated Postgres** with point-in-time recovery | It is the *only* irreplaceable component |
| **`.env` in a secret store** | Without `ENCRYPTION_KEY`, a database restore is half a restore |
| **Media on a NAS/RAID**, not container-local | Decouples your media from the app host |
| **`restart: unless-stopped`** on everything | Already the default. It is what makes rTorrent's crashes survivable |
| **Monitor `/api/system/ready`**, not just `/live` | `/live` says the process exists; `/ready` says its dependencies are usable |
| **A rehearsed restore drill** | Your RTO is a guess until you have measured it |
| **Alert on `RestartCount`** | Catches a crash-loop that `docker compose ps` hides |

### Health probes

```bash
# Liveness — is the process alive? (this is what the container healthcheck uses)
curl -f http://localhost:8080/api/system/live || echo DOWN

# Readiness — are its dependencies usable?
curl -f http://localhost:8080/api/system/ready || echo NOT_READY
```

:::caution Not yet verified
Running UltraTorrent behind a load balancer with **multiple backend replicas** has
not been validated, and the in-process job model means scheduled work would very
likely be **duplicated** across instances. Treat multi-replica as unsupported until
proven otherwise.
:::

**Checklist**
- [ ] Postgres is external, replicated, with PITR
- [ ] `.env` is in a secret store, not only on the host
- [ ] Media lives on redundant storage
- [ ] `/api/system/ready` is monitored and alerts
- [ ] `RestartCount` is monitored
- [ ] The restore drill has been run **and timed** (that is your real RTO)
- [ ] Only **one** backend instance runs

---

## Enterprise

Many users, real roles, an audit requirement.

**Use it when:** UltraTorrent is shared beyond a household.

```dotenv
# Start from Default + Security, then:

# Shorter sessions.
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=7

# The exact production origin. Never `*`.
CORS_ORIGIN=https://ultratorrent.corp.example.com

# Narrow the hard file boundary to exactly what the engine writes.
FILE_MANAGER_ROOTS=/downloads/media

# Trust only the indexers you actually run.
SSRF_ALLOW_HOSTS=prowlarr
```

### Roles, applied

Assign the **least** role that does the job:

| Person | Role | Watch out for |
|--------|------|---------------|
| You | `SUPER_ADMIN` | The only role that can grant `SUPER_ADMIN`. Give it to as few people as possible. |
| A co-admin | `ADMINISTRATOR` | Everything **except** `system.manage`. |
| Someone who manages their own media | `POWER_USER` | ⚠️ Includes **all** `files.*` — **delete, bulk actions and cleanup included**. |
| An ordinary user | `USER` | Read-only files. Safe. |
| A dashboard viewer | `READ_ONLY` | View only. |

:::warning `POWER_USER` can delete your files
It holds every `files.*` permission, including `files.delete` and `files.cleanup`.
If that is not what you intend, build a custom role. Note also that
`torrents.delete_data` (removes data **from disk**) is a **separate permission**
from `torrents.delete` — grant them independently.
:::

The platform enforces the escalation guards for you: only a `SUPER_ADMIN` may grant
`SUPER_ADMIN`, **no user may edit their own roles**, deactivating a user **revokes
their refresh tokens immediately**, and bulk actions require the **same permission
as their dedicated route** — so a viewer cannot smuggle a destructive operation
through `/torrents/bulk`.

### Mandatory practices

- **2FA on every admin account.** Enrolment is *confirmed*, not blind — a user must
  prove possession of a valid code before it activates, so nobody locks themselves
  out by accident. Save the **10 single-use recovery codes**.
- **Review the audit log monthly.** It records failed logins *with the attempted
  username*, every destructive action, role changes, and settings changes — and it
  now **names the media** each row targeted instead of showing an opaque id.
- **API keys, not shared passwords**, for machine access.

**Checklist**
- [ ] Every user has the least role that works
- [ ] 2FA enrolled on **all** admin accounts; recovery codes stored
- [ ] `POWER_USER` grants reviewed (they can delete files)
- [ ] Audit log reviewed on a schedule
- [ ] `CORS_ORIGIN` is the exact production origin
- [ ] `FILE_MANAGER_ROOTS` is as narrow as possible

---

## Performance

Everything works — it is just slow. See [Performance](/operate/performance) for the
full treatment; this is the config layer.

```yaml
# docker-compose.override.yml
services:
  postgres:
    command:
      - postgres
      - -c
      - shared_buffers=1GB
      - -c
      - work_mem=32MB
      - -c
      - maintenance_work_mem=512MB   # makes index builds much faster
      - -c
      - effective_cache_size=3GB
      - -c
      - random_page_cost=1.1         # you are on SSD; the 4.0 default assumes spinning disk
```

Then, in order of impact:

1. **Verify the trigram indexes exist and are `indisvalid = true`.** This is worth
   **~265×** on IMDb title lookups (47.8 s → 180 ms). An **INVALID** index is
   *worse* than none — the planner ignores it, but its name exists, so
   `IF NOT EXISTS` skips the rebuild forever.
2. **`ANALYZE`** after any large import. A stale plan is a slow plan.
3. **`random_page_cost=1.1`** — the highest-leverage single line. The `4.0` default
   biases the planner *against* index scans, which is wrong on SSD.
4. **Do not run a library scan during the IMDb import.** They fight.
5. **Move to qBittorrent** if you have many torrents.

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
EXPLAIN ANALYZE SELECT * FROM imdb_titles WHERE \"primaryTitle\" ILIKE 'Silo';"
# Want: Bitmap Index Scan.   Do NOT want: Seq Scan.
```

**Checklist**
- [ ] Trigram indexes present **and valid**
- [ ] `EXPLAIN` shows a Bitmap Index Scan
- [ ] `random_page_cost` lowered for SSD
- [ ] `ANALYZE` run recently
- [ ] Postgres has enough `shared_buffers`

---

## Security

Internet-facing, or simply paranoid. Pairs with [Security](/operate/security).

```dotenv
NODE_ENV=production

# The EXACT origin. Not `*`. Not localhost.
CORS_ORIGIN=https://ultratorrent.example.com

# Short-lived everything.
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=7

# The narrowest possible hard boundary.
FILE_MANAGER_ROOTS=/downloads/media

# Full SSRF protection: set EMPTY if you use no private-IP indexer.
# If you use the bundled Prowlarr, you MUST keep it listed.
SSRF_ALLOW_HOSTS=prowlarr
```

### Publish nothing you do not have to

```yaml
# docker-compose.override.yml — un-publish the companion ports.
services:
  qbittorrent:
    ports: !reset []      # reach it via the internal network only
  prowlarr:
    ports: !reset []
```

:::danger The engine control surface is unauthenticated
rTorrent's SCGI/XML-RPC interface gives **full control of the client**, including
**command execution** (it runs `rm` during delete-with-data). The shipped Compose
file correctly keeps it on `expose` (internal only) — **never** publish it. The
same caution applies to the qBittorrent Web API: if you published its port to fetch
the first-run password, **unpublish it afterwards**.
:::

### TLS at the edge

```bash
docker compose --profile proxy up -d
```

Replace the `:80` site label in `deploy/Caddyfile` with your domain for automatic
Let's Encrypt HTTPS. See [TLS](/install/tls).

### The honest recommendation

**Put it on a VPN instead.** WireGuard or Tailscale gives you remote access with a
fraction of the attack surface. UltraTorrent moves, deletes and executes against
files. There is very little upside to exposing it publicly.

**Checklist**
- [ ] TLS terminates at a reverse proxy
- [ ] `CORS_ORIGIN` is the exact production origin
- [ ] rTorrent / FlareSolverr are **not** published
- [ ] qBittorrent / Prowlarr ports un-published (or firewalled)
- [ ] 2FA on every account that can log in
- [ ] `FILE_MANAGER_ROOTS` narrowed
- [ ] `SSRF_ALLOW_HOSTS` lists only trusted indexers
- [ ] `chmod 600 .env`
- [ ] Audit log reviewed regularly

---

## Comparison

| | Default | Small | Large | HA | Enterprise | Performance | Security |
|---|---|---|---|---|---|---|---|
| **Engine** | qBittorrent | rTorrent OK | **qBittorrent** | qBittorrent | qBittorrent | qBittorrent | qBittorrent |
| **IMDb catalogue** | optional | skip | yes | yes | yes | yes | optional |
| **Trigram indexes** | auto | n/a | **critical** | critical | critical | **critical** | auto |
| **Postgres** | bundled | bundled | bundled + tuned | **external** | bundled | **tuned** | bundled |
| **`JWT_ACCESS_TTL`** | 15m | 30m | 15m | 15m | **15m** | 15m | **15m** |
| **`JWT_REFRESH_TTL_DAYS`** | 30 | 60 | 30 | 30 | **7** | 30 | **7** |
| **2FA** | recommended | optional | recommended | required | **required** | — | **required** |
| **Published ports** | 8080 | 8080 | 8080 + 8081 | via LB | via proxy | — | **80/443 only** |
| **`minSeeders`** | set it | set it | **mandatory** | mandatory | mandatory | mandatory | set it |
| **Parking queue** | off | off | **on** | on | on | on | off |

## Troubleshooting

| Symptom | Likely profile mismatch |
|---------|-------------------------|
| Engine keeps restarting | You are on **Small** settings at **Large** scale → switch to qBittorrent |
| Scans never finish | Missing trigram indexes → [Performance](#performance) |
| Nothing downloads, all queued | No `minSeeders` → [Large](#large-media-library) |
| Backend won't boot | Secrets → [Default](#default) |
| Downloads owned by root | `PUID`/`PGID` or missing `cap_add` → [Small](#small-home-server) |

Full detail in [Troubleshooting](/operate/troubleshooting).

## Tips

- **Profiles compose.** Large + Security is a perfectly normal combination.
- **Pick your engine before you grow, not after.** Migrating engines at 800
  torrents is a chore; starting on the right one is free.
- **The `minSeeders` rule is the cheapest insurance in this document.** One unset
  column brought a 1,137-torrent host to **zero bytes per second**.

## FAQ

**Can I switch profiles later?**
Yes. They are just settings. Switching *engines* means re-adding torrents to the
new engine, so do it early.

**Which profile for a Raspberry Pi?**
[Small home server](#small-home-server). Skip the IMDb catalogue.

**I have 300 torrents. Small or Large?**
**Large.** rTorrent's crash rate is already climbing at that count.

**Do I need Prowlarr?**
No. It is an optional companion that manages Torznab indexer definitions for you.
UltraTorrent boots and works fine without it. See [Prowlarr](/modules/prowlarr).

**Can I run multiple backend instances?**
Not supported. Job bodies run in-process, so a second instance would duplicate
scheduled work. See [High availability](#high-availability).

## See also

- [Performance](/operate/performance) · [Security](/operate/security) · [Backup](/operate/backup) · [Maintenance](/operate/maintenance)
- [Troubleshooting](/operate/troubleshooting)
- [Environment reference](/reference/environment) — every variable
- [Docker Compose](/install/docker-compose) · [Reverse proxy](/install/reverse-proxy) · [TLS](/install/tls)
- [Engines](/modules/engines) · [Indexers](/modules/indexers) · [Users](/modules/users)
