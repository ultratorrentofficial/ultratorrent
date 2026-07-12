---
id: troubleshooting
title: Troubleshooting
sidebar_position: 2
description: Symptom-first troubleshooting playbook for UltraTorrent — real, diagnosed production failures with exact diagnosis commands, root causes, fixes and verification steps.
keywords:
  - troubleshooting
  - debugging
  - not working
  - broken
  - error
  - fix
  - crash
  - restart loop
  - stuck
  - hang
  - frozen
  - failed
  - download not starting
  - rtorrent crash
  - priority_queue_insert
  - internal_error
  - P3009
  - P1000
  - P1001
  - prisma migration failed
  - 429
  - Cloudflare
  - FlareSolverr
  - SSRF
  - blocked internal address
  - magnet failed
  - seeding forever
  - scan stuck
  - missing episodes
  - slow
  - logs
  - diagnostics
---

# Troubleshooting

This is the flagship operations page. Nearly every entry below is a **real
failure that was diagnosed on a live UltraTorrent host** — the numbers, log
lines and root causes are the actual ones, not invented examples. Entries that
describe a plausible-but-unconfirmed failure are explicitly marked.

Every entry follows the same shape:

> **Symptom** → **How to diagnose** (exact commands) → **Root cause** → **Fix** →
> **Verify**

## How to use this page

Work **symptom-first**. Do not start by guessing at a subsystem; start by
observing which box is misbehaving, then jump to that section.

```mermaid
flowchart TD
    A["Something is wrong"] --> B{"docker compose ps<br/>— is backend up?"}
    B -->|"restarting / exited"| C["Startup and boot"]
    B -->|"up"| D{"Does the UI load?"}
    D -->|"no"| E["Networking and reverse proxy"]
    D -->|"yes"| F{"What is failing?"}
    F -->|"downloads don't start"| G["Downloads"]
    F -->|"engine offline"| H["Engines and rTorrent"]
    F -->|"searches return nothing"| I["Indexers"]
    F -->|"shows report no missing episodes"| J["Media identification"]
    F -->|"a scan never finishes"| K["Scans and jobs"]
    F -->|"everything is just slow"| L["Performance"]
    F -->|"DB errors in the log"| M["Database"]

    click C "#startup-and-boot"
    click E "#networking-and-reverse-proxy"
    click G "#downloads"
    click H "#engines-and-rtorrent"
    click I "#indexers"
    click J "#media-identification"
    click K "#scans-and-jobs"
    click L "#performance"
    click M "#database"
```

### The decision tree operators actually need: "my download isn't starting"

This is the most-reported symptom, and it has at least six distinct causes.
Follow the tree rather than guessing.

```mermaid
flowchart TD
    S["A download isn't starting"] --> A{"Is an engine registered<br/>and online?<br/>GET /api/engines/health"}
    A -->|"online: false"| A1["Engine unreachable →<br/>Engine offline entry"]
    A -->|"online: true"| B{"Did the torrent get<br/>ADDED to the engine at all?"}

    B -->|"never appeared"| C{"Was it grabbed<br/>automatically (RSS /<br/>Smart Download / sweep)?"}
    C -->|"yes"| C1{"Log says 'resolves to a<br/>blocked internal address'?"}
    C1 -->|"yes"| C2["SSRF guard blocked the<br/>indexer's .torrent link →<br/>SSRF_ALLOW_HOSTS"]
    C1 -->|"no"| C3["Indexer returned nothing →<br/>Indexers section"]
    C -->|"no, added by hand"| C4["Check the add error in<br/>the audit trail"]

    B -->|"it's in the engine"| D{"What state is it in?"}
    D -->|"queued"| D1["Queue slots exhausted →<br/>dead torrents head-of-line<br/>blocking. Parking queue entry"]
    D -->|"metaDL / stalled,<br/>0 seeders"| D2["Dead torrent — no seeders.<br/>Nothing to download.<br/>Parking queue entry"]
    D -->|"downloading, 0 B/s"| D3["No peers / tracker issue →<br/>check trackers + seeders"]
    D -->|"marked failed, but<br/>data is arriving"| D4["Magnet confirm-window<br/>false failure entry"]
```

---

## Startup and boot

### The backend exits immediately with "insecure secret configuration"

**Symptom.** The `backend` container exits seconds after start, in a loop. The
log ends with a complaint about insecure secrets. Nothing serves.

**How to diagnose.**

```bash
docker compose logs --tail 40 backend
docker compose ps          # backend shows Restarting / Exited
```

**Root cause.** This is a **deliberate safety feature, not a bug**. When
`NODE_ENV=production`, UltraTorrent refuses to start if `JWT_ACCESS_SECRET` or
`ENCRYPTION_KEY` is:

- unset, or
- a known default (`dev-*`, `change-me`), or
- shorter than 32 characters, or
- **identical to each other**.

The hole it closes is real and serious: a forgotten secret means a predictable
JWT signing key, which means anyone can forge a `SUPER_ADMIN` token.

**Fix.** Generate genuinely random, *distinct* values and put them in `.env`:

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 48   # ENCRYPTION_KEY  (must DIFFER from JWT_ACCESS_SECRET)
```

```bash
docker compose up -d --force-recreate backend
```

:::danger Changing `ENCRYPTION_KEY` is not free
`ENCRYPTION_KEY` encrypts TOTP secrets, indexer API keys, the Prowlarr key and
engine passwords at rest. Rotating it **invalidates all of them** — users must
re-enrol 2FA and you must re-enter API keys. Set it once, correctly, and back it
up. See [Security → Rotating secrets](/operate/security#rotating-secrets).
:::

**Verify.** `docker compose ps` shows `backend` as `Up`, and
`wget -qO- http://127.0.0.1:4000/api/system/live` inside the container succeeds.

---

### The backend restart-loops after an upgrade — Prisma `P3009`

**Symptom.** After pulling a new version and rebuilding, the backend will not
boot at all. It restart-loops. The log shows a Prisma **`P3009`**: *migrate found
failed migrations in the target database*.

:::info This is a real, documented outage
This happened on **both** production hosts simultaneously. It is not a
hypothetical — and the fix below is the one that was actually used.
:::

**How to diagnose.**

```bash
docker compose logs --tail 60 backend | grep -A5 P3009

# Which migration is marked failed?
docker compose exec postgres psql -U ultratorrent -d ultratorrent \
  -c "SELECT migration_name, started_at, finished_at, applied_steps_count
      FROM _prisma_migrations
      WHERE finished_at IS NULL
      ORDER BY started_at DESC;"
```

A row with `finished_at = NULL` is a migration that started and never completed.

**Root cause.** The backend runs `prisma migrate deploy` on every start. A
migration that contains a **long-running `CREATE INDEX`** against a large table
(the fully-imported 8.9M-row IMDb catalogue) takes minutes and holds a lock. If
that build is interrupted — a deploy timeout, a container kill, an impatient
`Ctrl-C` — Prisma marks the migration **failed**, and from then on it *refuses
to run any migration at all*, so the backend never boots.

There is a deeper lesson baked into the current code: `CREATE INDEX CONCURRENTLY`
**cannot run inside a transaction**, so it can never live in a Prisma migration
regardless. UltraTorrent therefore now builds those trigram indexes at **runtime**,
in the background, via `ImdbTrigramIndexService` — the migration itself only does
a cheap `CREATE EXTENSION IF NOT EXISTS pg_trgm`. A fresh install builds them
instantly (empty catalogue); an existing one back-fills with zero downtime.

**Fix.** Tell Prisma the migration is, in fact, applied — then let the backend boot.

```bash
# 1. Confirm the migration's schema changes really are present (see below).
# 2. Mark it applied:
docker compose exec backend npx prisma migrate resolve \
  --applied 20260711060000_imdb_trigram_indexes

# 3. Boot:
docker compose up -d --force-recreate backend
```

Substitute the migration name your `_prisma_migrations` query returned.

:::caution Only resolve `--applied` if the change actually landed
`migrate resolve --applied` does not run any SQL — it only *records* the
migration as done. If the migration's changes are genuinely absent, use
`--rolled-back` instead and let it re-run. For the trigram case the migration
body is just `CREATE EXTENSION IF NOT EXISTS pg_trgm`, which is idempotent and
near-instant, so `--applied` is safe once the extension exists:

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent \
  -c "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';"
```
:::

**Verify.**

```bash
docker compose logs --tail 30 backend      # no P3009; "Nest application successfully started"
docker compose exec postgres psql -U ultratorrent -d ultratorrent \
  -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL;"   # 0
```

Then confirm the indexes it was supposed to create are being built in the
background and end up **valid** — see
[an INVALID index](#queries-are-slow-again-and-an-index-exists-but-is-ignored).

---

### The backend crashes with `Cannot find module '...'` at boot

**Symptom.** The container starts, then dies with a Node module-resolution error.

**How to diagnose.**

```bash
docker compose logs --tail 20 backend | grep "Cannot find module"
```

**Root cause.** The image is missing a nested workspace dependency. npm does not
always hoist dependencies to the root `node_modules`, so a runtime stage that
copies only the root tree can miss `apps/backend/node_modules`.

**Fix.** Rebuild with the current, unmodified Dockerfiles:

```bash
docker compose up -d --build
```

If you have customised the backend Dockerfile, ensure the runtime stage copies
`apps/backend/node_modules` as well as the root one.

**Verify.** `docker compose logs backend` reaches the Nest startup banner.

---

## Docker

### Compose refuses to start: "POSTGRES_PASSWORD is required"

**Symptom.** `docker compose up` fails instantly, before any container starts.

**Root cause.** The stack ships with **no insecure defaults**. `POSTGRES_PASSWORD`
and `ADMIN_PASSWORD` are declared with Compose's `:?` required-variable syntax, so
Compose itself refuses to render the file without them.

**Fix.** Set both in `.env`. Use an **alphanumeric** `POSTGRES_PASSWORD` — the
`DATABASE_URL` is derived from it, and URL-special characters (`@ : / ?`) would
need percent-encoding and will otherwise silently break the connection string.

**Verify.** `docker compose config` renders without error.

---

### The backend crash-loops with Prisma `P1000: Authentication failed`

**Symptom.** Postgres is up and healthy, but the backend cannot authenticate to
it — even though the password in `.env` is obviously correct.

**How to diagnose.**

```bash
docker compose logs --tail 20 backend | grep P1000
docker volume ls | grep postgres_data     # the volume already exists
```

**Root cause.** This is a classic and very confusing one. **Postgres only applies
`POSTGRES_PASSWORD` on first initialisation of its data directory.** If the
`postgres_data` volume was first created with a *different* password, later
changes to `.env` have **no effect whatsoever** on the existing volume — the old
password is still the real one.

**Fix.** If the database has no data you care about, reset it:

```bash
docker compose down -v          # DESTROYS the database volume
docker compose up -d --build
```

If it *does* have data, do not destroy it — change the password inside Postgres
to match `.env` instead:

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent \
  -c "ALTER USER ultratorrent WITH PASSWORD 'your-new-alphanumeric-password';"
docker compose up -d --force-recreate backend
```

**Verify.** `docker compose logs backend` no longer shows `P1000`, and the app serves.

---

### The web UI port is already in use (common on a NAS)

**Symptom.** `docker compose up` fails binding `8080`, or the UI is served by
something else entirely (a NAS admin panel).

**Fix.** Set a free port in `.env` and re-up:

```dotenv
FRONTEND_PORT=8123
```

```bash
docker compose up -d
```

:::warning Do not try to remap the port with a Compose override file
Compose **appends** `ports` entries rather than replacing them, so the original
`8080` mapping survives alongside your new one and still conflicts. Use
`FRONTEND_PORT`.
:::

**Verify.** `docker compose ps` shows the new host port; the UI loads on it.

---

### Downloads are owned by root, or the app cannot write to a path

**Symptom.** *"The app process cannot write to this path"* when setting the
Default Root Path; or downloaded files land owned by `root` and your media
server cannot read them.

**How to diagnose.**

```bash
docker compose exec rtorrent id            # who is rtorrent actually running as?
ls -ln /path/to/downloads                  # numeric owner of the tree
```

**Root cause.** The bundled rTorrent entrypoint starts as root, chowns the
downloads volume, then **drops to `PUID:PGID` via gosu**. That drop needs the
`SETUID`/`SETGID` capabilities. Some hosts — **notably Synology DSM** — strip
those from the container's default capability set, the drop fails with
*"operation not permitted"*, and the entrypoint falls back to running as **root**.
This is why `docker-compose.yml` explicitly re-adds them:

```yaml
cap_add: ["SETUID", "SETGID"]
```

**Fix.**

- Ensure your Compose file still carries that `cap_add` (it is in the shipped one).
- Set `PUID`/`PGID` to the user that should own the media. If the folder belongs
  to another app (e.g. Plex), **do not `chown` it** — set `PUID`/`PGID` to *that*
  user instead (`id plex`), so rTorrent writes as them.

```dotenv
PUID=1000
PGID=1000
```

```bash
docker compose --profile rtorrent up -d --force-recreate rtorrent
```

**Verify.** `docker compose exec rtorrent id` reports your `PUID`, and newly
downloaded files carry that owner.

---

## Database

### A query is slow and `pg_stat_activity` shows long `active` queries

This is the diagnostic technique behind the single worst performance incident in
UltraTorrent's history, so it is worth learning properly. See
[a library scan freezes](#a-library-scan-freezes-at-a-percentage-and-never-completes)
for the incident itself.

**How to diagnose.** The crucial skill is telling **starved** from **stuck**:

```bash
# Long-running queries, newest first. Look at `state` and `wait_event_type`.
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT pid, now() - query_start AS duration, state, wait_event_type, wait_event,
       left(query, 90) AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND query_start IS NOT NULL
ORDER BY duration DESC
LIMIT 15;"

# Connection headroom — is the pool even full?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT count(*) AS used, current_setting('max_connections') AS max
FROM pg_stat_activity;"

# Actual lock contention (usually NOT the problem)
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT pid, relation::regclass, mode, granted
FROM pg_locks WHERE NOT granted;"
```

**How to read it.**

| Observation | Means |
|-------------|-------|
| `state = active`, long duration, `wait_event_type` is null/`CPU` | **Starved, not stuck.** The database is *working* — the query is genuinely expensive. Fix the query or the index. |
| `state = active`, `wait_event_type = Lock` | Genuine lock contention. Find the blocker. |
| `pg_locks` has ungranted rows | Lock contention. |
| Connections far below `max_connections` | The pool is **not** exhausted — you are not connection-starved. |

In the real incident the numbers were: long `active` queries, **no** lock
contention, and only **13 of 100** connections in use. That combination is the
signature of *"one query is so expensive it is eating the server"*, and it points
you straight at a missing index rather than at concurrency.

---

### Queries are slow again, and an index "exists" but is ignored

**Symptom.** You created the trigram indexes, but lookups are still slow. `\di`
shows the index by name — yet `EXPLAIN` never uses it.

**How to diagnose.**

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT c.relname AS index_name, i.indisvalid, i.indisready
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname LIKE '%trgm%';"
```

**Root cause.** An interrupted `CREATE INDEX CONCURRENTLY` leaves the index
behind in an **INVALID** state (`indisvalid = false`). The planner ignores an
invalid index completely — but the *name* exists, so a naive
`CREATE INDEX ... IF NOT EXISTS` sees it and skips the rebuild **forever**. You
get an index that is permanently present and permanently useless.

UltraTorrent's `ImdbTrigramIndexService` handles this explicitly: it detects an
invalid index, **drops it**, and rebuilds it. But if you built an index by hand
and interrupted it, you own the cleanup.

**Fix.**

```sql
DROP INDEX CONCURRENTLY IF EXISTS <the_invalid_index_name>;
-- then let the service rebuild it on next boot, or rebuild by hand:
CREATE INDEX CONCURRENTLY IF NOT EXISTS imdb_titles_primary_title_trgm
  ON imdb_titles USING gin ("primaryTitle" gin_trgm_ops);
```

**Verify.** `indisvalid` is `true`, and `EXPLAIN` on a title lookup shows a
**Bitmap Index Scan** rather than a Seq Scan.

---

### `P1001: Can't reach database server at postgres:5432`

**Symptom.** Prisma cannot reach the database. Almost always a **manual
(non-Docker) install**.

**Root cause.** `DATABASE_URL` still points at the Docker **service name**
`postgres`, which does not resolve outside the Compose network.

**Fix.** For a manual install, point it at `localhost`:

```dotenv
DATABASE_URL=postgresql://ultratorrent:PASSWORD@localhost:5432/ultratorrent?schema=public
```

For Docker, leave it alone — the backend derives it from `POSTGRES_*`
automatically, so it cannot drift from the database password.

**Verify.** `npx prisma migrate status` connects.

---

## Networking and reverse proxy

### The UI loads but the API 404s / CORS errors in the browser console

**How to diagnose.** Open the browser devtools Network tab and look at where the
`/api/...` requests actually go, and what they return.

```bash
# Is the backend reachable from the frontend container?
docker compose exec frontend wget -qO- http://backend:4000/api/system/live
```

**Root cause.** One of:

1. Your reverse proxy is not forwarding `/api/` to the backend.
2. `CORS_ORIGIN` does not include the origin the browser is actually using.
   CORS is restricted to the configured origin; the value is comma-separated.

**Fix.** Set `CORS_ORIGIN` to the exact scheme+host+port the browser uses:

```dotenv
CORS_ORIGIN=https://ultratorrent.example.com
```

Recreate the backend. See [Reverse proxy](/install/reverse-proxy).

**Verify.** The `/api/system/live` request succeeds from the browser with no CORS
error.

---

### The WebSocket never connects (no live updates)

**Symptom.** Torrent rows never update in real time; you must refresh manually.

**How to diagnose.** In devtools, look for the `/ws` request failing to upgrade
(HTTP 400/404 instead of 101 Switching Protocols).

**Root cause.** Either the JWT is missing/expired, or — far more commonly — your
reverse proxy is **not passing the WebSocket upgrade headers**. A plain HTTP
proxy pass is not enough; `Upgrade` and `Connection` must be forwarded.

**Fix.** nginx:

```nginx
location /ws/ {
    proxy_pass http://backend:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Caddy handles the upgrade automatically — the shipped `deploy/Caddyfile` routes
`/api/*` and `/ws/*` to `backend:4000` with no extra configuration.

**Verify.** The `/ws` request returns **101**, and torrent progress bars move
without a refresh.

:::note
The WebSocket gateway authenticates the JWT **on handshake** and joins each
socket only to the rooms matching the view permissions it holds. If a user
connects but receives no events, check their permissions — they may simply lack
`torrents.view`. See [Permissions](/reference/permissions).
:::

---

## Engines and rTorrent

### rTorrent restarts constantly — `internal_error: priority_queue_insert`

:::danger This is an unfixable upstream bug. Read this before scaling up.
:::

**Symptom.** The bundled rTorrent container restarts periodically — in the real
incident, **43 restarts in 4 days**. The log shows:

```
internal_error: priority_queue_insert(...) called on an invalid item.
```

Transfers briefly pause and everything re-announces, but **no torrents are lost**.

**How to diagnose.**

```bash
# How many times has it restarted?
docker inspect --format '{{.RestartCount}}' $(docker compose ps -q rtorrent)

# The smoking gun
docker compose logs rtorrent | grep -c "internal_error"
docker compose logs rtorrent | grep "priority_queue_insert" | tail -3

# How many torrents is it carrying? (this is the driver)
docker compose ps rtorrent
```

**Root cause.** The bundled engine is rTorrent `0.9.8` (the maintained jesec
`v0.9.8-r16` static binary — already the newest release in that lineage). It
carries a long-standing **upstream bug** fired during tracker-announce
scheduling. It has **no fix in the 0.9.8 lineage** (see
[rakshasa/rtorrent#939](https://github.com/rakshasa/rtorrent/issues/939)).

The critical property is that it is **load-driven**. The measured evidence from
two live hosts running the *identical* build:

| Host | Active torrents | Crashes |
|------|-----------------|---------|
| A | **752** | **44** (~10/day) |
| B | **7** | **0** |

The crash cleanly exits the process (exit 0), Docker's `restart: unless-stopped`
relaunches it, and the saved session reloads — hence "no torrents lost".

**Fix.** There is **no in-engine fix**. Mitigations, in order of impact:

1. **Switch to a sturdier engine.** UltraTorrent's engine layer is multi-engine.
   **qBittorrent handles thousands of torrents comfortably** and is the durable
   answer for a large library:

   ```bash
   docker compose --profile qbittorrent up -d
   # Get the first-run temporary password:
   docker compose logs qbittorrent | grep -i password
   ```

   Then register it under **Infrastructure → Engines** (kind qBittorrent, base URL
   `http://qbittorrent:8080`). See [Engines](/modules/engines).

2. **Keep the active torrent count modest.** Remove or stop completed seeds. The
   crash rate falls with the torrent count.

3. **Already applied for you:** UDP tracker announces are disabled in
   `deploy/rtorrent/rtorrent.rc` (`trackers.use_udp.set = no`), which removes a
   *secondary* `TrackerList::receive_failed` crash variant. HTTP/HTTPS trackers
   and PEX still find peers. DHT is likewise off by default (`RT_DHT=off`). Note
   that neither of these fixes the **dominant** `priority_queue_insert` crash.

4. **A healthcheck now surfaces the rarer "process alive but SCGI wedged" state**
   as `unhealthy` (it checks the SCGI port is listening via `ss`). A crash already
   exits the process, so Docker recovers that case on its own.

**Verify.**

```bash
# After switching engines or reducing torrents, the restart count should stop climbing:
docker inspect --format '{{.RestartCount}}' $(docker compose ps -q rtorrent)
# ...wait a day...
docker inspect --format '{{.RestartCount}}' $(docker compose ps -q rtorrent)
```

---

### rTorrent crash-loops: "Could not lock session directory … held by …"

**Root cause.** A previous rTorrent crash left a stale `rtorrent.lock` behind.

**Fix.** Current images clear it automatically on startup — pull and rebuild:

```bash
git pull && docker compose --profile rtorrent up -d --build rtorrent
```

To clear it by hand:

```bash
sudo rm -f <downloads>/.session/rtorrent.lock
```

**Verify.** rTorrent stays up; `docker compose ps rtorrent` shows healthy.

---

### rTorrent crashes with `DhtServer::event_write … both write queues are empty`

**Root cause.** A known DHT bug in this rTorrent build. **DHT is off by default
for exactly this reason.**

**Fix.** If you enabled it, turn it back off:

```dotenv
RT_DHT=off
```

```bash
docker compose --profile rtorrent up -d --force-recreate rtorrent
```

Trackers and PEX still find peers.

---

### An engine shows `online: false` / "Could not load torrents"

**How to diagnose.**

```bash
# The authoritative signal:
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/engines/health

# Is the engine container even running?
docker compose ps rtorrent qbittorrent

# Can the backend reach it?
docker compose exec backend wget -qO- http://qbittorrent:8080/api/v2/app/version
```

**Root cause.** Usually one of:

1. **No engine is registered at all.** Register one under **Infrastructure →
   Engines** and use **Test connection**.
2. **The stack was brought up without the profile.** The bundled engines are
   behind Compose profiles and are **off by default**. `docker compose up -d`
   alone starts *no* engine.
3. Wrong connection details. For the bundled rTorrent: kind `rtorrent`, mode
   `scgi-tcp`, host `rtorrent`, port `5000`. For the bundled qBittorrent: base URL
   `http://qbittorrent:8080`.

**Fix.** Start the profile you actually want:

```bash
docker compose --profile qbittorrent up -d
# or
docker compose --profile rtorrent up -d --build
```

**Verify.** `/api/engines/health` reports `online: true`.

---

### qBittorrent "Test connection" fails with 401/unauthorized

**Symptom.** The credentials are definitely right, but the engine test fails.

**Root cause.** Two separate, real gotchas:

1. **Host header validation.** qBittorrent rejects requests whose `Host` header
   it does not recognise. The backend connects by the Docker **service name**
   (`qbittorrent`), which qBittorrent does not trust by default.
2. **The login contract changed in qB 5.x.** A successful
   `POST /api/v2/auth/login` now answers **`204 No Content`** (not `200 "Ok."`)
   and sets a **`QBT_SID_<port>`** cookie (not `SID`). A client that hard-codes
   the old contract fails with a misleading *"login failed (204)"*. UltraTorrent's
   client was fixed to accept both — but if you see this against an old build,
   this is why.

**Fix.** In the qBittorrent Web UI: **Options → Web UI** → disable **"Enable Host
header validation"** (or set *Server domains* to `*`).

**Verify.** **Test connection** goes green; torrents list.

---

### Torrents seed forever despite a working "delete on complete" rule

:::info A genuinely subtle one — two independent bugs produced the same symptom
:::

**Symptom.** You have a "delete on complete" automation rule. It is enabled. The
automation log even says it ran and **succeeded**. The torrents are still there,
still seeding, forever.

**How to diagnose.**

```bash
# Does the engine still have the torrent the app believes it deleted?
docker compose exec rtorrent sh -c \
  'echo "d.multicall2 ... d.is_open=" | true'   # (see note below)

# Easier: compare what the app lists vs what the engine lists.
# In the UI, check the automation rule's history — does it claim success?
```

The tell is a rule that logs `delete=success` for a torrent that is demonstrably
**still loaded and seeding in the engine**.

**Root cause.** Two causes, both real, both now fixed — but worth understanding
because they explain the symptom completely:

1. **rTorrent's `d.erase` silently no-ops.** rTorrent 0.9.8 intermittently
   *accepts* the erase call, returns **no error**, and yet **leaves the download
   loaded**. The provider fired `d.erase` once and trusted the return value. The
   phantom `success` then poisoned the automation ledger, which marked the torrent
   done and **never retried**. It was aggravated by *bursts* of erases — exactly
   what a "delete on complete" rule produces.

   *Fix:* removal is now **verified**. `eraseAndConfirm` erases, then confirms the
   torrent is actually gone via a cheap one-field `d.multicall2` check, and
   **retries** (5 attempts × 400 ms). If the torrent survives, it **throws** — so
   the run logs a real `failure` and the reconciler retries next cycle, rather than
   cementing a phantom success. Data deletion now also confirms the erase *before*
   removing files, so data is never deleted while the torrent is still loaded.

2. **The completion trigger was a one-shot rising edge.** `torrent.completed`
   fired only on the exact 2-second poll where a torrent's *persisted* progress
   snapshot crossed from `<1` to `≥1`. Snapshots live in Postgres, so **any torrent
   already at 100% when it was first snapshotted was permanently past the edge** —
   the rule never ran for it. This affected torrents that finished while the app
   was not polling, and every torrent that existed *before* the rule was created.

   *Fix:* a backfill pass (`reconcileCompleted`) now runs each sync cycle for
   completed torrents that did not rise on that tick, using the automation log as
   an idempotency ledger so a rule runs at most once per torrent.

**Fix.** Upgrade to a build that contains both fixes (see [Upgrading](/install/upgrading)).

Then check the **third**, configuration-level trap:

:::warning The qBittorrent "delete on complete" trap
qBittorrent maps completed/seeding torrents to the `SEEDING` state and **never
emits `COMPLETED`**. So a rule with a condition like `state == 'completed'` will
**never match** on qBittorrent.

**A "delete on complete" rule should have _empty_ conditions** — the
`torrent.completed` trigger is already the condition.
:::

**Verify.** Complete a torrent (or wait for the reconciler on an existing one) and
confirm it disappears from **both** the UI *and* the engine. A failed removal now
shows as a real `failure` in the automation log rather than a false success.

---

### Dead torrents block every healthy one (nothing downloads at all)

**Symptom.** The engine holds a large number of torrents and is moving
**0 bytes**. Not slow — *zero*. Healthy torrents sit in `queued` and never start.

The real incident: **1,137 torrents, 0.00 GB all-time download.** DHT was healthy
(366 nodes), trackers answered — the network was fine.

**How to diagnose.**

```bash
# In the engine (qBittorrent example), count torrents by state:
#   How many are metaDL / stalledDL / queuedDL?
# The signature: your max_active_downloads slots are ALL held by
# torrents in metaDL or stalledDL, and everything healthy is queuedDL.
```

Check seeders: in the real case **1,114 of 1,137 torrents reported zero seeders**.

**Root cause.** A beautiful piece of head-of-line blocking:

1. The missing-episode sweep worked through the whole back-catalogue and grabbed
   whatever the indexers returned. Two of four indexers had **no `minSeeders`
   set** — and the per-indexer seeder filter *only applies when that column is
   set* — so **0-seeder releases sailed straight through**.
2. **A 0-seeder magnet can never fetch its metadata — yet the engine counts it as
   an active download the entire time it tries.**
3. With `max_active_downloads: 100`, exactly **88 `metaDL` + 12 `stalledDL` = 100
   slots permanently held by torrents that will never finish**. The other 1,034
   healthy torrents sat in `queuedDL` behind them, unable to start.

**Fix.**

1. **Set `minSeeders` on every indexer.** This is the root cause and the
   prevention. An indexer with no `minSeeders` will happily hand you corpses. See
   [Indexers](/modules/indexers).
2. **Enable the parking queue.** UltraTorrent ships a `TorrentParkingService`
   that runs every 5 minutes: a torrent that is `DOWNLOADING`, below `minSeeders`,
   with nobody connected, no bytes moving, and past a grace period is **paused and
   recorded**. A paused torrent holds no slot, so the engine promotes a queued one
   into the freed slot — **the queue drains its own dead weight**.

   It also solves the obvious trap: a paused torrent never announces, so its
   seeder count could never refresh and parking would be a one-way trip. So each
   tick it **force-starts** a batch of parked torrents, reads the outcome next
   tick, and releases any that found seeders back into the normal queue.
   Persistently dead ones back off exponentially.

   It never touches a `QUEUED` torrent (costs no slot) or a `PAUSED` one (somebody
   paused that deliberately).

   :::caution Ships disabled by default
   The parking queue is **off by default** — you must enable it. It is a powerful
   automatic pauser, and enabling it is a deliberate operator decision.
   :::

3. Manually purge the dead ones you already have (bulk-remove 0-seeder torrents).

**Verify.** Slot occupancy drops, `queuedDL` starts draining, and bytes begin
moving. Re-check that no indexer is left without a `minSeeders`.

---

## Indexers

### An indexer always returns HTTP 429, and FlareSolverr cannot fix it

:::info Observed in the wild
This was hit on a live deployment: **1337x** returned `429` through Prowlarr on
*every* request, indefinitely. Not a burst — a block. FlareSolverr made no
difference, because it solves **JavaScript/Cloudflare challenges**, not an
IP-level rate limit or ban. The fix was to **disable that indexer** and let the
others carry the searches; the acquisition sweep kept working, because one dead
indexer does not stop the rest.
:::

**Symptom.** One indexer — often 1337x — returns **HTTP 429 (Too Many Requests)**
on *every* request, forever. Every mirror behaves the same. Lowering the request
rate changes nothing. Adding FlareSolverr does not help.

**How to diagnose.**

```bash
# 1. Confirm it's ALL requests, not rate-related — wait an hour, try once:
docker compose logs --tail 100 prowlarr | grep -i "429\|too many"

# 2. Test the indexer from the HOST's egress IP, not from a browser
#    on a different network:
docker compose exec prowlarr curl -sS -o /dev/null -w "%{http_code}\n" https://1337x.to/

# 3. The decisive test — ask FlareSolverr to solve it:
docker compose exec prowlarr curl -sS -X POST http://flaresolverr:8191/v1 \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://1337x.to/","maxTimeout":60000}'
```

**Root cause.** If FlareSolverr responds with a message to the effect of *"your IP
is banned for this site"*, you have your answer: the **host's egress IP address is
Cloudflare-banned for that site**, across **all** mirrors.

The critical insight — and the reason this wastes so much operator time — is:

> **FlareSolverr cannot solve a challenge for a banned IP.** FlareSolverr's job is
> to *solve* an anti-bot challenge. A ban is not a challenge. There is nothing to
> solve. No amount of FlareSolverr, retry tuning, rate limiting, or mirror-hopping
> will fix an IP-level ban.

This is **not fixable by configuration**.

**Fix.** Only two things actually work:

1. **Get a clean egress IP** — a VPN, a different upstream, or a proxy whose IP is
   not banned.
2. **Drop the indexer.** Disable it in Prowlarr/UltraTorrent and use one that will
   talk to you.

Do **not** spend time tuning rate limits. The 429 is not about your rate.

**Verify.** The direct `curl` from the container returns 200 rather than 429, and
a test search returns results.

---

### An indexer's search returns nothing (but the connection test passes)

**Root cause.** The most common cause is that the `minSeeders` filter or the
category configuration is excluding everything. A per-indexer failure is also
**isolated** — one broken indexer does not fail the whole search, so a silently
failing indexer can be easy to miss.

**How to diagnose.** Check the backend log during a search for per-indexer errors,
and temporarily clear `minSeeders`/categories to see if results appear.

**Fix.** Correct the categories and seeder threshold. See [Indexers](/modules/indexers)
and [Prowlarr](/modules/prowlarr).

---

### A Cloudflare-protected indexer fails with "blocked by Cloudflare Protection"

**Root cause.** Some trackers (e.g. **EZTV**) sit behind Cloudflare's anti-bot
challenge. Prowlarr cannot solve it alone. **This one FlareSolverr genuinely does
fix** — unlike the IP-ban case above.

**Fix.** Bring up FlareSolverr and wire it into Prowlarr:

```bash
docker compose --profile prowlarr --profile flaresolverr up -d
```

Then in **Prowlarr**:

1. **Settings → Indexers → Add Indexer Proxy → FlareSolverr.**
2. **Host:** `http://flaresolverr:8191`. Give it a **Tag** (e.g. `cloudflare`). Save.
3. Open the Cloudflare-protected indexer and add the **same tag** to it.
4. Re-test the indexer.

**Verify.** The indexer test passes and searches return results.

---

## Downloads

### Auto-downloads silently do nothing — "resolves to a blocked internal address"

:::info The trap: the Prowlarr connection test still passes
:::

**Symptom.** RSS rules, Smart Download and the missing-episode sweep all *grab*
releases — and then nothing downloads. The Prowlarr **connection test is green**.

**How to diagnose.**

```bash
docker compose logs backend | grep -i "blocked internal address"
```

**Root cause.** Auto-downloads fetch the indexer's `.torrent` link over HTTP. The
backend's **SSRF guard blocks any URL that resolves to a private/internal
address** unless its host is explicitly allow-listed. A self-hosted indexer —
including the **bundled Prowlarr** at `http://prowlarr:9696` — returns proxy links
on a **private Docker IP**, so the guard blocks them.

The reason this is so confusing: **the Prowlarr health check and the torrent fetch
are two different guards.** The health check trusts private hosts (so it passes);
the torrent fetch is the stricter one (so it blocks). A green badge proves the API
is reachable — it does **not** prove grabs will download.

**Fix.** Allow-list the indexer host in `SSRF_ALLOW_HOSTS`:

```dotenv
# Defaults to `prowlarr` so the bundled indexer works out of the box.
# Keep `prowlarr` in the list if you use it!
SSRF_ALLOW_HOSTS=prowlarr,indexer.lan,10.0.0.0/24
```

Entries are comma-separated **hostnames, IPs, or IPv4 CIDRs**. Recreate the backend:

```bash
docker compose up -d --force-recreate backend
```

The scheme allow-list (`http(s)` only), redirect refusal and 20 MB body cap
**still apply** to allow-listed hosts — only the private-address block is lifted,
and only for the hosts you name.

**Verify.** Trigger a grab; the torrent appears in the engine, and the
"blocked internal address" line stops appearing in the log.

---

### A magnet is marked "failed" but actually downloads fine

**Symptom.** The audit trail fills with `media_acquisition.download.failed`
entries saying the torrent *"never registered within 6s"* — while the torrent is
demonstrably **downloading perfectly**.

The real numbers: **257 `download.failed` events over 4 days, of which 256
actually loaded**, at a **median of ~53 seconds** after the "failure".

**How to diagnose.**

```bash
docker compose logs backend | grep "never registered"
```

Then check whether those info-hashes are, in fact, in the engine. (They will be.)

**Root cause.** After a fire-and-forget load, the rTorrent provider polls the
download list to confirm the torrent registered, for **20 attempts × 300 ms ≈ 6
seconds**, and threw if the info-hash never appeared.

That window is **perfectly fine for a `.torrent` file** — the metadata is already
present, so it registers near-instantly. It is **completely wrong for a magnet**:
rTorrent does not list a magnet's hash until it has **fetched the metadata from
DHT/peers**, which routinely takes far longer than 6 seconds (median ~53 s in
production, and *all* acquisition grabs are magnets).

The throw caused the executor to mark the action `failed` and write an audit row
**while the magnet downloaded fine** — audit noise, plus a real duplicate-add risk
(the still-loading hash could be re-added by a retry).

**Fix.** Upgrade. The confirm step is now magnet-aware: a magnet that has not
registered within the window is treated as **accepted/pending** (the 2-second
torrent sync reconciles it when it registers), while a **`.torrent` file still
throws** — so a genuinely broken file or a crashed engine is still surfaced.

**Verify.** `download.failed` events drop to (near) zero, while downloads continue
to work.

---

## Media identification

### A show never reports any missing episodes (scans to 0/0/0)

**Symptom.** A series on the watchlist scans to **0 episodes / 0 owned / 0
missing**, forever. It never finds anything to grab.

**How to diagnose.** Check whether the show carries an IMDb id at all, and whether
that id is actually a **series** id:

```bash
# Does the watchlist item have an IMDb id?
# (UI: Media Acquisition → Watchlist → the item → External IDs)

# Does the stored tconst yield any episodes in the catalogue?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT count(*) FROM imdb_episodes WHERE \"parentTconst\" = 'tt16091606';"
```

A stored tconst that yields **0 catalogue episodes** is the tell.

**Root cause.** Everything downstream of a series keys off its **IMDb id**. There
are four distinct ways that id goes wrong — **all four were real, and all four now
self-heal**:

| Failure | Real example | What happened |
|---------|--------------|---------------|
| **An episode id instead of the series id** | *Silo* pinned to `tt16091606` (an episode) instead of `tt14688458` (the series) | The stored tconst yields **0 episodes**, so the scan is permanently 0/0/0. |
| **Accents** | `90 Day Fiancé` (IMDb) vs `90 Day Fiance` (library) | Accents were *stripped*, not *folded*: `é` vanished rather than becoming `e`, so the two keys never matched. |
| **Punctuation** | `FBI: Most Wanted` (IMDb) vs `FBI Most Wanted` (RSS rule); `Chicago P.D.` vs `Chicago PD` | Names sourced from RSS rules strip `:`/`&`/`.`/`'`, so an exact-title lookup missed. |
| **No IMDb id at all** | A show identified against **TVDB** | It read as `monitorable: false` and was invisible to missing-episode scans. On one host only **74 of 8,986** TV items had a series IMDb id. |

There was also a **parser** bug in the same family: separator normalisation turned
a title's *own* dots into spaces, shattering acronyms — `L.A.'s Finest` became
`L A 's Finest`, `Chicago P.D.` became `Chicago P D`.

And a **scanner** bug: new media items were created with
`title = basename(file)` and **no season/episode**, so a show fragmented into one
bogus entry per episode. On one host **3,579 of 5,840** TV items were in this
state.

**Fix.** Upgrade — every one of these now self-heals:

- A tconst that yields 0 episodes is **re-resolved from the title**, corrected,
  persisted and audited.
- Title keys now fold diacritics (NFD + drop combining marks) **before** stripping,
  so `é → e` (this also fixes `Pokémon` ↔ `Pokemon`).
- A punctuation-insensitive match runs when the exact match misses.
- Library shows with no IMDb id are resolved against the local catalogue by title
  (+ year) and the tconst is written onto **every** media item of the show.

You can also force the heal explicitly:

```
POST /media-acquisition/watchlist/library/resolve-imdb
```

Production result after the heal: one host went to **654/654** shows monitorable
(from 599), another to **211/212**.

**Verify.** The show now reports a real episode count and a real missing count.
If a show *still* will not resolve, it may genuinely be absent from your IMDb
catalogue (or catalogued only under a localised title) — set the IMDb id by hand
on the watchlist item.

:::note Why prefix matching is deliberately NOT used
It is tempting to match `90 Day Fiancé: Pillow Talk` against `90 Day Fiancé` by
prefix. That is exactly what would let a **spin-off hijack the parent show**. The
matcher refuses to guess: a show catalogued only under a localised full title
stays unresolved and must be set by hand. This is intentional.
:::

---

### An episode appears on the watchlist as if it were a series

**Symptom.** The Missing Episodes list shows **episodes** where shows should be
(e.g. `90 Day Fiance - S12E09` listed as a series).

**Root cause.** A downloaded episode was added to the watchlist as a `series`,
because the add path used the raw episode title rather than collapsing it to the
series name.

**Fix.** Upgrade. The watchlist now collapses an episode-formatted title to the
series name on add, the add-from-library picker groups by the parsed series title,
and bulk-add dedupes on the collapsed title so two episodes of one show do not
create two entries. Clean names (`9-1-1`, `1923`) are deliberately left untouched.

**Verify.** The watchlist lists shows, not episodes.

---

## Scans and jobs

### A library scan freezes at a percentage and never completes

:::danger The single worst performance incident in this project's history
It is also the most instructive. Read the diagnosis method — it generalises.
:::

**Symptom.** A movie library scan sits wedged at 8%, then 41%, then 74% —
**indefinitely**. No error. No crash. It simply never finishes.

**How to diagnose.** This is the part worth learning.

```bash
# Long-running queries — are they ACTIVE (working) or WAITING (blocked)?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT pid, now() - query_start AS duration, state, wait_event_type,
       left(query, 80) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY duration DESC LIMIT 10;"

# Is it lock contention?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT count(*) FROM pg_locks WHERE NOT granted;"

# Is the connection pool exhausted?
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT count(*) FROM pg_stat_activity;"
```

**What the evidence said** — and this is the whole lesson:

- `pg_stat_activity` showed **long-running `active` queries**.
- There was **no lock contention**.
- Only **13 of 100 connections** were in use.

Read that combination carefully. Nothing is *blocked*. Nothing is *waiting*. The
pool is nowhere near full. The database is simply **working extremely hard on one
query**. The scan was not **stuck** — it was **starved**.

**Root cause.** Prisma renders `mode: 'insensitive'` as SQL **`ILIKE`** — and
**`ILIKE` cannot use a btree index**.

On the **8.9-million-row** IMDb catalogue, that made every case-insensitive title
lookup a **full table scan**. Measured on a live host:

> **47.8 seconds per lookup.**

The planner walked an existing btree index *backward*, `ILIKE`-filtering the whole
table as it went. And those lookups fire **per media item** (show-status warm-up,
identification, missing-episode self-heal) — so they **saturated Postgres and
starved every other query**, including the scan's own.

**Fix.** Make `ILIKE` index-backed with **pg_trgm GIN indexes**:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS imdb_titles_primary_title_trgm
  ON imdb_titles USING gin ("primaryTitle" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS imdb_titles_original_title_trgm
  ON imdb_titles USING gin ("originalTitle" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS imdb_akas_title_trgm
  ON imdb_akas USING gin (title gin_trgm_ops);
```

The result on the same query, on the same 8.9M rows:

| | Before | After |
|---|--------|-------|
| Plan | Seq/backward index scan | **Bitmap Index Scan** |
| Time | **47.8 s** | **180 ms** |
| Speedup | — | **~265×** |

**No application code change was needed.** The query was fine; the index was missing.

Current builds do this for you: the migration only enables the extension, and
`ImdbTrigramIndexService` builds the three GIN indexes **`CONCURRENTLY`, in the
background, at runtime** — so a fresh install builds them instantly and an existing
one back-fills with **zero downtime**. (Building them *inside* the migration is
what caused the [P3009 outage](#the-backend-restart-loops-after-an-upgrade--prisma-p3009).)

**Verify.**

```sql
EXPLAIN ANALYZE
SELECT * FROM imdb_titles WHERE "primaryTitle" ILIKE 'The Expanse';
-- Expect: Bitmap Index Scan, single-digit-to-low-hundreds of ms.
```

And confirm the indexes are **valid**, not INVALID — see
[an index exists but is ignored](#queries-are-slow-again-and-an-index-exists-but-is-ignored).

---

### Jobs are stuck "running" forever

**Symptom.** The jobs list shows `metadata_fetch` / `subtitle_scan` rows frozen at
**0%**, `running`, for hours. One live host had **30** such rows, some **5 hours**
old.

**How to diagnose.**

```bash
docker compose exec postgres psql -U ultratorrent -d ultratorrent -c "
SELECT id, type, status, progress, \"createdAt\"
FROM media_processing_jobs
WHERE status IN ('queued','running')
ORDER BY \"createdAt\";"
```

**Root cause.** Job bodies run **in-process** — they are *not* durable work items
that a separate worker picks up and resumes. So a **deploy or restart kills the
work but leaves the database row saying `running`**, forever. Nothing was ever
going to move it.

**Fix.** Upgrade. There is now a boot-time reconciliation: any `queued` or
`running` row found at startup necessarily belongs to a **dead process**, so it is
failed out with `Interrupted by a service restart`. It is best-effort and never
blocks boot.

To clear existing orphans by hand:

```sql
UPDATE media_processing_jobs
SET status = 'failed', error = 'Interrupted by a service restart'
WHERE status IN ('queued','running');
```

**Verify.** After a restart, no job row is left `running` from a previous process.

:::tip Operational consequence
Because jobs are in-process, **a restart interrupts running work**. Do not restart
the backend mid-import if you can avoid it — and after any deploy, re-run whatever
scan or import was in flight.
:::

---

### A missing-episode sweep dies partway through

**Symptom.** The sweep processes a couple of episodes and then stops, losing the
rest of the batch.

**Root cause.** A concurrent library/watchlist scan **deletes and recreates**
`WantedEpisode` rows. The sweep updated a row by id, which threw Prisma **`P2025`**
("Record to update not found") when the row had vanished mid-sweep. Worse, the
per-episode *error handler* also wrote state — so the throw escaped the loop and
rejected the **entire sweep**, losing the other ~48 episodes in the batch. It was
observed live: a manual re-scan overlapping a sweep tick killed it after 2 episodes.

**Fix.** Upgrade. The state write is now a no-op for a missing row instead of a
throw, so a vanished row is skipped and the tick completes.

**Verify.** Run a manual re-scan concurrently with a sweep; the sweep completes.

---

## Performance

Performance has its own page — see [**Performance**](/operate/performance) for
tuning, the IMDb catalogue, indexes, rTorrent at scale and large libraries.

The two performance failures that most often present as *"it's broken"* rather
than *"it's slow"* are documented above, because that is how operators experience
them:

- [A library scan freezes and never completes](#a-library-scan-freezes-at-a-percentage-and-never-completes) — missing trigram indexes.
- [Dead torrents block every healthy one](#dead-torrents-block-every-healthy-one-nothing-downloads-at-all) — head-of-line blocking.

---

## Logs

### Where the logs are

```bash
# Everything, following
docker compose logs -f

# One service
docker compose logs -f backend
docker compose logs -f rtorrent
docker compose logs -f postgres

# Recent only (the most useful form)
docker compose logs --since 15m --tail 200 backend

# Errors only
docker compose logs --since 1h backend | grep -iE "error|fatal|refused|failed"
```

### Log lines worth knowing on sight

| Log line | Means | Go to |
|----------|-------|-------|
| `insecure secret configuration` | Production boot guard tripped | [Secrets](#the-backend-exits-immediately-with-insecure-secret-configuration) |
| `P3009` | A failed migration blocks boot | [P3009](#the-backend-restart-loops-after-an-upgrade--prisma-p3009) |
| `P1000: Authentication failed` | Postgres volume has an older password | [P1000](#the-backend-crash-loops-with-prisma-p1000-authentication-failed) |
| `P1001: Can't reach database server` | Wrong `DATABASE_URL` host | [P1001](#p1001-cant-reach-database-server-at-postgres5432) |
| `internal_error: priority_queue_insert` | rTorrent 0.9.8 upstream crash | [rTorrent](#rtorrent-restarts-constantly--internal_error-priority_queue_insert) |
| `Could not lock session directory` | Stale rTorrent lock | [Stale lock](#rtorrent-crash-loops-could-not-lock-session-directory--held-by-) |
| `Torrent URL resolves to a blocked internal address` | SSRF guard blocked an indexer link | [SSRF](#auto-downloads-silently-do-nothing--resolves-to-a-blocked-internal-address) |
| `never registered within 6s` | Magnet confirm-window false failure | [Magnets](#a-magnet-is-marked-failed-but-actually-downloads-fine) |
| `Interrupted by a service restart` | A job was orphaned by a restart (this is the *fix* working) | [Jobs](#jobs-are-stuck-running-forever) |

### The audit trail is a diagnostic tool

Do not overlook it. Destructive and security-relevant actions are recorded with
the actor, action, object, result, IP and user agent — and the trail now *names*
the media a row targeted rather than showing an opaque id. When you are asking
"what changed?", `GET /api/audit` (with the `audit.view` permission) is often
faster than the logs. See [Audit](/modules/audit).

---

## Tips

- **Diagnose before you fix.** Half the entries on this page have a symptom that
  looks like something else entirely: a "failed" magnet that is downloading, a
  "successful" delete that did nothing, a scan that is starved rather than stuck.
- **`state = active` with no lock contention means starved, not stuck.** That one
  reading collapses an entire class of "it's hanging" mysteries.
- **A green connection test does not mean the feature works.** The Prowlarr health
  check and the torrent-fetch SSRF guard are different guards with different
  rules. Test the *actual* path.
- **Load-driven bugs hide at small scale.** The rTorrent crash is invisible at 7
  torrents and constant at 750. Do not conclude "it works fine" from a small test.
- **Check `RestartCount`.** `docker inspect --format '{{.RestartCount}}'` reveals a
  container that is quietly crash-looping behind a `restart: unless-stopped`
  policy — it looks "Up" in `docker compose ps`.

## FAQ

**The engine restarts but I don't lose torrents. Is that OK?**
It is survivable, not OK. Each rTorrent crash exits cleanly, Docker restarts it,
and the saved session reloads — so nothing is lost. But transfers pause and
everything re-announces. If it is happening often, you are at the scale where you
should [move to qBittorrent](#rtorrent-restarts-constantly--internal_error-priority_queue_insert).

**Why does my "delete on complete" rule not fire on qBittorrent?**
Because qBittorrent reports completed torrents as `SEEDING` and never emits
`COMPLETED`, so a `state == 'completed'` **condition** never matches. Remove the
condition — the `torrent.completed` **trigger** is already the condition.

**Can I just add the missing database indexes myself?**
Yes, and the SQL is
[right here](#a-library-scan-freezes-at-a-percentage-and-never-completes) — but use
`CREATE INDEX CONCURRENTLY`, and never put it inside a migration. Current builds
create them for you at runtime.

**FlareSolverr is running but the indexer still fails. What now?**
Determine whether you are facing a **challenge** (FlareSolverr fixes it) or a
**ban** (it cannot). See
[the 429 entry](#an-indexer-always-returns-http-429-and-flaresolverr-cannot-fix-it).

**Is it safe to restart the backend?**
Yes, but it **interrupts in-flight jobs** — they are reconciled (failed out) at
boot rather than resumed. Re-run any scan or import that was running.

## Checklist: before you file a bug report

- [ ] `docker compose ps` — which container is actually unhealthy?
- [ ] `docker compose logs --since 30m backend` — is there a stack trace?
- [ ] `docker inspect --format '{{.RestartCount}}' <container>` — is it crash-looping?
- [ ] `/api/system/version` — what version and commit are you *actually* running?
- [ ] `/api/engines/health` — is the engine online?
- [ ] Have you searched this page for the exact error string?
- [ ] Is the failure load-dependent (works at 10 torrents, fails at 700)?

## See also

- [Operate overview](/operate/) — the map of the moving parts
- [Performance](/operate/performance) — the IMDb catalogue, indexes, scale
- [Security](/operate/security) — secrets, rotation, exposure
- [Backup & Restore](/operate/backup) — before you attempt a risky fix
- [Maintenance](/operate/maintenance) — the routine that prevents these
- [Upgrading](/install/upgrading) · [Docker Compose](/install/docker-compose) · [Reverse proxy](/install/reverse-proxy)
- [Environment reference](/reference/environment) · [API](/reference/api)
- [Engines](/modules/engines) · [Indexers](/modules/indexers) · [Missing Episodes](/modules/missing-episodes)
- [FAQ](/help/faq) · [Glossary](/help/glossary)
