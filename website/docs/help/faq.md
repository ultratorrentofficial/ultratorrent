---
id: faq
title: Frequently Asked Questions
sidebar_position: 1
description: Answers to the most common UltraTorrent questions — installation, configuration, downloads, RSS, media, notifications, automation, security, Docker, performance, API and development.
keywords:
  - FAQ
  - questions
  - answers
  - help
  - common problems
  - how do I
  - why does
  - what is
  - getting started
  - support
  - installation
  - configuration
  - downloads
  - RSS
  - media
  - notifications
  - automation
  - security
  - Docker
  - performance
  - API
  - developer
---

# Frequently Asked Questions

Answers to the questions that come up most. If your problem is a *failure* rather
than a question, go to [Troubleshooting](/operate/troubleshooting) — it is
organised by symptom and covers real, diagnosed incidents.

## General

### What is UltraTorrent?

A self-hosted **Media Acquisition & Management Platform**. Where a traditional
torrent client stops at "download this file", UltraTorrent continues: it
identifies the release, enriches it with metadata, artwork and subtitles, renames
and files it into the right library, generates NFO sidecars, refreshes your media
server, and notifies you — all governed by RBAC and observable in real time.

See [Concepts](/learn/concepts).

### How is it different from just running qBittorrent?

A conventional client is a **single-user desktop tool** whose job ends when the
download completes. UltraTorrent is a **server-side platform** that sits *in front
of* one or more engines. The browser never talks to the engine directly — the API
translates requests into each engine's native protocol and returns normalized,
engine-agnostic data.

Around that it layers RSS automation, media identification and organisation,
an automation rules engine, multi-user RBAC, auditing, and media-server
integrations.

### Is it free? Is there a paid tier?

It is **free and open source** (AGPL-3.0-or-later). There is **no commercial
edition, no licensing tier, and no feature paywall**. Every feature is in the one
repository. Access is controlled **only** by RBAC.

### Does UltraTorrent download anything illegal?

UltraTorrent is a **tool**. It does not host, index or provide content — you
supply the indexers and the feeds. What you download with it is your
responsibility, and subject to the law where you live.

### Does it scrape IMDb?

**No.** There is **no code path that fetches or parses imdb.com HTML.** The IMDb
provider works only from **IMDb datasets you provide** and/or a **licensed IMDb
API**. It is disabled by default.

---

## Installation

### What are the system requirements?

| | Minimum | Comfortable |
|---|---------|-------------|
| RAM | 2 GB | 4–8 GB (more if you import the IMDb catalogue) |
| Docker | Yes (recommended path) | — |
| Node.js | 20+ (only for a manual install) | — |
| Arch | x86-64 or ARM | — |

The Docker stack **builds from source**, so the host needs a couple of GB of free
RAM to build.

### Which install method should I use?

| You have… | Use |
|-----------|-----|
| A NAS (QNAP / Synology) | **Docker**, via the NAS's container app |
| A Linux PC, want it simple | **Docker** — one command brings up the whole stack |
| A Linux PC, want to develop | **Manual** (Node 20 + PostgreSQL + Redis) |

See [Docker Compose](/install/docker-compose).

### The backend won't start and complains about "insecure secret configuration"

That is a **safety feature, not a bug**. In production the backend refuses to boot
if `JWT_ACCESS_SECRET` or `ENCRYPTION_KEY` is unset, is a known default, is shorter
than 32 characters, or if the **two are identical**.

```bash
openssl rand -base64 48   # do this three times
```

See [Troubleshooting](/operate/troubleshooting#the-backend-exits-immediately-with-insecure-secret-configuration).

### Compose won't start: "POSTGRES_PASSWORD is required"

The stack ships with **no insecure defaults** — Compose itself refuses to render
without `POSTGRES_PASSWORD` and `ADMIN_PASSWORD`. Set both in `.env`.

Use an **alphanumeric** password: `DATABASE_URL` is derived from it, and URL-special
characters (`@ : / ?`) break the connection string.

### "Invalid username or password" right after installing

Two causes:

1. Log in with the **username** (`admin` by default), **not the email**.
2. You may not have run the seed:

   ```bash
   docker compose exec backend npx prisma db seed
   ```

### I forgot the admin password

The seed only sets the password when it **first creates** the admin — it will not
overwrite a later change. Reset it to your current `.env` value; the exact recovery
one-liner is in the [installation troubleshooting](/install/docker-compose).

### Port 8080 is already in use (NAS)

```dotenv
FRONTEND_PORT=8123
```

:::warning
Do **not** try to remap the port with a Compose override file. Compose **appends**
`ports` entries rather than replacing them, so the original `8080` mapping survives
and still conflicts.
:::

### Can I run it without Docker?

Yes — a manual install needs Node 20, PostgreSQL and Redis. For a manual install
remember to point `DATABASE_URL` at `localhost`, not the Docker service name
`postgres` (that produces `P1001: Can't reach database server`).

---

## Configuration

### Where do settings live — `.env` or the UI?

Both, deliberately:

- **`.env`** holds *ops-controlled* values: secrets, database, ports, and the hard
  file-manager boundary. These are set at deploy time and are **never widened at
  runtime**.
- **The UI** holds *operator-configurable* values: engines, indexers, RSS feeds,
  automation rules, libraries, notification channels.

API keys entered in the UI are **AES-256-GCM encrypted at rest** and redacted
(`••••••••`) in every API response — they are never written to `.env`.

### What is `FILE_MANAGER_ROOTS` and why does it matter?

It is the **hard, ops-controlled outer boundary** for the file manager
(comma-separated absolute paths, default `/downloads`). Nothing in the UI can
escape it — traversal, absolute-escape and symlink-escape are all blocked.

On top of it, an admin can set a **Default Root Path** to *narrow* browsing to a
subtree. It can only narrow, never widen. Keep `FILE_MANAGER_ROOTS` as tight as
possible and matching the directories your engine actually writes to.

### What is `SSRF_ALLOW_HOSTS`?

The allow-list for torrent fetches. The backend's SSRF guard **blocks any `.torrent`
URL that resolves to a private/internal address** unless its host is listed here.

This matters because a self-hosted indexer — **including the bundled Prowlarr** at
`http://prowlarr:9696` — returns proxy links on a private Docker IP. It defaults to
`prowlarr` so the bundled indexer works out of the box.

```dotenv
SSRF_ALLOW_HOSTS=prowlarr,indexer.lan,10.0.0.0/24
```

**Keep `prowlarr` in the list** if you use the bundled one.

### Can I change `ENCRYPTION_KEY`?

You can, but it is **destructive**. It is the AES-256-GCM key for everything
encrypted at rest, so rotating it makes all of these **permanently unreadable**:

- every user's **TOTP secret** (all 2FA users must re-enrol)
- **indexer API keys**
- the **Prowlarr API key**
- **engine passwords**

See [Rotating secrets](/operate/security#rotating-encryption_key-destructive--plan-it).

### What are `PUID` / `PGID`?

The user and group the bundled engine runs as, so downloads are owned how you want.
If your downloads folder belongs to another app (e.g. Plex), **do not `chown` it** —
set `PUID`/`PGID` to *that* user (`id plex`) so files are written as them.

---

## Downloads

### My download isn't starting. Where do I begin?

Follow the decision tree in
[Troubleshooting](/operate/troubleshooting#the-decision-tree-operators-actually-need-my-download-isnt-starting).
There are at least six distinct causes and guessing wastes time.

The most common: **the engine isn't registered or isn't running**. The bundled
engines are behind Compose profiles and are **off by default** — a plain
`docker compose up -d` starts *no* engine.

### Auto-downloads grab things but nothing ever downloads

Check the log for:

```
Torrent URL resolves to a blocked internal address
```

That is the **SSRF guard** blocking your indexer's `.torrent` link because it
resolves to a private IP. Add the host to `SSRF_ALLOW_HOSTS`.

:::warning The trap
**The Prowlarr connection test still passes.** The health check trusts private
hosts; the torrent *fetch* is a separate, stricter guard. A green badge proves the
API is reachable — it does **not** prove grabs will download.
:::

### A download says "failed" but it's clearly downloading

You are on an older build. **Magnets** were marked failed if they did not register
within a ~6-second confirmation window — which is fine for a `.torrent` file (its
metadata is already present) but **completely wrong for a magnet**, whose metadata
must be fetched from DHT/peers first.

In production, **256 of 257 such "failures" had actually loaded**, at a median of
**~53 seconds**. [Upgrade](/install/upgrading) — magnets are now treated as
accepted/pending, while a `.torrent` file still fails properly.

### Nothing downloads at all — everything sits queued

Almost certainly **dead torrents holding every queue slot**. A **0-seeder magnet can
never fetch its metadata, yet the engine counts it as an active download the whole
time it tries**. With `max_active_downloads: 100`, a hundred corpses hold a hundred
slots and every healthy torrent queues behind them.

The real case: **1,137 torrents, 0 bytes moving, 1,114 of them with zero seeders.**

**Fix:** set `minSeeders` on **every** indexer (the filter only applies when the
column is set!) and enable the parking queue. See
[Troubleshooting](/operate/troubleshooting#dead-torrents-block-every-healthy-one-nothing-downloads-at-all).

### My "delete on complete" rule says it succeeded, but the torrent is still seeding

Three possible causes, all real:

1. **rTorrent's `d.erase` silently no-ops.** It accepts the call, returns no error,
   and leaves the download loaded. Removal is now **verified and retried**.
2. **The completion trigger was a one-shot rising edge**, so any torrent already at
   100% when first seen was permanently past it. There is now a backfill pass.
3. **The qBittorrent condition trap** — see below.

[Upgrade](/install/upgrading) for 1 and 2.

### My delete-on-complete rule never fires on qBittorrent

Because **qBittorrent maps completed/seeding torrents to `SEEDING` and never emits
`COMPLETED`**. So a rule with a condition like `state == 'completed'` **never
matches**.

> **A "delete on complete" rule should have _empty_ conditions.** The
> `torrent.completed` **trigger** is already the condition.

### Which engine should I use — rTorrent or qBittorrent?

**qBittorrent, unless your library is small.**

The bundled rTorrent is `0.9.8`, which carries an **unfixable upstream crash bug**
(`internal_error: priority_queue_insert`) that is **load-driven**. Real measurements
from two hosts on the identical build:

| Torrents | Crashes |
|----------|---------|
| **7** | **0** |
| **752** | **44 in 4 days** |

No torrents are lost (the session reloads on restart), but transfers pause. Below
~100 torrents rTorrent is genuinely fine. Above that, use qBittorrent.

### qBittorrent's "Test connection" fails with 401

Disable **Enable Host header validation** under **Options → Web UI** (or set
*Server domains* to `*`). The backend connects by the Docker service name
`qbittorrent`, which qBittorrent does not trust by default.

---

## RSS

### How does RSS auto-download avoid grabbing the same thing twice?

Three levels of deduplication, all enforced in both polling and backfill:

1. **Per feed item** — by feed + item GUID.
2. **Per torrent** — by BitTorrent **info-hash**, so the same release under a
   rotated GUID, a re-post, or a *second feed* is never grabbed twice.
3. **Per logical title** — so a rule with a preference list holds **only one release
   per movie/episode**. It grabs the best available, **upgrades** to a strictly
   higher-priority release when one appears (removing the superseded torrent and its
   data), and skips equal-or-lower releases.

### What is the Smart Match Builder?

The ranked match-preference engine for RSS rules: include/exclude rules plus a
ranked preference list, so you can express "1080p WEB-DL preferred, but take 720p if
that's all there is — and upgrade later if the better one shows up".

See [RSS](/modules/rss) and [Smart Download](/modules/smart-download).

### Can a rule download an episode twice from two different feeds?

No — deduplication is by **info-hash**, not by feed. The same release in two feeds is
grabbed once.

---

## Media

### A show reports 0 missing episodes and never finds anything

Its **IMDb id** is wrong or missing. Everything downstream keys off it. There are
four distinct ways it goes wrong — **all four now self-heal**:

| Problem | Real example |
|---------|--------------|
| The id is an **episode**, not the series | *Silo* pinned to `tt16091606` (episode) instead of `tt14688458` (series) → yields **0 episodes** → scans to 0/0/0 forever |
| **Accents** | `90 Day Fiancé` vs `90 Day Fiance` — accents were *stripped* rather than *folded*, so the keys never matched |
| **Punctuation** | `FBI: Most Wanted` vs `FBI Most Wanted`; `Chicago P.D.` vs `Chicago PD` |
| **No IMDb id at all** | A show identified against TVDB. On one host, only **74 of 8,986** TV items had one |

[Upgrade](/install/upgrading), then re-scan. You can also force it:
`POST /media-acquisition/watchlist/library/resolve-imdb`.

If a show *still* won't resolve, it may genuinely be absent from your catalogue (or
listed only under a localised title) — set the id by hand.

### Why doesn't it just match `90 Day Fiancé: Pillow Talk` to `90 Day Fiancé` by prefix?

Because that is **exactly** how a spin-off hijacks its parent show. The matcher
deliberately **refuses to guess**. A show catalogued only under a localised full
title stays unresolved and must be set by hand. This is intentional, not a gap.

### My library shows episodes as if they were separate shows

An older bug: new media items were created with `title = basename(file)` and **no
season/episode**, so a show fragmented into one bogus entry per episode. On one host
**3,579 of 5,840** TV items were in this state.

It is fixed, and it **self-heals on re-scan**. Upgrade and re-scan.

### Do I need the IMDb catalogue?

No — it is **optional and off by default**. It gives you far better title resolution
and missing-episode detection. It is also **8.9 million rows**, so if you import it
you *must* have the trigram indexes (current builds create them for you). See
[Performance](/operate/performance#the-imdb-catalogue).

### A library scan freezes at 74% and never finishes

The classic symptom of **missing pg_trgm indexes**. Prisma renders
`mode: 'insensitive'` as `ILIKE`, which **cannot use a btree index** — so on the
8.9M-row catalogue every title lookup became a full table scan at **47.8 seconds
each**, saturating Postgres and starving the scan itself.

With GIN trigram indexes: **180 ms** — a **~265×** speedup.

See [Troubleshooting](/operate/troubleshooting#a-library-scan-freezes-at-a-percentage-and-never-completes).

---

## Notifications

### What channels are supported?

In-app, webhook, **Discord**, **Slack** and **Telegram**, with fan-out to multiple
channels. See [Notification Center](/modules/notification-center).

### Which media servers can it refresh?

**Plex, Jellyfin, Emby and Kodi.** After a download is organised, UltraTorrent can
trigger a library refresh so the item appears without you touching the media server.

### My dashboard activity feed is nothing but background noise

Fixed. The metadata/artwork/IMDb enrichment sweeps write one audit row per media
item, so a single sweep of ~16 items produced ~48 rows and filled the feed. Bursty
**system-generated** events are now collapsed into a single "N events" line, while
**user-attributed** actions and the events you actually want to see individually
(renames, downloads) stay separate.

---

## Automation

### What can automation rules do?

They are **event-driven condition/action rules**. A trigger (e.g.
`torrent.completed`) fires, conditions are evaluated, and actions run — rename,
move, delete, notify, refresh a media server, and so on. See
[Automation](/modules/automation).

### Are automation runs audited?

Yes. Every rule execution is mirrored into the audit trail with the rule name, the
actions, the result, and the torrent — visible in both the Audit page and the
dashboard's Recent activity.

### Why did my rule run once and never again?

Rules use an **idempotency ledger** so a rule runs at most once per torrent, no
matter how often the poll loop evaluates it. Importantly, a **failed** run is *not*
recorded as done — so a rule blocked by a transient error (engine offline) will
retry on the next cycle rather than being silently skipped forever.

---

## Security

### Is it safe to expose UltraTorrent to the internet?

It *can* be — behind TLS, with 2FA, strong passwords, and no published engine ports.
But **a VPN is a better answer for almost everyone**. UltraTorrent moves, deletes and
executes against files.

See [Security](/operate/security#exposing-ultratorrent-to-the-internet).

### What is protecting my login?

- **Argon2id** password hashing (memory-hard, GPU/ASIC-resistant).
- **Timing-hardened login** — an unknown username still runs a verify against a
  dummy hash, so response time doesn't reveal whether an account exists.
- **Rate limiting**: `POST /api/auth/login` is capped at **5 requests / 60 s**.
  Because the 2FA step posts to the same endpoint, that limit **also bounds TOTP
  guessing**.
- **Short-lived JWTs** (15 m) plus **rotating refresh tokens with reuse detection** —
  presenting an already-revoked refresh token **burns the entire token family**.

### Does it support 2FA?

Yes — **TOTP** (RFC 6238), compatible with any standard authenticator app.
Enrolment is **confirmed, not blind**: 2FA does not activate until you prove
possession by submitting a valid code, so you cannot lock yourself out by scanning a
QR code and walking away. You get **10 single-use recovery codes**, shown once.

### Can a regular user delete my media?

Depends on the role:

- **`USER`** — read-only files. **No.**
- **`POWER_USER`** — holds **all** `files.*`, **including delete, bulk actions and
  cleanup**. **Yes.** Grant it deliberately.

Note that `torrents.delete_data` (removes data **from disk**) is a **separate
permission** from `torrents.delete`.

### Can someone with `users.manage` promote themselves to admin?

**No.** Only a `SUPER_ADMIN` may grant `SUPER_ADMIN`, and **no user may edit their
own roles**. Deactivating a user immediately revokes their refresh tokens.

### Are deleted files really gone?

**No — deletes are soft by default.** Items move into a `.ultratorrent-trash`
directory inside their own storage root and can be restored or purged. `permanent:
true` is required to delete irreversibly. The Cleanup Wizard **never deletes
automatically** — its preview is read-only and it removes only paths you explicitly
select.

### How do I report a security vulnerability?

**Privately.** Do not open a public GitHub issue. Use GitHub's private security
advisory feature for the repository, with a description, affected versions,
reproduction steps and impact.

---

## Docker

### What do the Compose profiles do?

The optional services are **off by default**:

```bash
docker compose --profile rtorrent up -d --build       # bundled rTorrent engine
docker compose --profile qbittorrent up -d            # bundled qBittorrent engine
docker compose --profile prowlarr up -d               # indexer manager
docker compose --profile flaresolverr up -d           # Cloudflare solver for Prowlarr
docker compose --profile proxy up -d                  # Caddy edge proxy + automatic TLS

# Several at once
docker compose --profile qbittorrent --profile prowlarr up -d
```

A plain `docker compose up -d` starts **no engine at all**. This surprises people.

### What must I never run?

```bash
docker compose down -v          # ← the -v DESTROYS your database volume
docker system prune --volumes   # ← can also destroy it
```

`docker system prune -f` (without `--volumes`) is safe.

### Where is my data?

| Volume | Contents | Back up? |
|--------|----------|----------|
| `postgres_data` | **Everything durable** | **Yes — critical** |
| `downloads` | Media + rTorrent's session (`/downloads/.session`) | Yes |
| `prowlarr_config` / `qbittorrent_config` | Companion settings | Recommended |
| `redis_data` | Cache / queues | **No** — no durable state |
| `caddy_data` | TLS certificates | Optional |

**And back up `.env`** — it holds `ENCRYPTION_KEY`, which is **not in your database
dump**.

### Why is the backend port not published?

By design. The frontend's nginx proxies `/api/` and `/ws/` to the backend over the
internal network, so the browser only ever talks to one port. Publish `4000` only if
you are integrating an external API client.

### Downloads are owned by root

The bundled rTorrent's entrypoint starts as root and then **drops to `PUID:PGID` via
gosu** — which needs the `SETUID`/`SETGID` capabilities. **Synology DSM strips them**,
the drop fails, and it falls back to root. That is why the Compose file carries:

```yaml
cap_add: ["SETUID", "SETGID"]
```

Keep that line, and set `PUID`/`PGID`.

---

## Performance

### What is the single biggest performance issue?

The **IMDb catalogue without trigram indexes**. `ILIKE` cannot use a btree index, so
on 8.9M rows every title lookup was a full table scan at **47.8 s**. With `pg_trgm`
GIN indexes: **180 ms**.

### How do I know if my indexes are actually working?

An **INVALID** index is worse than no index — the planner ignores it, but the *name*
exists, so `CREATE INDEX ... IF NOT EXISTS` skips the rebuild **forever**.

```sql
SELECT c.relname, i.indisvalid
FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname LIKE '%trgm%';   -- all must be `t`
```

Then confirm the planner uses them:

```sql
EXPLAIN ANALYZE SELECT * FROM imdb_titles WHERE "primaryTitle" ILIKE 'Silo';
-- Want: Bitmap Index Scan.  Do NOT want: Seq Scan.
```

### Something is "hanging". How do I tell stuck from slow?

The single most useful diagnostic in this whole documentation:

```sql
SELECT pid, now() - query_start AS duration, state, wait_event_type,
       left(query, 80) FROM pg_stat_activity
WHERE state <> 'idle' ORDER BY duration DESC LIMIT 10;
```

- **`state = active`, no lock contention, connections nowhere near the limit** →
  **starved, not stuck.** One query is so expensive it is eating the server. Look for
  a missing index.
- **`wait_event_type = Lock`** → genuine contention.

In the real incident: long `active` queries, **no locks**, and only **13 of 100**
connections in use. That combination points straight at a missing index.

### My jobs are stuck at 0% forever

Job bodies run **in-process** — they are not durable work items a worker resumes. A
deploy or restart **kills the work but leaves the row saying `running`**. One host had
**30** such rows, some 5 hours old.

Current builds reconcile these at boot (failing them out with `Interrupted by a
service restart`). The operational consequence: **do not restart mid-scan**, and
re-run whatever was in flight after an upgrade.

---

## API

### Is there an API?

Yes — UltraTorrent is **API-first**. Every capability is a documented REST endpoint
(OpenAPI/Swagger); the web UI is just one client of that API. There is also a
real-time WebSocket gateway. See [API reference](/reference/api).

### How do I authenticate?

A JWT access token (default TTL **15 minutes**) obtained from `POST /api/auth/login`,
plus a rotating refresh token. For machine access, prefer an **API key** over a
shared password.

### Why does my WebSocket connect but receive no events?

The gateway authenticates the JWT **on handshake** and joins each socket only to the
rooms matching the **view permissions it holds**. A user without `torrents.view`
connects successfully and receives nothing — by design, so a user can never get
realtime data they could not read over REST.

If it does not connect *at all*, your reverse proxy is probably not forwarding the
`Upgrade`/`Connection` headers.

### Useful endpoints for monitoring?

| Endpoint | Auth | Use |
|----------|------|-----|
| `GET /api/system/live` | none | Liveness |
| `GET /api/system/ready` | none | Readiness (dependencies usable) |
| `GET /api/system/version` | none | Version **and the git commit baked into the image** |
| `GET /api/system/health` | `system.view` | Detailed health |
| `GET /api/engines/health` | authenticated | Per-engine reachability |

`/api/system/version` is how you **prove a deploy actually landed** — if the commit
didn't change after a rebuild, your image didn't rebuild.

---

## Developer

### What is it built with?

A TypeScript monorepo: **NestJS** backend (Prisma → PostgreSQL, Redis), **React**
SPA frontend, Socket.IO for realtime. It follows **Clean Architecture** — the domain
knows nothing about HTTP, Prisma, or any specific engine.

### How do I add a new torrent engine?

Implement the **`TorrentEngineProvider`** interface — the single seam every engine
implements (add/remove/start/stop/recheck/move, file priorities, trackers, rate
limits, stats). **No UI or business-logic changes are needed.** That is the whole
point of the seam.

### How do I add a metadata source / media server / notifier?

Same pattern. **Providers are the primary extensibility mechanism**, and the rule is
explicit:

> Future integrations MUST be added as **new providers** (new implementations of a
> provider interface, wired through a factory/registry), **not** by modifying core
> modules.

A new metadata source should require **zero changes** to the services that consume it.

See [Modules reference](/reference/modules).

### Can I self-host the docs?

Yes — the site is Docusaurus with a **local, build-time search index** (no Algolia,
no API key), so it works fully **offline/air-gapped**.

---

## Still stuck?

1. Search this page and the [Glossary](/help/glossary).
2. Work through [Troubleshooting](/operate/troubleshooting) — it is symptom-first and
   built from real incidents.
3. Before filing an issue, gather:
   - `docker compose ps`
   - `docker compose logs --since 30m backend`
   - `docker inspect --format '{{.RestartCount}}' <container>`
   - `GET /api/system/version` (what you are **actually** running)
   - `GET /api/engines/health`
   - Whether the failure is **load-dependent** (fine at 10 torrents, broken at 700)

## See also

- [Troubleshooting](/operate/troubleshooting) · [Glossary](/help/glossary)
- [Quick start](/learn/quick-start) · [Concepts](/learn/concepts) · [First download](/learn/first-download)
- [Security](/operate/security) · [Performance](/operate/performance) · [Backup](/operate/backup)
- [Configuration Profiles](/operate/configuration-profiles)
- [API](/reference/api) · [Environment](/reference/environment) · [Permissions](/reference/permissions)
