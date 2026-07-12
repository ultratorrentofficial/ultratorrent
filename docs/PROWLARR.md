# Prowlarr Companion Integration

UltraTorrent can run **[Prowlarr](https://prowlarr.com/)** — an indexer manager
for Torznab/Newznab trackers — as an **optional companion container** alongside
the main stack, and link to it from the UI.

> **Prowlarr is not embedded in UltraTorrent.** It runs as a separate service
> (like the bundled rTorrent engine), behind a Compose profile that is **off by
> default**. UltraTorrent boots and runs fine without it; nothing about the
> integration activates until an operator enables the profile *and* fills in the
> connection settings.

- [What it's for](#what-its-for)
- [Enable the container](#enable-the-container)
- [Connect UltraTorrent](#connect-ultratorrent)
- [Environment, ports & volumes](#environment-ports--volumes)
- [Cloudflare-protected indexers (FlareSolverr)](#cloudflare-protected-indexers-flaresolverr)
- [Security](#security)
- [Backup & upgrade](#backup--upgrade)
- [How it fits the indexer subsystem](#how-it-fits-the-indexer-subsystem)

---

## What it's for

Prowlarr aggregates hundreds of public and private tracker definitions and
exposes each as a **Torznab endpoint** — the exact protocol UltraTorrent's
[Indexers subsystem](INDEXERS.md) searches. Rather than hand-managing tracker
definitions inside UltraTorrent, you can point UltraTorrent's indexers at
Prowlarr's per-indexer Torznab URLs and let Prowlarr handle definitions,
rate-limiting, and re-authentication.

The UltraTorrent-side integration is deliberately **link-only**: it stores the
connection, verifies health, and offers an "Open Prowlarr" shortcut. It does
**not** proxy arbitrary Prowlarr endpoints or auto-configure indexers.

## Enable the container

Prowlarr lives behind the `prowlarr` Compose profile:

```bash
# Bring up (or add to) the stack with the Prowlarr companion
docker compose --profile prowlarr up -d

# Combine with other optional profiles as needed
docker compose --profile rtorrent --profile prowlarr up -d --build
```

Then open Prowlarr at `http://<host>:9696` (or your `PROWLARR_PORT`), complete
its first-run wizard, and add the indexers you want.

To get the **API key**: in Prowlarr, go to **Settings → General → Security → API
Key**. Copy it — you'll paste it into UltraTorrent.

## Connect UltraTorrent

In UltraTorrent, go to **Settings → Integrations → Prowlarr** (requires the
`integrations.prowlarr.view` permission):

1. Toggle **Enable Prowlarr integration** on.
2. **Internal URL** — how the backend reaches Prowlarr. On the bundled stack this
   is `http://prowlarr:9696` (the service name on the internal Docker network).
3. **Public URL** — the URL your browser uses for the **Open Prowlarr** link,
   e.g. `http://localhost:9696` or your reverse-proxied hostname.
4. **API key** — paste the key from Prowlarr. It is **encrypted at rest** and
   never shown again (the field displays `••••••••`; leave it blank on later
   edits to keep the stored key).
5. **Save**, then **Test connection** — a green *Connected* badge shows the
   Prowlarr version and configured-indexer count.

Once enabled with a public URL, a **Prowlarr** shortcut appears in the sidebar
under **RSS & Acquisition** (for users with `integrations.prowlarr.open`), opening
Prowlarr in a new tab.

> **Required for auto-downloads: `SSRF_ALLOW_HOSTS`.** A green *Connected* badge
> only proves UltraTorrent can reach Prowlarr's **API** — it does **not** mean
> grabs will download. When an RSS rule / Smart Download / missing-episode sweep
> grabs a release, the backend fetches Prowlarr's `.torrent` proxy link, which
> resolves to a **private Docker/LAN IP**. The SSRF guard blocks private-IP
> fetches unless the host is allow-listed, so without this the grab fails with
> *"Torrent URL resolves to a blocked internal address"* and **auto-downloads
> silently do nothing**. The bundled stack **defaults `SSRF_ALLOW_HOSTS=prowlarr`**
> (in `docker-compose.yml`), so this works out of the box. If you override the
> variable or run Prowlarr under a different host/IP, list it — keeping `prowlarr`
> if you use the bundled one, e.g. `SSRF_ALLOW_HOSTS=prowlarr,indexer.lan`. See
> [DOCKER.md → SSRF & self-hosted indexers](DOCKER.md#ssrf--self-hosted-indexers).

## Environment, ports & volumes

Configured in `.env` (see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PROWLARR_PORT` | `9696` | Host port the Prowlarr web UI is published on |
| `PROWLARR_BASE_URL` | `http://prowlarr:9696` | Internal URL default (backend → Prowlarr) |
| `PROWLARR_PUBLIC_URL` | `http://localhost:9696` | Public URL default (browser → Prowlarr) |
| `PROWLARR_ENABLED` | `false` | Documentation-only marker — **nothing reads it**; the real toggle is the one in UltraTorrent settings |
| `PUID` / `PGID` | `1000` | User/group Prowlarr runs as (shared with the bundled rTorrent) |
| `TZ` | `Etc/UTC` | Timezone for the companion container |

`PROWLARR_BASE_URL`/`PROWLARR_PUBLIC_URL` only seed the **defaults** shown in the
settings form; the authoritative values are whatever you save in the UI.

| Item | Value |
|------|-------|
| Image | `lscr.io/linuxserver/prowlarr:latest` |
| Web UI port | `${PROWLARR_PORT:-9696}` → container `9696` |
| Volume | `prowlarr_config` → `/config` (Prowlarr's database + settings) |
| Network | `internal` (shared with backend/frontend/rtorrent) |
| Restart policy | `unless-stopped` |

## Cloudflare-protected indexers (FlareSolverr)

Some trackers (e.g. **EZTV** / `eztvx.to`) sit behind **Cloudflare's anti-bot
challenge**. Prowlarr can't solve that on its own, so testing such an indexer
fails with *"blocked by Cloudflare Protection."* The fix is the standard *arr
helper, **FlareSolverr** — a headless-browser proxy that solves the challenge and
returns the cookies to Prowlarr.

It ships as another **optional companion**, behind the `flaresolverr` profile
(a backend helper like rTorrent — **internal-network only, no host port**):

```bash
docker compose --profile prowlarr --profile flaresolverr up -d
```

| Item | Value |
|------|-------|
| Image | `ghcr.io/flaresolverr/flaresolverr:latest` |
| Address (from Prowlarr) | `http://flaresolverr:8191` (internal network) |
| Env | `FLARESOLVERR_LOG_LEVEL` (default `info`), `TZ` |
| State | none (stateless — no volume) |

Then wire it up **in Prowlarr**:

1. **Settings → Indexers → + (Add Indexer Proxy) → FlareSolverr.**
2. **Host**: `http://flaresolverr:8191`. Give it a **Tag** (e.g. `cloudflare`). Save.
3. Open the Cloudflare-protected indexer (e.g. EZTV) and add the **same tag** to
   it. Prowlarr now routes that indexer's requests through FlareSolverr; re-test
   and it should pass.

> **Caveat:** Cloudflare periodically tightens its challenges and FlareSolverr can
> lag behind — it usually works for EZTV but isn't guaranteed. If it can't solve
> the challenge, try a different mirror for that indexer in Prowlarr, or rely on
> your other indexers. FlareSolverr runs a headless Chromium, so it uses more RAM
> (~200–400 MB) and gets a 256 MB `/dev/shm` in the Compose file to avoid crashes.

## Security

- The Prowlarr **API key is AES-256-GCM encrypted at rest** (via `SecretCipher`),
  **redacted** (`••••••••`) in every API response, and **never logged** — the
  outbound request carries it in an `X-Api-Key` header, and UltraTorrent never
  logs the URL or key.
- Every integration route is **RBAC-gated** (`integrations.prowlarr.{view,manage,
  test,open}`).
- **URL validation + SSRF hardening**: saved URLs must be `http`/`https` and may
  not embed credentials. Health checks reject cloud instance-metadata addresses
  (e.g. `169.254.169.254`), refuse redirects, use a short timeout, and cap the
  response size. Private/Docker hosts (`prowlarr:9696`) are intentionally allowed
  — that is the intended target.
- **Torrent fetches are a separate, stricter guard** (`common/ssrf.ts`): the
  connection **health check** trusts private hosts, but actually **downloading**
  a grabbed `.torrent` blocks private/internal addresses unless the host is in
  **`SSRF_ALLOW_HOSTS`** (default `prowlarr`). Scheme allow-list, redirect
  refusal, and the 20 MB body cap still apply to allow-listed hosts. This is why
  a passing connection test can still coexist with failing auto-downloads — see
  the callout under [Connect UltraTorrent](#connect-ultratorrent).
- UltraTorrent **does not proxy arbitrary Prowlarr endpoints** and **does not
  auto-configure indexers** — those are explicit operator actions in Prowlarr.
- **Do not expose Prowlarr publicly** unless you deliberately map/route its port;
  by default it is reachable on the host at `PROWLARR_PORT` and over the internal
  network.
- **FlareSolverr is internal-only** (no published host port) — only Prowlarr on
  the internal network reaches it. It executes remote pages in a headless browser
  to defeat bot checks, so keep it off the host/LAN and don't point it at
  untrusted URLs.
- Settings views/updates, API-key changes, connection tests, and opens are
  **audited**.

## Backup & upgrade

- **Backup**: the `prowlarr_config` volume holds Prowlarr's entire state
  (database, indexer definitions, API key). Back it up like any named volume:
  `docker run --rm -v ultratorrent_prowlarr_config:/c -v "$PWD":/b alpine tar czf /b/prowlarr_config.tgz -C /c .`
- **Upgrade**: `lscr.io/linuxserver/prowlarr:latest` tracks upstream. Pull and
  recreate: `docker compose --profile prowlarr pull prowlarr && docker compose --profile prowlarr up -d prowlarr`.
  The `/config` volume persists across upgrades. UltraTorrent's stored API key is
  unaffected unless you regenerate it in Prowlarr (then update it in the UI).

## How it fits the indexer subsystem

Prowlarr and UltraTorrent's own [Indexers](INDEXERS.md) are complementary:

- **Prowlarr** = an external *manager* of tracker definitions, exposing Torznab
  endpoints.
- **UltraTorrent Indexers** = the internal client that *searches* Torznab/Newznab
  endpoints (which may be Prowlarr's per-indexer URLs) and feeds the
  Missing-Episode auto-acquire bridge.

So the typical flow is: run Prowlarr → add trackers there → copy each indexer's
Torznab URL + Prowlarr API key into UltraTorrent's **Indexers** page → let the
acquisition pipeline search and grab. The **Settings → Integrations → Prowlarr**
panel documented here is the *link* to Prowlarr itself (health + shortcut), not
the per-indexer search configuration.
