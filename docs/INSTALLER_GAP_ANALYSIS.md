# UltraTorrent Installer — Phase 1 Audit & Gap Analysis

**Status:** Phase 1 complete. Written against the tree at `5ef38154` (v0.85.9).
**Authoritative source:** [ARCHITECTURE.md](ARCHITECTURE.md) and the code it
describes. Everything below was verified by reading the implementation and the
Compose stack, not inferred from prose.

The installer is a **deployment client**. It automates what an administrator
does by hand today; it must not become a second definition of how UltraTorrent
is deployed. Where the repository already decides something — service topology,
migration timing, secret rules, the SSRF default — the installer's job is to
satisfy that decision, not to restate it.

---

## 1. What exists today

### 1.1 The Compose stack (verified)

| Service | Image / build | Profile | Host ports | Notes |
|---|---|---|---|---|
| `postgres` | `postgres:17-alpine` | — (always) | none | `pg_isready` healthcheck |
| `redis` | `redis:7-alpine` | — (always) | none | `--appendonly yes`, `redis-cli ping` healthcheck |
| `backend` | built, `apps/backend/Dockerfile` | — (always) | **none** (`expose: 4000`) | `depends_on` both healthy |
| `frontend` | built, `apps/frontend/Dockerfile` | — (always) | `${FRONTEND_PORT:-8080}:8080` | nginx-unprivileged; proxies `/api/` and `/ws/` |
| `rtorrent` | built, `deploy/rtorrent` | `rtorrent` | none (`expose: 5000`) | SCGI/TCP; `cap_add: SETUID,SETGID`; SCGI-listening healthcheck |
| `qbittorrent` | `lscr.io/linuxserver/qbittorrent` | `qbittorrent` | `${QBITTORRENT_PORT:-8081}:8080` | first-run temp password in logs |
| `prowlarr` | `lscr.io/linuxserver/prowlarr` | `prowlarr` | `${PROWLARR_PORT:-9696}:9696` | |
| `flaresolverr` | `ghcr.io/flaresolverr/flaresolverr` | `flaresolverr` | none (`expose: 8191`) | `shm_size: 256m` |
| `proxy` | `caddy:2-alpine` | `proxy` | `80:80`, `443:443` | `deploy/Caddyfile` |

Volumes: `postgres_data`, `redis_data`, `downloads`, `caddy_data`,
`prowlarr_config`, `qbittorrent_config`. One network: `internal` (bridge).

**Five profiles exist**, not four: `rtorrent`, `qbittorrent`, `prowlarr`,
`flaresolverr`, **`proxy`**. The brief assumed no reverse proxy ships with the
repository; one does, and it is a supported, documented profile.

### 1.2 What the platform already decides

These are settled and the installer must conform rather than re-implement:

- **Migrations run themselves.** The backend image's `CMD` is
  `sh -c "npx prisma migrate deploy && exec node dist/main.js"`. The installer
  must not run migrations; it must wait for readiness.
- **Seeding is a separate one-time step**, deliberately:
  `docker compose exec backend npx prisma db seed`. `prisma/seed.ts` is
  `upsert`-based throughout, so re-running is safe.
- **Secrets are validated at boot** by `findInsecureSecrets()`
  (`config/configuration.ts`) — each of `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY` must be set, not a known default, and
  **≥32 characters**; `ENCRYPTION_KEY` must differ from `JWT_ACCESS_SECRET`, and
  `JWT_REFRESH_SECRET` must differ from `JWT_ACCESS_SECRET`. The gate fires
  unless `NODE_ENV=development` exactly.
- **Compose fails early** on missing `POSTGRES_PASSWORD`, `ADMIN_PASSWORD` and
  the three secrets, via `${VAR:?message}`.
- **`DATABASE_URL` is derived**, not supplied: Compose builds it from
  `POSTGRES_USER/PASSWORD/DB`. The password must be **alphanumeric** — a
  URL-special character silently corrupts the derived URL.
- **`SSRF_ALLOW_HOSTS` defaults to `prowlarr`** in `docker-compose.yml`, which is
  what makes the bundled indexer's private-IP `.torrent` links work.
- **Health probes exist**: `/api/system/live`, `/api/system/ready` (public), and
  `/api/system/version` (public, reports `gitSha`/`gitTag`/`buildTime`).
- **Builds stamp provenance** through `ops/scripts/docker-build.sh`, which sets
  `GIT_SHA`/`GIT_TAG`/`BUILD_TIME` build args and writes `build-info.json`.

### 1.3 Post-install configuration surfaces (API, not SQL)

Everything the installer might configure after boot has an authenticated route:

| Object | Route | Permission |
|---|---|---|
| Torrent engine | `POST /api/engines`, `POST /api/engines/test` | `engines.manage` |
| Storage profile | `POST /api/media/intake/profiles` | `media_intake.manage` |
| Library | `POST /api/media/libraries` | `media_manager.*` |

`CreateEngineDto` is `{ name, kind, config, isDefault?, … }` where `kind` is
constrained to `ENGINE_KINDS`. This is the supported path; the installer must
never write application tables.

---

## 2. What an administrator does manually today

Reconstructed from `docs/DOCKER.md` and `docs/INSTALL.md`:

1. Install Docker and the Compose plugin (out of scope of every current doc).
2. `cp .env.example .env`.
3. Invent and paste **five** secrets by hand: `POSTGRES_PASSWORD` (alphanumeric,
   a constraint stated only in a comment), `ADMIN_PASSWORD`,
   `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ENCRYPTION_KEY`.
4. Decide `FRONTEND_PORT`, and `QBITTORRENT_PORT`/`PROWLARR_PORT` if used.
5. Decide which profiles to pass on **every** `docker compose` invocation.
6. `docker compose up -d --build`.
7. `docker compose exec backend npx prisma db seed` — **and know that this step
   exists**, because nothing prompts for it and the UI is unusable without it.
8. For qBittorrent: read the temp password out of container logs, open the Web
   UI, set credentials, and — if "Test connection" 401s — turn off host-header
   validation, which is discoverable only from the docs.
9. Register the engine in the UI with the internal service name and port.
10. For Prowlarr: link it in Settings, paste the API key.
11. For FlareSolverr: add an indexer proxy inside Prowlarr and tag indexers.
12. For host-path media: **write an untracked `docker-compose.override.yml`**,
    because the stack ships a named `downloads` volume and no documented
    bind-mount path.

Steps 3, 7, 8 and 12 are where installations fail. Nothing validates them.

---

## 3. Gaps

### G1. No installer of any kind *(the task)*

There is no `install.sh`, no installer directory, and no bootstrap script.
`ops/scripts/` holds build, release and diagnostic tooling only.

### G2. Docker itself is out of scope everywhere

No document installs Docker or the Compose plugin. Every install path begins
"assuming Docker is installed". This is the single largest first-run cliff.

### G3. Seeding is a required step that nothing enforces

Migrations self-apply; seeding does not. A stack that came up perfectly has **no
users** until step 7. The installer must run it and verify an admin exists —
and must treat "already seeded" as success, which `upsert` already guarantees.

### G4. Host-path storage works, but only through an undocumented pattern

`downloads` is a named volume shared by backend, rtorrent and qbittorrent, and
nothing in the repository documents putting media on a host path.

**A field-proven pattern exists and is not written down.** A deployed host's
untracked override redefines the *volume* rather than each service's mount:

```yaml
volumes:
  downloads:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /srv/ultratorrent/media
```

This is the right shape and the installer should adopt it rather than invent
per-service bind mounts. Every service that mounts `downloads:/downloads` —
backend, rtorrent, qbittorrent — follows automatically, so the three cannot
drift apart, the in-container path stays `/downloads`, and `FILE_MANAGER_ROOTS`
and every engine `savePath` keep working untouched. A per-service bind mount
would have to be repeated three times and would silently diverge the first time
someone added a service.

Two caveats the same override reveals:

- **Ownership is a separate axis.** The same file pins `user: "997:997"` on the
  backend so written files belong to the media owner. The installer's
  `PUID`/`PGID` question must cover the backend as well as the engines, or
  downloads land as the wrong user.
- **The bind is created at volume-creation time.** Changing `device` later does
  not move data and does not take effect until the volume is recreated — which
  is exactly the "stranding data" case `reconfigure` must refuse rather than
  silently perform.

So G4 is *documenting and generating* a proven pattern, not designing a new one.
It should be written into `docs/DOCKER.md` regardless of the installer, since
operators hit it today with no guidance.

#### Addendum, Phase 6: the bind device must exist BEFORE `up`

Confirmed by experiment. Docker does not create a bind volume's `device` on
demand and does not complain at `docker compose config`. The container fails to
**start**, with:

    failed to mount local volume: mount /srv/media:/var/lib/docker/volumes/<proj>_downloads/_data: no such file or directory

which names an internal Docker path and gives no hint that the missing thing is a
directory on the host. Creating the directory first makes that error unreachable,
which is why storage preparation runs before anything else is written.

Two further facts, both observed on a real host rather than reasoned about:

- **`MkdirAll`'s mode is masked by the process umask.** With the usual 022 a
  directory requested as 0775 lands 0755, silently dropping the group-writable
  bit that the PUID/PGID arrangement depends on — an engine and a backend running
  as different users in a shared group can then no longer both write. The mode has
  to be re-asserted with an explicit `Chmod` after creation.
- **Ownership must be reported, never corrected.** A recursive `chown` of an
  existing media tree is slow, hard to undo, and on a NAS routinely wrong, since
  the tree is usually shared with other applications that expect their own
  ownership. The installer owns what it creates and states what it found about
  the rest, with the command spelled out for the operator to run themselves.

### G5. qBittorrent first-run credentials are manual

The LinuxServer image mints a temporary password into its logs on first start.
There is no environment variable for credentials. Options, in order of
preference, to be settled in Phase 5 with evidence:

1. Pre-seed `/config/qBittorrent/qBittorrent.conf` with a PBKDF2 password hash
   before first start — supported configuration, no scraping.
2. Read the temp password from container logs once and rotate it via the
   qBittorrent Web API.
3. Guide the user through it interactively.

Option 1 is the only one that is fully unattended; option 2 is log-scraping by
another name and the brief forbids it. **Not yet verified** — must be tested
against the pinned image before being promised.

#### RESOLVED in Phase 5, by experiment against `lscr.io/linuxserver/qbittorrent:latest` (qBittorrent 5.2.3)

**Option 1 works.** Writing `/config/qBittorrent/qBittorrent.conf` before first
start suppresses the temporary password entirely and the seeded credential is
accepted at login. The verifier is PBKDF2-HMAC-SHA512, a 16-byte random salt,
100 000 iterations and a 64-byte key, stored as
`WebUI\Password_PBKDF2="@ByteArray(<base64 salt>:<base64 key>)"`. Verified twice:
against an independent implementation, and by starting the real engine on a
config the installer generated and signing in.

Three things cost an experiment each and none is discoverable from a failure:

- **Keys take a single backslash.** A doubled one is silently ignored —
  qBittorrent reads the file, recognises nothing, and issues a temporary password
  as though it had not been configured.
- **`[LegalNotice] Accepted=true` is required.** Without it the engine refuses to
  start unattended, which in a container is a boot loop with no stated cause.
- **The config volume must be a bind, not the named volume Compose declares.**
  Nothing can write into a named volume before a container mounts it, so with the
  default there is no way to seed anything — which is precisely why the file
  documents log-scraping today.

**A live defect found on the way, unrelated to the installer.** qBittorrent
rejects any request whose `Host` header names a port other than its own WebUI
port, answering `401` to *everything*, the login page included. `docker-compose.yml`
maps `${QBITTORRENT_PORT:-8081}:8080`, so a browser sends `Host: host:8081`, the
ports disagree, and the Web UI is unreachable. Measured on the live deployment:

| Request | Result |
|---|---|
| `GET /` on published port 8081 | **401** |
| `GET /` with `Host: 127.0.0.1:8080` | 200 |

This makes the workflow the Compose file itself documents — "grab the first-run
temporary password from the container logs" and sign in — impossible to complete.
Two fixes exist. **Aligning the ports** (`WEBUI_PORT` = container port = published
port) is better, keeps the check on, and was verified working; it needs a change
to `docker-compose.yml`, and changes the internal port the backend connects to,
so it carries a migration cost for existing deployments. **Relaxing the check**
(`WebUI\HostHeaderValidation=false`) is a single line in a file the installer
already generates and needs no platform change. The installer takes the second
for now, and only when the UI is actually published on a mismatched port — the
decision is recorded in `engine.Settings` so it can be revisited if the ports are
aligned upstream. Compose's merge semantics rule out a third option: a `ports:`
list in an override **appends** rather than replaces (verified — two mappings,
both publishing the same host port), and `!override` replaces but requires
Compose ≥ 2.24, above the ≥ 2.0 the installer currently demands.

Also required either way: **host-header validation**, which 401s a connection by
service name. The installer must set `WebUI\HostHeaderValidation=false` (or
`Server domains=*`) rather than leaving the user to find it in the docs.

### G6. `SSRF_ALLOW_HOSTS` is a default the installer can break

Because `docker-compose.yml` defaults it to `prowlarr`, an installer that writes
`SSRF_ALLOW_HOSTS=` into `.env` for any reason would **silently disable
auto-downloads** through the bundled indexer. The installer must either leave it
unset (inheriting the default) or write a value that still contains `prowlarr`
whenever the `prowlarr` profile is enabled.

### G7. Profiles must be repeated on every Compose command

`--profile` is not persisted. Any later `docker compose up -d` without the flags
**stops** the profiled services. The installer must persist the selection
(installer state) and always pass it — and `docs/DOCKER.md` should say so,
because this bites operators today.

`COMPOSE_PROFILES` in the environment is the mechanism; the deployed hosts
already use it for exactly this reason.

### G8. Ports collide by design

`FRONTEND_PORT` defaults to `8080` and qBittorrent's Web UI publishes `8081`
*because* 8080 is taken. Prowlarr takes `9696`, the proxy profile takes `80` and
`443`. Pre-flight must check every host port it intends to publish.

### G9. No resource requirements exist to check against

No document states a minimum RAM/CPU/disk. The brief forbids inventing them.
Phase 3 should measure the running stack and record evidence; until then the
installer must warn, clearly labelled as a recommendation, and never refuse.

### G10. Two engines, materially different, and the difference is documented

`docs/DOCKER.md` records that bundled rTorrent is `0.9.8` with an upstream
`priority_queue_insert` crash that worsens with active torrent count (~0 crashes
at a handful, ~10/day at ~750), with no fix in the 0.9.8 lineage. qBittorrent is
described as "the sturdier alternative for large libraries". The wizard's
recommendation is therefore **evidence-backed by the repository** and should cite
it rather than asserting a preference.

---

## 4. Decision classification

**Generated automatically, never asked:**
`POSTGRES_PASSWORD` (alphanumeric, ≥32), `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, `ENCRYPTION_KEY` (each ≥32, mutually distinct),
`ADMIN_PASSWORD` (unless the user supplies one), `POSTGRES_USER`/`DB`,
`DATABASE_URL` (derived by Compose), internal hostnames and ports, the
`SSRF_ALLOW_HOSTS` value, `CORS_ORIGIN`, and the Compose profile list.

**Genuinely requires the user:**
install directory; web port; torrent engine; media/staging paths; whether to
publish qBittorrent's and Prowlarr's UIs; whether to enable Prowlarr,
FlareSolverr, the proxy profile; admin username/email; timezone; `PUID`/`PGID`
when media is owned by another user; and whether Managed Intake and initial
libraries are configured now.

**Validatable before deployment:** OS/arch/privileges, Docker and Compose
presence and version, port availability, path existence/writability/free space,
`docker compose config` validity, secret strength against `findInsecureSecrets`
rules, and profile/service coherence.

**Only after deployment:** container health, Postgres reachability from the
backend, migration completion, `/api/system/ready`, frontend HTTP, engine health
*through UltraTorrent*, Prowlarr reachability, admin login, and whether
`downloads` resolves to the intended host path inside each container.

---

## 5. Backward compatibility

The installer must not change what already works:

- `docker-compose.yml` stays canonical and **is not rewritten**. The installer
  contributes `.env` plus a generated `docker-compose.override.yml`.
- A hand-managed install (existing `.env`, existing override, existing volumes)
  must be detected and left alone. Detection needs multiple signals — installer
  state, Compose project labels, running containers, a populated `.env` — not
  directory existence.
- The manual path in `docs/INSTALL.md` and `docs/DOCKER.md` stays documented.
  The installer complements it.
- `ops/scripts/docker-build.sh` remains the only build path, so provenance
  stamping survives.
- Existing untracked overrides on deployed hosts must not be clobbered; the
  installer writes a file it owns and says so in a header.

---

## 6. Language and placement

**Go**, per the brief's reasoning, and the repository now has precedent: the
console at `clients/console/` is Go, built with `CGO_ENABLED=0`, cross-compiled
by `build.sh`, and sits outside the npm workspace globs (`packages/*`, `apps/*`).

Placement: **`clients/installer/`**, matching the console. `clients/` is already
established as "a Go program that talks to UltraTorrent but is not part of it",
and both share the same release shape. `tools/` and tooling under `ops/scripts/`
are for repository-facing scripts, which this is not — it runs on a stranger's
server.

Reusable from the console: the ANSI/width discipline in `internal/ui`, the
i18n approach (en-US/es-PR embedded via `go:embed`), and the
`build.sh`/`SHA256SUMS` release shape.

---

### G8 (Phase 7). Optional services: Prowlarr, FlareSolverr, the bundled proxy

**Prowlarr's API key can be pre-seeded, and it unlocks the rest.** Verified
against Prowlarr 2.4.0: a key written into `config.xml` before first start is
kept, accepted on `X-Api-Key` immediately, and a wrong key is rejected with 401.
That matters beyond convenience — `/api/v1/indexerproxy` is reachable with it, so
the FlareSolverr wiring Prowlarr's own documentation describes as a click path
becomes automatable in Phase 9, instead of the installer asking the operator to
copy a key out of a web UI.

**Prowlarr's Web UI must not be published by default.** There is no
authentication setting that is both safe and usable, measured rather than
assumed:

| `AuthenticationRequired` | Unauthenticated `GET /` through a published port |
|---|---|
| `DisabledForLocalAddresses` | **200 — the application** |
| `Enabled` | 302 to a login page |
| (unset) | **200 — the application** |

`DisabledForLocalAddresses` fails because every request arriving through a
published port comes from the Docker gateway, which is a private address, so
"local" means anyone who can reach the host. `Enabled` is secure but the login
page offers no way to create the first account, and Prowlarr keeps its users in
its own SQLite database — seeding one would mean writing directly into another
application's tables, which the brief forbids. Leaving it unset does not trigger
a setup wizard; the UI is simply open. So the default is `PublishProwlarrUI:
false`, changed from `true`, and publishing stays available with the consequence
stated in the generated config file.

**The bundled proxy's config is repository-tracked.** `deploy/Caddyfile` is
mounted read-only and hardcoded to `:80`, so configuring the proxy means either
editing a file that belongs to the project — forking the installation from
upstream the first time it changes, the same reason `docker-compose.yml` is never
generated — or redirecting the mount. The installer generates its own Caddyfile
and redirects the mount. Site address selection matters: a bare `:80` for an IP
or `localhost`, because no certificate authority will issue for either and Caddy
retrying a hopeless ACME challenge is a startup that never settles.

**Unpublishing a port needs Compose ≥ 2.24.** A `ports:` list in an override is
APPENDED to the base one — verified, two mappings for the same host port — so
`ports: []` does nothing. `!reset` works, but on an older Compose the tag is a
parse error and the whole stack fails to start, which is worse than the port
being published and would look like a fault in the generated file. The
requirement is therefore conditional: checked only when a plan actually keeps a
service off the host network.

## 7. Proposed delivery order

Unchanged from the brief, with two adjustments the audit justifies:

- **G5 (qBittorrent credentials) — RESOLVED in Phase 5.** Pre-seeding works;
  see the addendum under G5. Unattended engine setup is delivered, no log
  scraping, and the experiment also turned up a live defect that makes the
  engine's Web UI unreachable on its published port.
- **G4 (bind-mount storage) is a design decision, not a wiring task**, and
  should be settled in Phase 2 alongside the plan model, because the plan's
  storage shape determines the override generator.

Phase 2 begins the typed `InstallationPlan`, its validation, and `plan` /
`--dry-run`, with no system mutation.
