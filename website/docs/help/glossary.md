---
id: glossary
title: Glossary
sidebar_position: 2
description: Every term used in UltraTorrent and BitTorrent — seeding, ratio, magnet, DHT, indexer, tracker, Torznab, FlareSolverr, hardlink, tconst, RBAC, SCGI, pg_trgm and more.
keywords:
  - glossary
  - terminology
  - definitions
  - what is
  - jargon
  - seeding
  - ratio
  - magnet
  - DHT
  - PEX
  - indexer
  - tracker
  - Torznab
  - Newznab
  - FlareSolverr
  - hardlink
  - tconst
  - IMDb
  - RBAC
  - TOTP
  - SCGI
  - XML-RPC
  - info-hash
  - pg_trgm
  - scene release
---

# Glossary

Every term you will meet in UltraTorrent, in plain language. BitTorrent has a lot
of jargon and much of it is used loosely elsewhere — the definitions here are the
ones this documentation means.

## BitTorrent fundamentals

**Announce**
The act of a client telling a tracker "I am here, and this is what I have". Done
periodically. Notably, rTorrent's 0.9.8 crash bug fires **during announce
scheduling** — which is why announce behaviour appears in operational
documentation at all.

**BitTorrent**
The peer-to-peer file-sharing protocol UltraTorrent manages. Files are split into
pieces; peers exchange pieces directly with each other rather than all pulling from
one server.

**Client / Engine**
The program that actually speaks BitTorrent — **rTorrent** or **qBittorrent** in
UltraTorrent's case. UltraTorrent is *not* a client; it is a management layer **in
front of** one. See *Engine seam*.

**DHT (Distributed Hash Table)**
A decentralised way to find peers **without a tracker**. It is why a magnet link
can work at all. In UltraTorrent's bundled rTorrent, **DHT is off by default** —
that build can crash on a DHT `internal_error`. Trackers and PEX still find peers.
Enable with `RT_DHT=on` if you accept the risk.

**Info-hash (btih)**
The **unique fingerprint of a torrent** — a hash of its metadata. Two torrents with
the same info-hash are the same torrent, regardless of what the file or the feed
called it. UltraTorrent deduplicates auto-downloads **by info-hash**, which is why
the same release under a rotated GUID, a re-post, or a second feed is never grabbed
twice.

**Leech / Leecher**
A peer that is downloading and does not yet have the complete file. Not pejorative —
everyone starts as a leecher.

**Magnet link**
A link that identifies a torrent by its **info-hash** rather than containing the
torrent metadata. The client must **fetch the metadata from DHT or peers** before it
can start.

:::info Why magnets are operationally different from `.torrent` files
A `.torrent` file already **contains** the metadata, so the engine registers it
almost instantly. A magnet does not — the metadata has to be found first, which in
production took a **median of ~53 seconds**.

This distinction caused a real bug: a ~6-second "did it register?" confirmation
window was fine for a `.torrent` file and far too short for a magnet, producing a
flood of false failures — **256 of 257 "failed" magnets had actually downloaded
fine**. Magnets are now treated as *accepted/pending* rather than failed.
:::

**Metadata (torrent metadata)**
The description of what a torrent contains — file names, sizes, piece hashes. Present
in a `.torrent` file; must be fetched from the swarm for a magnet.

**`metaDL`**
An engine state meaning *"fetching torrent metadata"* (a magnet that has not resolved
yet). Operationally critical: **a torrent in `metaDL` occupies an active-download
slot**. A **0-seeder magnet can never leave `metaDL`** — and will hold that slot
indefinitely. See *Parking queue*.

**Peer**
Any other client in the swarm — seed or leecher.

**PEX (Peer Exchange)**
Peers telling each other about other peers. Works alongside trackers and DHT. Still
active in UltraTorrent's bundled rTorrent even with DHT and UDP trackers disabled,
which is why peer discovery still works.

**Piece**
A fixed-size chunk of a torrent. Downloaded and verified independently, which is what
lets you download from many peers at once.

**Ratio**
Uploaded ÷ downloaded. Private trackers usually require you to maintain a minimum
ratio. A ratio of `1.0` means you have given back exactly what you took.

**Recheck**
Re-verifying downloaded pieces against their hashes. Use it when data may be corrupt
or when you have moved files behind the engine's back.

**Scene release**
A release named to a strict convention, e.g.
`Show.Name.S01E01.1080p.WEB-DL.x264-GROUP`. UltraTorrent's parser reads title, year,
season and episode out of these names.

:::note The acronym trap
Separator normalisation turns `.` into a space (because scene releases use dots as
word separators) — which used to **shatter titles whose dots are part of the name**:
`L.A.'s Finest` became `L A 's Finest`, and `Chicago P.D.` became `Chicago P D`.
Fixed: a run of single-letter-plus-dot is now recognised as an acronym and preserved,
while `A.Quiet.Place` still correctly parses to `A Quiet Place`.
:::

**Seed / Seeding / Seeder**
A peer that has the **complete** file and is uploading it. **Seeders are the single
most important health signal for a torrent**: a torrent with **zero seeders will
never complete**, no matter how long you wait.

**Session**
The engine's own record of which torrents it has loaded. For the bundled rTorrent it
lives at `/downloads/.session` — **inside the downloads volume, not in Postgres**.
This is why restoring only the database gives you your rules and libraries but an
**empty engine**.

**Stalled (`stalledDL`)**
Downloading, but no data is moving — usually no peers. Like `metaDL`, a stalled
torrent **still holds an active-download slot**.

**Swarm**
All peers sharing a given torrent — seeds and leechers together.

**Torrent file (`.torrent`)**
A file **containing** the torrent's metadata. Contrast with a *magnet link*, which
contains only the info-hash.

**Tracker**
A server that coordinates a swarm: clients announce to it, and it returns a list of
peers. A **public** tracker is open; a **private** tracker requires an account and
usually enforces a ratio.

**UDP tracker**
A tracker reached over UDP rather than HTTP. **Disabled by default** in UltraTorrent's
bundled rTorrent (`trackers.use_udp.set = no`) because it triggers a secondary crash
variant. HTTP/HTTPS trackers still work.

---

## Indexers and search

**Cloudflare challenge**
An anti-bot check some trackers sit behind. Prowlarr cannot solve it alone — this is
what **FlareSolverr** is for.

**FlareSolverr**
A headless-browser proxy that **solves Cloudflare anti-bot challenges** and hands the
resulting cookies back to Prowlarr. Runs as an optional, **internal-network-only**
companion at `http://flaresolverr:8191`.

:::warning FlareSolverr solves challenges. It cannot solve a *ban*.
If your host's egress IP has been **banned** by a site, there is no challenge to
solve — FlareSolverr will simply report that the IP is banned. No amount of retry
tuning, rate limiting or mirror-hopping fixes an IP-level ban. The only fixes are a
**clean egress IP** or **dropping the indexer**.
:::

**Indexer**
A **searchable catalogue of torrents** — a site or service you query for releases.
Distinct from a *tracker*: an indexer helps you **find** a torrent; a tracker helps
you **download** it. Many sites are both.

**`minSeeders`**
A per-indexer filter that rejects releases with fewer than N seeders.

:::danger The most consequential setting in this glossary
**The filter only applies when the column is actually set.** An indexer with no
`minSeeders` will happily hand you 0-seeder releases — which can never download, yet
**still consume active-download slots**. In production this took an engine holding
**1,137 torrents to literally zero bytes per second**. Set `minSeeders` on **every**
indexer.
:::

**Newznab**
The Usenet equivalent of Torznab. The same API shape.

**Prowlarr**
An **indexer manager**: it aggregates hundreds of tracker definitions and exposes each
as a **Torznab** endpoint, handling definitions, rate-limiting and re-authentication for
you. In UltraTorrent it is an **optional companion container** — the integration is
deliberately **link-only** (store the connection, verify health, offer an "Open
Prowlarr" shortcut). It does **not** proxy arbitrary Prowlarr endpoints.

**Torznab**
The **standard API protocol** for querying a torrent indexer — the protocol
UltraTorrent's indexer subsystem speaks. Prowlarr exposes every indexer it manages as a
Torznab endpoint.

---

## Media and metadata

**Artwork**
Posters, fanart, logos and other images attached to a media item.

**Hardlink**
A second directory entry pointing at the **same data on disk**. Copying costs disk
space; hardlinking costs (almost) nothing. This lets a file exist in both your torrent
directory (so you keep seeding) **and** your organised library (so your media server
sees it) **without storing it twice**. Hardlinks only work **within the same
filesystem**.

**IMDb dataset**
Downloadable data files IMDb publishes. UltraTorrent's IMDb provider works from these
(and/or a licensed IMDb API). **It does not scrape IMDb web pages — there is no code
path that fetches or parses imdb.com HTML.**

**Library**
A configured directory tree that UltraTorrent scans and manages — e.g. your Movies
folder or your TV folder.

**Media item**
A single row in UltraTorrent's library: a movie, or an episode.

**Media server**
Plex, Jellyfin, Emby or Kodi. UltraTorrent can trigger a **library refresh** on any of
them after organising a download.

**NFO**
A Kodi-style XML sidecar file describing a media item. Media servers read them.

**Sidecar**
A file that sits **next to** a media file and describes it — an `.nfo`, a subtitle,
a poster.

**tconst**
**IMDb's unique identifier for a title** — the `tt` number, e.g. `tt14688458`.

:::danger The single most common cause of "this show never finds episodes"
Everything downstream keys off the tconst, and there are four distinct ways it goes
wrong:

1. **It's an episode's tconst, not the series'.** *Silo* pinned to `tt16091606` (an
   episode) instead of `tt14688458` (the series). The stored id then yields **zero
   catalogue episodes**, so the show scans to 0/0/0 **forever**.
2. **Accents.** `90 Day Fiancé` vs `90 Day Fiance` — accents were *stripped* rather
   than *folded*, so the keys never matched.
3. **Punctuation.** `FBI: Most Wanted` vs `FBI Most Wanted`.
4. **No tconst at all** — e.g. a show identified against TVDB.

All four now **self-heal**.
:::

**TMDB / TVDB**
The Movie Database / The TV Database — alternative metadata providers. A show
identified against TVDB carries **no tconst**, which is failure mode 4 above.

---

## UltraTorrent architecture

**Audit log**
The record of security-relevant and destructive actions: actor, action, object,
result, IP address and user agent. Now **names the media** a row targeted rather than
showing an opaque id. Queryable with the `audit.view` permission.

**Automation rule**
An event-driven **condition/action** rule. A trigger fires, conditions are checked,
actions run.

**Engine seam**
The `TorrentEngineProvider` interface — the **single contract every torrent engine
implements**. Adding a new engine means implementing this interface; **no UI or
business-logic changes are needed**.

**Idempotency ledger**
The mechanism that ensures an automation rule runs **at most once per torrent**, no
matter how often the poll loop evaluates it. Crucially, a **failed** run is *not*
recorded as done — so a rule blocked by a transient error retries next cycle rather
than being silently skipped forever.

**Parking queue**
A background service that solves **head-of-line blocking by dead torrents**. Every 5
minutes it **pauses** torrents that are downloading, below `minSeeders`, with nobody
connected and no bytes moving. **A paused torrent holds no slot**, so the engine
promotes a queued torrent into the freed slot.

It also solves the obvious trap: **a paused torrent never announces, so its seeder
count can never refresh** — parking would be a one-way trip. So each tick it
**force-starts** a batch of parked torrents, reads the result next tick, and releases
any that found seeders. Persistently dead ones back off exponentially. It never
touches a `QUEUED` torrent (costs no slot) or a `PAUSED` one (a human paused that
deliberately). **Ships disabled by default.**

**Provider**
UltraTorrent's **primary extensibility mechanism** — an interface in the domain layer
that isolates an external service (an engine, a metadata source, a media server, a
notifier) from the business logic that uses it. The rule is explicit: new integrations
are added as **new providers**, never by modifying core modules.

**Release identity**
The parsed logical identity of a release — `movie:<title>:<year>` or
`ep:<title>:<season>:<episode>` — used to hold **only one release per movie/episode**
and to *upgrade* when a strictly better one appears.

**RSS rule**
An include/exclude rule with a **ranked preference list**, applied to an RSS feed to
decide what to grab. See *Smart Match Builder*.

**Smart Match Builder**
The ranked match-preference engine: it grabs the **best available** release, **upgrades**
to a strictly higher-priority one when it later appears (removing the superseded
torrent and its data), and skips equal-or-lower releases.

**Watchlist**
The list of shows UltraTorrent monitors for **missing episodes**.

---

## Security

**AES-256-GCM**
The authenticated encryption used for secrets **at rest** — TOTP secrets, indexer API
keys, the Prowlarr key, engine passwords. Keyed from `ENCRYPTION_KEY`.

**Argon2id**
The **memory-hard** password-hashing algorithm UltraTorrent uses. Resistant to GPU/ASIC
cracking.

**`ENCRYPTION_KEY`**
The AES-256-GCM key for everything encrypted at rest.

:::danger It is not in your database backup
`ENCRYPTION_KEY` lives in `.env`. A Postgres dump **without** it restores your
encrypted columns as **undecryptable ciphertext** — you would get your users and
libraries back, and no working 2FA or API keys. **Back up `.env` separately.**
Rotating this key **invalidates every TOTP secret and API key**.
:::

**JWT (JSON Web Token)**
The signed access token proving who you are. Default TTL **15 minutes**.

**RBAC (Role-Based Access Control)**
The **only** access-control mechanism in UltraTorrent — there is no licensing, edition,
or feature gating. Every protected route declares the permission(s) it needs; a guard
verifies the principal holds **all** of them.

**Recovery code**
A single-use code that substitutes for a TOTP code when you have lost your
authenticator. You get **10**, shown **once**, stored only as hashes, and **consumed**
on use.

**Refresh token**
A long-lived opaque token used to obtain new access tokens. Stored **only as a
SHA-256 hash**. **Rotating**: each use revokes the old and issues a new one.
**Reuse-detecting**: presenting an already-revoked token — the hallmark of theft —
**burns the entire token family**.

**Roles**

| Role | Summary |
|------|---------|
| `SUPER_ADMIN` | All permissions; bypasses granular checks. The **only** role that can grant `SUPER_ADMIN`. |
| `ADMINISTRATOR` | All permissions **except** `system.manage`. |
| `POWER_USER` | All torrent actions, RSS, automation, and ⚠️ **all `files.*` — including delete, bulk and cleanup**. |
| `USER` | View/add torrents, basic state changes, **read-only** files. |
| `READ_ONLY` | View only. |

**SSRF (Server-Side Request Forgery)**
An attack where you trick a server into fetching an internal URL. UltraTorrent's SSRF
guard blocks torrent-URL fetches that resolve to private/loopback/link-local/CGNAT or
**cloud-metadata** addresses, allows only `http(s)`, refuses redirects, and caps the
body at 20 MB.

**`SSRF_ALLOW_HOSTS`**
The allow-list that lifts *only* the private-address block, for *only* the hosts you
name. **Required** for any self-hosted indexer on a private IP — including the bundled
Prowlarr (hence its default value, `prowlarr`).

:::note The trap worth memorising
Without it, grabs fail with *"Torrent URL resolves to a blocked internal address"* —
**while the Prowlarr connection test still passes.** The health check trusts private
hosts; the torrent *fetch* is a separate, stricter guard.
:::

**TOTP (Time-based One-Time Password)**
The 6-digit rotating code from an authenticator app. RFC 6238. 30-second step, ±1 step
tolerance for clock skew.

---

## Infrastructure

**BullMQ**
The Redis-backed job/queue library.

**`CREATE INDEX CONCURRENTLY`**
Builds a Postgres index **without holding a write lock** — so the app stays up.

:::warning It cannot run inside a transaction
Which means it can **never** live in a Prisma migration. Putting a large plain
`CREATE INDEX` in a migration instead caused a **real outage**: the build was killed
mid-flight, Prisma marked the migration **failed (P3009)**, and the backend refused to
boot on **two hosts at once**. Big indexes must be built at **runtime**.
:::

**GIN index**
A Postgres index type suited to composite values — and, with `gin_trgm_ops`, to
**text-similarity search**. This is what makes `ILIKE` fast.

**`ILIKE`**
Case-insensitive `LIKE` in SQL. Prisma renders `mode: 'insensitive'` as `ILIKE`.

:::danger `ILIKE` cannot use a btree index
This is the root cause of the worst performance incident in UltraTorrent's history. On
the 8.9M-row IMDb catalogue, every case-insensitive title lookup became a **full table
scan at 47.8 seconds**, which starved Postgres until library scans **never completed**.
With **pg_trgm GIN** indexes: **180 ms** — a **~265× speedup**, with no application code
change.
:::

**INVALID index**
An index left broken by an **interrupted** `CREATE INDEX CONCURRENTLY`. The planner
**ignores** it — but its **name exists**, so `CREATE INDEX ... IF NOT EXISTS` sees it
and **skips the rebuild forever**. It must be **dropped and rebuilt**. Check with
`indisvalid` in `pg_index`.

**P1000 / P1001 / P2025 / P3009**
Prisma error codes you will actually meet:

| Code | Meaning | Usual cause |
|------|---------|-------------|
| **P1000** | Authentication failed | The `postgres_data` volume was **first initialised with a different password**. Postgres only applies `POSTGRES_PASSWORD` on **first init** — later `.env` changes have no effect on an existing volume. |
| **P1001** | Can't reach the database | `DATABASE_URL` points at the Docker service name `postgres` on a **manual** install. Use `localhost`. |
| **P2025** | Record to update not found | A row vanished mid-operation (e.g. a concurrent re-scan deleted it). |
| **P3009** | Failed migration blocks boot | An interrupted migration. Recover with `prisma migrate resolve --applied <name>`. |

**`pg_stat_activity`**
The Postgres view showing what every connection is doing. **The most important
diagnostic in this documentation.**

:::tip Starved vs stuck — the reading that solves an entire class of mystery
- **`state = active`**, long duration, **no lock contention**, connections **nowhere
  near** the limit → **starved, not stuck**. The database is *working*; one query is so
  expensive it is eating the server. Look for a **missing index**.
- **`wait_event_type = Lock`** → genuine contention.

In the real incident the evidence was: long `active` queries, **zero** lock contention,
and only **13 of 100** connections in use.
:::

**`pg_trgm`**
The Postgres **trigram** extension. Breaks text into three-character sequences so that
`LIKE`/`ILIKE` can be **index-backed** via a GIN index. The fix for the IMDb catalogue.

**Prisma**
The ORM/migration tool between the backend and PostgreSQL.

**SCGI**
The protocol UltraTorrent's backend uses to talk to **rTorrent** (XML-RPC over SCGI).

:::danger The SCGI control surface is unauthenticated
It gives **full control of the client**, including the ability to **execute commands**
(rTorrent runs `rm` during delete-with-data). **Never expose it to the network.** The
shipped Compose file correctly keeps it internal-only (`expose`, not `ports`).
:::

**Trigram**
A three-character sequence. `Silo` → `sil`, `ilo`. Comparing trigram sets is how
`pg_trgm` measures text similarity — and how an index can serve `ILIKE`.

**XML-RPC**
The RPC format rTorrent speaks, carried over SCGI.

---

## See also

- [FAQ](/help/faq) — the questions behind these terms
- [Troubleshooting](/operate/troubleshooting) — the incidents these terms come from
- [Concepts](/learn/concepts) — the conceptual introduction
- [Performance](/operate/performance) · [Security](/operate/security)
- [Permissions](/reference/permissions) · [Environment](/reference/environment)
