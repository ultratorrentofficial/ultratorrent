---
id: download
title: Get UltraTorrent
sidebar_position: 2
description: Where UltraTorrent actually comes from — the source repository, choosing a release tag, the ZIP route without git, what is deliberately not published, and how to build the installer and console binaries.
keywords:
  - download
  - get
  - get ultratorrent
  - source
  - git clone
  - zip
  - release
  - releases
  - version
  - tag
  - docker image
  - registry
  - installer binary
  - build
---

# Get UltraTorrent

## Overview

UltraTorrent is distributed as **source**. You clone (or download) the repository
onto the machine that will run it, and the Docker images are built there on first
start.

That is the whole story, and it is worth stating plainly because it is unusual:
there is no `docker pull`, no NAS app-store entry, and no installer to download.
Everything below follows from it.

:::info Why no prebuilt images?
No registry image is published yet, so the Compose stack **builds from source**.
Your host therefore needs Docker, the source tree, and roughly **2 GB of free RAM**
for the first build (about 10–15 minutes; later starts are seconds). Base images
are multi-arch, so x86-64 and ARM64 hosts both work.
:::

## What is published, and what is not

| | Status | Where |
| --- | --- | --- |
| **Source repository** | Published | [github.com/ultratorrentofficial/ultratorrent](https://github.com/ultratorrentofficial/ultratorrent) |
| **Version tags** (`vX.Y.Z`) | Published | One per release, on the same repository |
| **Source ZIP** | Published | GitHub's **Code → Download ZIP** |
| **This documentation** | Published | [docs.ultratorrent.co](https://docs.ultratorrent.co), and offline inside the app at `/docs/` |
| **Docker images** | **Not published** | Built on your host by `docker compose --build` |
| **GitHub Releases with attached files** | **Not published** | Use the tags |
| **`ultratorrent-install` binary** | **Not published** | [Build it](#optional-the-client-binaries) from the checkout |
| **`utconsole` binary** | **Not published** | [Build it](#optional-the-client-binaries), or let the installer place it |
| **Synology / QNAP / Unraid app-store package** | **Not published** | Every NAS route is the same Compose stack — see [Platforms](/install/platforms/linux) |

## Before you start

On the machine that will run UltraTorrent:

- **Docker Engine** with the **Compose v2 plugin** (`docker compose`, with a space — not the legacy `docker-compose`).
- **`git`**, or a browser and a way to copy a folder onto the host.
- **~2 GB free RAM** for the build, **2+ GB disk** for the images, plus whatever your downloads need.

You do **not** need Node.js, PostgreSQL or Redis on the host — they run in
containers. (A from-source development install does; see
[Linux](/install/platforms/linux#manual-install-from-source).)

## Get the source

### With git — recommended

```bash
git clone https://github.com/ultratorrentofficial/ultratorrent.git
cd ultratorrent
```

**Expected result:** a folder containing `docker-compose.yml`, `.env.example`,
`apps/` and `docs/`.

```bash
ls docker-compose.yml .env.example
```

git is the recommended route for one reason that matters later: **upgrading is
`git pull` + rebuild**. A ZIP has no way to update in place, and no way to tell
you what changed.

### Pin a release instead of tracking `main`

`main` is the development branch. A tagged release is the version this
documentation site labels, and what
[`GET /api/system/update`](/reference/api) compares against.

```bash
git clone https://github.com/ultratorrentofficial/ultratorrent.git
cd ultratorrent

git tag --list 'v*' --sort=-v:refname | head        # newest first
git checkout v0.85.9                                 # or whichever you want
```

:::tip Which should I run?
Pin a tag if this box matters to you — you then upgrade deliberately, after
reading the [changelog](https://github.com/ultratorrentofficial/ultratorrent/blob/main/CHANGELOG.md).
Track `main` if you want the newest work and do not mind a rebuild finding a
migration you had not read about.
:::

### Without git — the ZIP

Useful on a NAS with no `git`, where you copy a folder over SMB instead.

1. Open [the repository](https://github.com/ultratorrentofficial/ultratorrent) in a browser.
2. **Code → Download ZIP** (for a specific version: **Tags →** pick one → **Code → Download ZIP**).
3. Unzip it, and copy the folder onto the host — into `/volume1/docker/` on
   Synology, `/share/Container/` on QNAP, `/mnt/user/appdata/` on Unraid.
4. Rename it to `ultratorrent`. GitHub's ZIP unpacks to `ultratorrent-main`, and
   **Compose derives the project name from the directory**, so the folder name
   becomes the prefix on every container, image and volume this install creates.

:::warning A ZIP is a dead end for upgrades
Upgrading a ZIP install means downloading a new ZIP, copying it over the old
folder without clobbering `.env`, and rebuilding — with no diff and no rollback.
If you can install `git` on the host, do that instead.
:::

## Confirm what you got

```bash
cat VERSION                     # the canonical version, e.g. 0.85.9
git describe --tags --always    # exactly which commit you are on
git status --porcelain          # empty = an unmodified checkout
```

`VERSION`, `package.json` and `version.json` all carry the same number — the
project is changeset-driven with [one canonical version](https://github.com/ultratorrentofficial/ultratorrent/blob/main/docs/VERSIONING.md).
Once the stack is running, `GET /api/system/version` reports the same thing, and
the About dialog shows it.

:::note Verifying authenticity
There are no signed release artifacts or published checksums to verify against
today, because there are no release artifacts. What you can verify is the
transport and the history: clone over HTTPS from the URL above, and check the
commit you landed on with `git log -1`.
:::

## What you just downloaded

| Path | What it is |
| --- | --- |
| `docker-compose.yml` | The stack: PostgreSQL, Redis, backend, frontend, plus profiled engines and companions |
| `.env.example` | Every environment variable, commented — the template for your `.env` |
| `apps/backend` · `apps/frontend` | The NestJS API and the React web UI, built into the images |
| `packages/shared` | Contracts shared by both |
| `docs/` | The full documentation as Markdown (this site, in the repository) |
| `website/` | The documentation site itself |
| `clients/installer` | Source for `ultratorrent-install`, the guided installer |
| `clients/console` | Source for `utconsole`, the read-only terminal client |
| `deploy/`, `ops/` | The bundled Caddyfile, rTorrent config, and operational scripts |

## Optional: the client binaries

Two Go programs ship as **source only** — `dist/` is gitignored, so binaries are
built and never committed. Building them needs [Go](https://go.dev/dl/) at the
version each module's `go.mod` names; nothing else.

```bash
cd clients/console   && ./build.sh    # utconsole      → dist/ (linux, darwin, windows)
cd ../installer      && ./build.sh    # ultratorrent-install → dist/ (linux amd64/arm64, windows amd64)
```

Each writes a `dist/SHA256SUMS` alongside the binaries. Build the console
**first**: the installer embeds the matching console for each platform, so an
install ends with a working console and no second download.

- **[`ultratorrent-install`](/install/installer)** — inspects the host, prints the
  plan, generates the configuration and deploys the stack. Optional: the
  [Docker Compose route](/install/docker-compose) does the same work by hand.
- **[`utconsole`](/operate/console)** — a read-only terminal view of a running
  install. Optional, and installed for you if you use the installer.

:::info No Go on the host?
Both binaries are static and cross-compiled, so build them on any machine and
copy the one file across — `CGO_ENABLED=0` is what lets a single binary run on a
current Debian and on a NAS whose glibc is years older.
:::

## Where to put it on the host

The checkout location is yours to choose, but two things follow it:

- **Compose derives the project name from the folder name**, so `ultratorrent/`
  gives you `ultratorrent-backend-1`, `ultratorrent_postgres_data`, and so on.
  Rename before you first bring the stack up, not after.
- **It must be on persistent storage.** On a NAS this means a share
  (`/volume1/...`, `/share/...`), never a path on a root filesystem that runs
  from RAM.

Your [platform page](/install/platforms/linux) names the conventional directory
for your host.

## Next steps

1. **[Docker Compose install](/install/docker-compose)** — the authoritative install, by hand.
2. Or **[the guided installer](/install/installer)** — the same result, driven by one binary.
3. Then **[Quick start](/learn/quick-start)** and **[your first download](/learn/first-download)**.
4. Later: **[Upgrading](/install/upgrading)** — which is `git pull` and a rebuild.

## Checklist

- [ ] The source is on the machine that will run it, on persistent storage
- [ ] The folder is named the way I want the Compose project named
- [ ] `docker-compose.yml` and `.env.example` are both present
- [ ] I know whether I am on `main` or a pinned tag (`git describe --tags`)
- [ ] `cat VERSION` matches what I expect
- [ ] Docker Engine and the Compose **v2** plugin are installed
- [ ] ~2 GB RAM free for the first build

## FAQ

**Is there a Docker Hub or GHCR image?**
No. Every install builds the images locally with `docker compose up -d --build`.

**Is there an installer I can download and run?**
The installer exists, but it is not published as a downloadable file — you build
it from the checkout with `clients/installer/build.sh`. See
[Guided installer](/install/installer).

**Why are there no GitHub Releases?**
Releases are cut as **tags** today. `git tag --list 'v*'` is the list, and the
[changelog](https://github.com/ultratorrentofficial/ultratorrent/blob/main/CHANGELOG.md)
is the release notes.

**Do I need the whole repository, or just `docker-compose.yml`?**
The whole thing. The images are built from `apps/`, so a bare Compose file has
no build context and cannot start anything.

**Can I clone it somewhere else and copy just the built images over?**
Yes — build on a capable machine and ship the images through a registry. That is
how the project's own constrained hosts are deployed; see
[`docs/OPERATIONS.md`](https://github.com/ultratorrentofficial/ultratorrent/blob/main/docs/OPERATIONS.md).

**How big is it?**
The checkout is small; the built images and their build cache are the real cost —
budget a couple of GB before any media.

**Does it update itself?**
No. The app can *tell* you a newer tag exists (`GET /api/system/update`), but
nothing self-applies: a container cannot replace the image it is running from.
See [Upgrading](/install/upgrading).

## See also

- [Choose your install method](/install/) — which host route applies to you
- [Docker Compose install](/install/docker-compose) — the authoritative guide
- [Guided installer](/install/installer) — `ultratorrent-install`, end to end
- [Upgrading & rollback](/install/upgrading) — how a checkout moves forward
- [Terminal console](/operate/console) — `utconsole`
