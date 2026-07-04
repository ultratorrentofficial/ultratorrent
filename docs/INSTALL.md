# Installation & Setup

This guide covers installing **UltraTorrent** on a **Linux PC**, a **QNAP NAS**,
or a **Synology NAS**. The container (Docker) route is recommended everywhere; a
manual from-source route is also documented for Linux.

> UltraTorrent is a self-hosted **Media Acquisition & Management Platform** — a
> single community product with one codebase, no separate editions, and no add-on
> overlay. It runs standalone; every feature is included and gated only by RBAC.

- [Choosing an install method](#choosing-an-install-method)
- [Docker install (recommended)](#docker-install-recommended)
  - [Linux PC](#linux-pc-docker)
  - [NAS installs — read this first (plain-English guide)](#nas-installs--read-this-first-plain-english-guide)
  - [QNAP NAS (Container Station)](#qnap-nas-container-station)
  - [Synology NAS (Container Manager)](#synology-nas-container-manager)
  - [After it's running (both NAS)](#after-its-running-both-nas)
- [Required environment variables](#required-environment-variables)
- [Manual install (Linux PC, from source)](#manual-install-linux-pc-from-source)
- [Connecting an rTorrent engine](#connecting-an-rtorrent-engine)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

---

## Choosing an install method

| You have… | Use |
|-----------|-----|
| A NAS (QNAP / Synology) | **Docker** — via the NAS's container app. No Node/npm needed. |
| A Linux PC, want it simple | **Docker** — one command brings up the whole stack. |
| A Linux PC, want to develop / run from source | **Manual install** (Node 20 + PostgreSQL + Redis). |

The Docker stack builds the images from source (no prebuilt images are published
yet), so the host needs Docker + a couple of GB of free RAM to build. The base
images are multi-arch (x86-64 and ARM).

---

## Docker install (recommended)

These common steps apply to every platform; platform-specific deltas follow.

**1. Get the code.**
```bash
git clone https://github.com/damirabal/ultratorrent-core.git
cd ultratorrent-core
```
No `git`? Download the repo ZIP from GitHub and extract it onto the machine.

**2. Configure `.env`.** Copy the template and set the required values (see
[Required environment variables](#required-environment-variables)):
```bash
cp .env.example .env
```
There are **no insecure defaults** — the stack refuses to start until you set
`POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, and strong, distinct `JWT_ACCESS_SECRET`
and `ENCRYPTION_KEY`. Generate each secret with `openssl rand -base64 48`, or
auto-fill all three random keys at once (then just set the two passwords):
```bash
for k in JWT_ACCESS_SECRET JWT_REFRESH_SECRET ENCRYPTION_KEY; do
  sed -i "s|^$k=.*|$k=$(openssl rand -base64 48 | tr -d '\n')|" .env
done
```

**3. Build & start** (with the bundled rTorrent engine):
```bash
docker compose --profile rtorrent up -d --build
```
**4. Seed the database** (one time — permissions, roles, admin, settings):
```bash
docker compose exec backend npx prisma db seed
```
**5. Open** `http://<host>:8080` and sign in as `admin` with your `ADMIN_PASSWORD`.
Then add the engine (see [Connecting an rTorrent engine](#connecting-an-rtorrent-engine)).

> The frontend (port **8080**) internally proxies `/api` and `/ws` to the
> backend, so **8080 is the only port published to the host**. If 8080 is
> already in use, set `FRONTEND_PORT=<free port>` in `.env`. The backend is
> **not** published to the host (nothing external needs it); add a `ports`
> mapping to `docker-compose.yml` only if you want direct API access.

### Linux PC (Docker)

Install Docker Engine + the Compose plugin, then run the common steps above.
```bash
# Debian/Ubuntu — official convenience script:
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out/in so `docker` works without sudo
```
Downloads land in a Docker-managed `downloads` volume by default. To use a real
folder instead, add a `docker-compose.override.yml` (see the NAS examples below,
substituting your own path).

### NAS installs — read this first (plain-English guide)

This part is written for people who have **never used a command line**. Take it
slowly — you only do this once, and you can copy-paste almost everything.

**What you're about to do, in plain terms.** Your NAS can run small, self-contained
programs called **containers**. UltraTorrent is a handful of containers that work
together (the website you'll use, a database that remembers your settings, and a
torrent engine that does the downloading). You'll copy UltraTorrent's files onto the
NAS, type a few commands to build and start it, then use it from your web browser
like any other website.

**What you need:**
- A QNAP or Synology NAS that supports Docker (most models from the last several years do).
- An **administrator** account on the NAS.
- About **2 GB of free memory** and 10–15 minutes (the first build is the slow part — later starts are fast).
- Your NAS's **IP address**, e.g. `192.168.1.50`. Find it in the NAS's network settings or your router's list of connected devices.

**A few words you'll run into:**

| Word | Plain meaning |
|------|---------------|
| **Docker / container** | A mini program the NAS runs in its own sealed box. |
| **Image** | The template a container is built from. "Build" makes it; "up" starts it. |
| **SSH** | Typing commands on your NAS from your own computer, over your home network. |
| **`.env` file** | A plain-text settings file where you put your passwords. |
| **Port** | A numbered "door" a program answers on. The website uses one; you choose the number. |
| **Share / volume** | Just a folder. We'll point downloads at a folder you can browse. |

#### Step A — Turn on SSH (so you can type commands on the NAS)

- **QNAP:** Control Panel → **Telnet / SSH** → tick **Allow SSH connection** → **Apply**.
- **Synology:** Control Panel → **Terminal & SNMP** → tick **Enable SSH service** → **Apply**.

#### Step B — Connect to the NAS from your computer

- **Windows:** open **Windows Terminal** or **PowerShell** (built in), then type
  `ssh admin@192.168.1.50` (use *your* NAS IP and admin username). Enter your admin
  password when asked — it stays invisible as you type, that's normal.
- **Mac / Linux:** open the **Terminal** app and run the same `ssh admin@192.168.1.50`.

The first time, it asks something like "are you sure you want to continue" — type
`yes` and press Enter. You are now "inside" the NAS: what you type runs on the NAS.

> **Synology only:** right after connecting, type `sudo -i` and enter your password
> again to get administrator rights. The line you type on will change to end in `#`.

#### Step C — Copy UltraTorrent's files onto the NAS

Move into a folder on one of your shares, then download the files into it:

```bash
cd /share/Container      # QNAP  (Synology: cd /volume1/docker)

git clone https://github.com/damirabal/ultratorrent-core.git
cd ultratorrent-core
```

> **If `git` isn't available:** on your own computer open the project's GitHub page,
> click **Code → Download ZIP**, unzip it, and copy the resulting
> `ultratorrent-core` folder onto the NAS share using the NAS's file app (QNAP
> **File Station** / Synology **File Station**) or Windows/Mac file sharing. Then
> `cd` into that folder as shown above.

#### Step D — Create your settings file (`.env`)

Copy the template, let the computer generate the long security keys for you, then
set your own two passwords:

```bash
cp .env.example .env

# Auto-fill the three long random security keys (copy-paste this whole block as-is):
for k in JWT_ACCESS_SECRET JWT_REFRESH_SECRET ENCRYPTION_KEY; do
  sed -i "s|^$k=.*|$k=$(openssl rand -base64 48 | tr -d '\n')|" .env
done
```

Now set the two passwords **you** will use. Open the file in a beginner-friendly
editor called `nano`:

```bash
nano .env
```

Use the arrow keys to move to these two lines and fill them in. For
`POSTGRES_PASSWORD` use **letters and numbers only** (no spaces or symbols):

```dotenv
POSTGRES_PASSWORD=something_simple123
ADMIN_PASSWORD=the_password_you_will_log_in_with
```

Save and close: press **Ctrl+O** then **Enter** (saves), then **Ctrl+X** (exits).

> `POSTGRES_PASSWORD` is the database's private password (you'll almost never see
> it again). `ADMIN_PASSWORD` is what **you** type to log into UltraTorrent — pick a
> good one and remember it.

#### Step E — Choose where downloads are saved (recommended)

By default, downloaded files sit in a hidden Docker area. To send them to a normal
folder you can open over the network, create a second settings file called
`docker-compose.override.yml` **in the same folder**:

```bash
nano docker-compose.override.yml
```

Paste this, and change the `device:` line to a real folder on your NAS (keep only
**one** `device:` line):

```yaml
volumes:
  downloads:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /share/Download        # QNAP example
      # device: /volume1/downloads   # Synology example
```

Save and exit (Ctrl+O, Enter, Ctrl+X). Make sure that folder actually exists —
create it in File Station first if needed.

Now follow the short platform-specific steps below.

### QNAP NAS (Container Station)

1. In the QNAP **App Center**, install **Container Station** (this is what provides
   Docker). Then do **Steps A–E** above.
2. QNAP's own admin website already uses port **8080**, so give UltraTorrent a
   different door. Edit your settings file (`nano .env`) and add/set:
   ```dotenv
   FRONTEND_PORT=18080
   ```
   You'll then open UltraTorrent at `http://<NAS-IP>:18080`.
3. Build and start everything. **The first build takes several minutes — that's
   normal; let it finish.**
   ```bash
   docker compose --profile rtorrent up -d --build
   ```
   > Older Container Station versions use `docker-compose` (with a hyphen) instead
   > of `docker compose` (with a space). If one says "command not found", try the other.
4. Set up the database — run this **once**:
   ```bash
   docker compose exec backend npx prisma db seed
   ```
5. Open `http://<NAS-IP>:18080` in your browser, then continue at
   [After it's running](#after-its-running-both-nas).

> **Prefer clicking to typing?** You can paste the contents of `docker-compose.yml`
> into **Container Station → Applications → Create**. But the SSH route above is
> more reliable for the one-time build (`--build`) and database setup steps.

### Synology NAS (Container Manager)

1. In **Package Center**, install **Container Manager** (older DSM calls it
   "Docker") — this provides Docker. Then do **Steps A–E** above (remember the
   `sudo -i` step right after connecting).
2. Synology's DSM login page uses ports **5000/5001** — that's fine, UltraTorrent
   never publishes those. But port **8080** can still clash with other DSM apps, so
   give UltraTorrent a different door. Edit `nano .env` and add/set:
   ```dotenv
   FRONTEND_PORT=18080
   ```
   You'll then open UltraTorrent at `http://<NAS-IP>:18080`.
3. Build and start (**the first build is the slow part — let it finish**):
   ```bash
   docker compose --profile rtorrent up -d --build
   ```
4. Set up the database — run this **once**:
   ```bash
   docker compose exec backend npx prisma db seed
   ```
5. Open `http://<NAS-IP>:18080`, then continue at
   [After it's running](#after-its-running-both-nas).

> **Prefer clicking to typing?** Container Manager → **Project** → **Create** →
> point it at the `ultratorrent-core` folder (it reads `docker-compose.yml` for
> you). You still need SSH once for step 4 — or, in Container Manager, open the
> **backend** container, go to its **Terminal** tab, and run `npx prisma db seed`
> there.

### After it's running (both NAS)

1. **Log in.** Open `http://<NAS-IP>:18080`. The username is **`admin`** (it is a
   username, *not* an email address); the password is the `ADMIN_PASSWORD` you set
   in Step D. You can change it later from your profile menu.
2. **Connect the torrent engine.** In the left-hand menu choose **Infrastructure →
   Engines → Add engine**. Fill in:
   - **Client:** rTorrent
   - **Connection:** SCGI over TCP
   - **Host:** `rtorrent`  **Port:** `5000`
   - Turn **Default engine** on.

   Click **Test connection** — it should say **Connected**. Then click **Add
   engine**. Your **Torrents** page will now load.
3. **Point the file browser at your downloads** (only if you did Step E): go to
   **Settings → Default Root Path** and choose `/downloads`.

That's the whole setup. Add a torrent and you're running.

> **A note on file ownership (only matters if you tinker over the network):**
> downloaded files are owned by the app's internal user, **id 1000**. That's normal
> and everything inside UltraTorrent works. If you also want to add/delete those
> files from your NAS login over Windows/Mac file sharing, set that download
> folder's share permissions to allow your NAS user. If instead the folder is
> owned by *another* app's user (e.g. Plex), see the next section.

### Downloads folder owned by another user (e.g. Plex)

A common setup shares one folder between UltraTorrent and a media server: rTorrent
downloads into it, Plex reads from it. The app normally runs as user **id 1000**,
so a folder owned by `plex` isn't writable by it — and you should **not** `chown`
the folder to 1000, because that would break Plex.

The clean fix is to run the bundled rTorrent **as** the `plex` user, so downloads
are written as `plex` and the folder's ownership never changes:

1. Find plex's numeric id and group id (on the Docker host):
   ```bash
   id plex          # e.g. uid=1001(plex) gid=1001(plex)
   ```
2. In `.env`, set those two numbers:
   ```dotenv
   PUID=1001
   PGID=1001
   ```
3. Recreate the rTorrent container so it picks them up:
   ```bash
   docker compose --profile rtorrent up -d rtorrent
   ```
   rTorrent now writes downloads as `plex` — Plex sees them immediately, and the
   folder stays owned by `plex`.

> The bundled engine also **won't** claim a folder already owned by a real user
> (it only auto-fixes ownership on a brand-new, empty Docker volume), so pointing
> it at a `plex`-owned share is safe.

**Optional — let the in-app File Manager write there too.** The backend (still
uid 1000) can be added to plex's group so its file-browser actions (create/move/
delete) work on that folder. Make the folder group-writable (this keeps plex as
the owner) and add the backend to plex's group via `docker-compose.override.yml`:
```bash
sudo chmod -R g+rwX /path/to/downloads
sudo find /path/to/downloads -type d -exec chmod g+s {} +   # new files inherit the group
```
```yaml
# docker-compose.override.yml
services:
  backend:
    group_add: ["1001"]     # plex's GID from step 1
```
Then `docker compose up -d backend`. If you skip this, downloading still works
fully; only the in-app File Manager's *write* actions on that folder are limited
(and the "cannot write to this path" note appears when setting the Default Root
Path — it's a warning, not a blocker).

---

## Required environment variables

Set these in `.env` (Docker) or the backend's environment (manual). The backend
**refuses to boot in production** with unset/default/weak secrets.

```dotenv
# --- Database ---
POSTGRES_PASSWORD=<strong, alphanumeric>     # required
# DATABASE_URL is only for MANUAL installs; the Docker stack derives it from
# POSTGRES_USER/PASSWORD/DB. Manual example (note host = localhost):
# DATABASE_URL=postgresql://ultratorrent:<POSTGRES_PASSWORD>@localhost:5432/ultratorrent?schema=public

# --- Secrets (generate each: openssl rand -base64 48) ---
JWT_ACCESS_SECRET=<>=32 random chars>        # required
JWT_REFRESH_SECRET=<random>                  # required
ENCRYPTION_KEY=<>=32 random chars>           # required, MUST differ from JWT_ACCESS_SECRET

# --- Admin bootstrap (used once by the seed) ---
ADMIN_PASSWORD=<your admin login password>   # required

# --- Optional ---
FILE_MANAGER_ROOTS=/downloads                # comma-separated allowed roots
CORS_ORIGIN=http://localhost:8080
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@ultratorrent.local
```

| Variable | Required | Purpose |
|----------|----------|---------|
| `POSTGRES_PASSWORD` | ✅ | PostgreSQL password (Compose won't start without it). Docker derives `DATABASE_URL` from it. |
| `DATABASE_URL` | manual only | Prisma connection string — set it for manual installs; the Docker stack builds it from `POSTGRES_*`. |
| `JWT_ACCESS_SECRET` | ✅ | Signs access tokens — ≥32 chars, not a default |
| `JWT_REFRESH_SECRET` | ✅ | Reserved refresh secret |
| `ENCRYPTION_KEY` | ✅ | Encrypts 2FA secrets at rest — ≥32 chars, **different from `JWT_ACCESS_SECRET`** |
| `ADMIN_PASSWORD` | ✅ | Bootstrap super-admin password |
| `FILE_MANAGER_ROOTS` | – | Allow-list of directories the file manager may access (default `/downloads`) |
| `CORS_ORIGIN` | – | Allowed browser origin |

---

## Optional: IMDb datasets

The Media Manager includes a **compliant IMDb metadata provider** that is
**optional and off by default**. It draws data only from IMDb datasets you
provide or an optional licensed IMDb API — UltraTorrent never scrapes IMDb web
pages, and no environment variable is required (it is configured entirely from
**Media > Settings > IMDb**, RBAC-gated by `media_manager.imdb.*`).

To use dataset mode, download IMDb's non-commercial datasets (the seven
`.tsv.gz` files: `title.basics`, `title.akas`, `title.crew`, `title.episode`,
`title.principals`, `title.ratings`, and `name.basics`) from IMDb's official
datasets page, and place them in a folder **under one of your
`FILE_MANAGER_ROOTS`** (the Default Root Path). Then, in the UI, set that folder
as the IMDb dataset path and run **Validate** followed by **Import**. See
[MEDIA_MANAGER.md](MEDIA_MANAGER.md#imdb-integration) for the full walkthrough.

---

## Manual install (Linux PC, from source)

For development or running without Docker.

### Prerequisites

| Requirement | Version |
|-------------|---------|
| **Node.js** | **20 LTS** (the repo pins it via `.nvmrc`; `engines` requires ≥20) |
| **PostgreSQL** | 14+ |
| **Redis** | 6+ |
| **rTorrent** | any recent, reachable over SCGI — optional to boot, required for real torrents |

> **Get a clean Node 20.** Do *not* rely on a distro `nodejs`/`npm` package —
> mismatched distro npm is a common source of errors (e.g. `Cannot find module
> 'semver'`). Use **nvm** (`nvm install 20 && nvm use 20`) or **NodeSource**
> (`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo
> apt-get install -y nodejs`). Avoid bleeding-edge/non-LTS Node (23/25/26).
> PostgreSQL + Redis can be installed via your package manager, or run just those
> two via Docker.

### Steps

```bash
# 1. Clone & install (npm workspaces — always install from the repo root)
git clone https://github.com/damirabal/ultratorrent-core.git
cd ultratorrent-core
npm install

# 2. Configure the backend env (see "Required environment variables" above)
cp .env.example apps/backend/.env
#    IMPORTANT: .env.example is written for Docker, where the DB host is the
#    `postgres` service name. For a manual install, point at your local DB:
#      DATABASE_URL=postgresql://ultratorrent:<PW>@localhost:5432/ultratorrent?schema=public
#      REDIS_HOST=localhost
#    You need PostgreSQL + Redis running first. Easiest is to run just those two
#    in Docker (they create the DB/user for you from the env):
#      docker run -d --name ut-postgres -p 5432:5432 \
#        -e POSTGRES_USER=ultratorrent -e POSTGRES_PASSWORD=<PW> \
#        -e POSTGRES_DB=ultratorrent postgres:17-alpine
#      docker run -d --name ut-redis -p 6379:6379 redis:7-alpine

# 3. Prisma: generate, migrate, seed
npm run prisma:generate
npm run prisma:migrate                 # prisma migrate deploy
npm run prisma:seed                    # permissions, roles, admin, settings

# 4. Run backend + frontend (dev)
npm run dev
#   backend  → http://localhost:4000  (Swagger at /api/docs in non-production)
#   frontend → http://localhost:5173  (proxies /api + /ws to the backend)
```

The seed upserts every permission, creates the five system roles, bootstraps the
**Super Admin** (`ADMIN_USERNAME`/`ADMIN_PASSWORD`), and inserts default
settings. It's idempotent — re-running never resets the admin password.

> In local dev without `ADMIN_PASSWORD` set, the seed falls back to a well-known
> development password (`changeme123!`) that you must change immediately. In
> production, `ADMIN_PASSWORD` is required.

---

## Connecting an rTorrent engine

UltraTorrent talks to rTorrent over **XML-RPC**, usually via **SCGI**.

> **Easiest way (recommended): use the web UI.** Sign in, then go to
> **Infrastructure → Engines → Add engine**, fill in the connection details,
> and click **Test connection** before saving. No commands or tokens needed.
> The `curl` example below is only for people automating setup via the API.

**Using the bundled engine (Docker `--profile rtorrent`):** it's already running
and shares the downloads volume. In the UI, add an engine with host **`rtorrent`**
and SCGI port **`5000`** (both containers share the internal Docker network).

**Using your own rTorrent:** enable an SCGI endpoint in `~/.rtorrent.rc`:
```ini
# SCGI over a TCP port (mode "scgi-tcp"):
network.scgi.open_port = 127.0.0.1:5000
# …or a Unix socket (mode "scgi-unix"):
# network.scgi.open_local = /var/run/rtorrent/rpc.socket
```
> **Security:** the SCGI interface is unauthenticated and grants full control —
> bind it to `127.0.0.1` or a Unix socket and never expose it to a network.

Register the engine via the API (needs `engines.manage`):
```bash
curl -X POST http://<host>:8080/api/engines \
  -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "name":"Main rTorrent", "kind":"rtorrent", "isDefault":true, "isEnabled":true,
        "config": { "mode":"scgi-tcp", "host":"rtorrent", "port":5000, "timeoutMs":15000 } }'
```

| `config.mode` | Fields | rTorrent config |
|---------------|--------|-----------------|
| `scgi-tcp` | `host`, `port` | `network.scgi.open_port` |
| `scgi-unix` | `socketPath` | `network.scgi.open_local` |
| `http` | `url` | an HTTP→XML-RPC front-end |

Verify: `GET /api/engines/health?engineId=<ID>` → `{ "online": true, … }`.

---

## Updating

UltraTorrent Community is updated by pulling the latest source and rebuilding.
**Database migrations are applied automatically** — the backend runs
`prisma migrate deploy` on start (Docker) / you run it (manual). Always **back up
your database first**; migrations are forward-only.

### Docker installs (Linux PC / QNAP / Synology)

```bash
cd ultratorrent-core

# 1. Back up the database first (safety net):
docker compose exec -T postgres pg_dump -U ultratorrent ultratorrent > backup-$(date +%F).sql

# 2. Get the latest code (keeps your .env and docker-compose.override.yml):
git pull                      # no git? re-download the ZIP over the folder, keeping .env + override

# 3. Rebuild changed images and recreate containers. The backend runs
#    `prisma migrate deploy` on boot, so new DB migrations apply automatically.
docker compose --profile rtorrent up -d --build

# 4. Re-run the seed to pick up any NEW permissions/roles/settings (idempotent —
#    it never resets your admin password or existing data):
docker compose exec backend npx prisma db seed

# 5. Confirm the running version:
curl -s http://localhost:8080/api/system/version    # NAS: use your remapped port
```

- **NAS GUI:** if you deployed via Container Station / Container Manager instead
  of SSH, update the source folder first, then use the app's **Rebuild** (QNAP)
  / **Project → Build** (Synology) action; run the one-time seed step over SSH.
- **Old images pile up** after rebuilds — reclaim space occasionally with
  `docker image prune -f`.
- **Rollback:** `git checkout <previous-tag-or-commit>` then repeat step 3.
  Because migrations are forward-only, restore your pre-update database backup if
  a rollback crosses a schema change.

### Manual install (Linux PC)

```bash
cd ultratorrent-core
git pull

# If the required Node changed, match it (the repo pins Node 20 via .nvmrc):
nvm use            # if you use nvm

npm install               # pick up dependency changes
npm run prisma:generate
npm run prisma:migrate    # apply new migrations (prisma migrate deploy)
npm run prisma:seed       # pick up new permissions/settings (idempotent)
npm run build             # production build (skip if you run `npm run dev`)

# Restart however you run it (systemd/pm2/nohup), or re-run `npm run dev`.
```

> Back up your PostgreSQL database before `prisma:migrate` (e.g. `pg_dump`), for
> the same forward-only reason.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Prisma only supports Node.js >= 16.13` on `npm install` | Your Node is too old. Install **Node 20** (nvm or NodeSource). |
| `Cannot find module 'semver'` from `/usr/share/nodejs/npm` | Broken distro npm. Remove `nodejs`/`npm` apt packages and use nvm or NodeSource for a self-consistent Node 20 + npm. |
| Backend exits at boot with "insecure secret configuration" | `JWT_ACCESS_SECRET`/`ENCRYPTION_KEY` unset, default, <32 chars, or identical. Set strong, distinct values. |
| Compose won't start: "POSTGRES_PASSWORD is required" | Set `POSTGRES_PASSWORD` (and `ADMIN_PASSWORD`) in `.env`. |
| Web UI port already in use (e.g. `8080` on a NAS) | Set `FRONTEND_PORT=<free port>` in `.env` and re-run `up -d`. (Don't try to remap ports via an override file — Compose *appends* `ports`, so the original mapping stays and still conflicts.) |
| Backend port 4000 in use | The backend isn't published to the host by default, so this shouldn't happen. If you added a `ports` mapping for the API, change it to a free host port. |
| `P1001: Can't reach database server at `postgres:5432`` (manual install) | Your `DATABASE_URL` uses the Docker service host `postgres`. For a manual install change it to `localhost` (and make sure PostgreSQL is actually running). |
| Backend crash-loops with Prisma `P1000: Authentication failed` (Docker) | The `postgres_data` volume was first created with a *different* `POSTGRES_PASSWORD` — Postgres only applies the password on **first init**, so later `.env` changes don't take effect on an existing volume. If the DB has no real data yet, reset it: `docker compose down -v && docker compose --profile rtorrent up -d --build`. Use an **alphanumeric** `POSTGRES_PASSWORD` (a URL-special char like `@ : /` breaks the derived connection string). |
| "Failed to connect to PostgreSQL" | `DATABASE_URL` wrong or Postgres not up; in Docker the host is `postgres`, manual it's usually `localhost`. |
| Backend crashes with `Cannot find module '...'` at boot | The image is missing a nested workspace dependency. Rebuild with the current Dockerfiles: `docker compose up -d --build`. If you customized the Dockerfile, make sure the runtime stage copies `apps/backend/node_modules` (npm doesn't always hoist deps to the root). |
| "Invalid username or password" right after install | Log in with the **username** (`admin` by default), not the email. Make sure you ran the seed: `docker compose exec backend npx prisma db seed`. |
| Admin password won't work / forgot it | The seed only sets the password when it **first** creates the admin (it won't overwrite a later change). Reset it to your current `.env` value: `docker compose exec backend node -e 'const argon2=require("argon2");const{PrismaClient}=require("@prisma/client");(async()=>{const p=new PrismaClient();const u=process.env.ADMIN_USERNAME\|\|"admin";const h=await argon2.hash(process.env.ADMIN_PASSWORD,{type:argon2.argon2id});const r=await p.user.update({where:{username:u},data:{passwordHash:h,isActive:true}});console.log("reset:",r.username);await p.$disconnect()})().catch(e=>{console.error(e.message);process.exit(1)})'` |
| `/api/engines/health` returns `online: false` (or "Could not load torrents") | No engine configured, or rTorrent SCGI not reachable. Add an engine under **Infrastructure → Engines** (kind rtorrent, mode scgi-tcp, host `rtorrent`, port `5000` for the bundled engine) and use **Test connection**. The bundled engine only runs if you started the stack with `--profile rtorrent`. |
| "The app process cannot write to this path" when setting Default Root Path | The folder isn't writable by the app's user (id 1000). If it's a plain folder, `chown -R 1000:1000 <folder>`. If it's owned by another app (e.g. Plex), **don't** chown it — set `PUID`/`PGID` to that user so rtorrent writes as them, and optionally add the backend to that group (see *Downloads folder owned by another user*). It's a warning, not a blocker — saving still works. |
| Bundled rTorrent crash-loops: "Could not lock session directory … held by …" | A previous rTorrent crash left a stale `rtorrent.lock`. Current images auto-clear it on startup — `git pull` + `docker compose --profile rtorrent up -d --build rtorrent`. To clear it by hand: `sudo rm -f <downloads>/.session/rtorrent.lock`. |
| Bundled rTorrent crashes with "DhtServer::event_write … both write queues are empty" | Known DHT bug in this rTorrent build. DHT is **off by default** for this reason; if you enabled it (`RT_DHT=on`) and hit this, set `RT_DHT=off` in `.env` and recreate rtorrent. Trackers + PEX still find peers. |
| WebSocket never connects | JWT missing/expired, or `/ws` not proxied by your reverse proxy (`Upgrade`/`Connection` headers). |
