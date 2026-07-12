# Build & Run

UltraTorrent is a single **Community** product in one repository — an npm
workspaces monorepo. There are no editions, no overlay, and no separate
build profiles: one `npm run build` builds the whole product.

- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Install & build](#install--build)
- [Database (Prisma)](#database-prisma)
- [Running in development](#running-in-development)
- [Testing & linting](#testing--linting)
- [Documentation site](#documentation-site)
- [Docker images](#docker-images)
- [Versioning](#versioning)

---

## Repository layout

```
apps/backend      NestJS API      (@ultratorrent/backend)
apps/frontend     React + Vite SPA (@ultratorrent/frontend)
packages/shared   @ultratorrent/shared — types, permission catalog, event contracts
website/          Docusaurus documentation site (its own package, not a workspace)
docs/             documentation
ops/scripts/      release + version tooling
```

`packages/shared` is a dependency of both apps, so it builds first.

## Prerequisites

- **Node.js ≥ 20** and npm (workspaces).
- **PostgreSQL** and **Redis** for running the backend (see
  [INSTALL.md](INSTALL.md) / [DOCKER.md](DOCKER.md)).

## Install & build

Install once at the repo root — npm workspaces link the packages together:

```bash
npm ci                # or: npm install
npm run build         # builds @ultratorrent/shared → backend → frontend, in order
```

`npm run build` is the single build entry point; it runs the workspace builds in
dependency order (shared first, then backend and frontend).

## Database (Prisma)

The backend uses Prisma against PostgreSQL. From the repo root:

```bash
npm run prisma:generate    # generate the Prisma client
npm run prisma:migrate     # apply migrations (dev)
npm run prisma:seed        # provision permissions, roles, bootstrap admin, settings (idempotent)
```

Migrations live in `apps/backend/prisma/migrations`. For a fresh production DB,
use `prisma migrate deploy`.

## Running in development

```bash
npm run dev            # backend + frontend together
npm run dev:backend    # backend only  (@ultratorrent/backend)
npm run dev:frontend   # frontend only (Vite dev server)
```

The frontend proxies API/WebSocket traffic to the backend; changes are picked up
via Vite HMR. See [DEVELOPMENT.md](DEVELOPMENT.md) for the full local setup.

## Testing & linting

```bash
npm run test           # run every workspace's tests
npm run lint           # lint every workspace
```

Both fan out across all workspaces (`--if-present`).

## Documentation site

The Docusaurus site in `website/` is a **separate package** (not an npm
workspace) — it has its own `package.json` and lockfile, so install it once with
`npm ci --prefix website`. From the repo root:

```bash
npm run docs:dev       # generate the reference, then serve with hot reload (localhost:3000)
npm run docs:build     # production build → website/build (English + es-PR)
npm run docs:serve     # serve the built site locally
```

Each of these delegates to `website/` (`npm --prefix website start|run build|run
serve`). `start` and `build` first run `npm run gen`, which **generates** the
reference section (endpoints, permissions, modules, env vars, database schema)
from the real sources — so it can't drift from what ships. The generator reads
the compiled `@ultratorrent/shared`, so run `npm run build --workspace
@ultratorrent/shared` first in a clean clone.

The site is **built into the frontend image** (the `docs` stage of
`apps/frontend/Dockerfile`) and served by nginx at `/docs` — see
[DOCKER.md](DOCKER.md#bundled-documentation). It is also published to GitHub
Pages by `.github/workflows/docs.yml`; pull requests build it as a check, with
broken links failing the build.

## Docker images

Build the two runtime images (tagged with the current `version.json` version and
the bare name):

```bash
npm run package
```

| Image | Dockerfile |
|-------|-----------|
| `ultratorrent/backend:<version>` (+ `ultratorrent/backend`) | `apps/backend/Dockerfile` |
| `ultratorrent/frontend:<version>` (+ `ultratorrent/frontend`) | `apps/frontend/Dockerfile` |

To run the stack with Docker Compose, see [DOCKER.md](DOCKER.md).

### Build stamp (git commit in the version badge)

The UI version badge shows `v<version> - (<short-sha>)` — the exact commit an
image was built from (`GET /api/system/version`). The commit is stamped
automatically; you don't pass build args by hand:

- **`npm run package` / `npm run build:docker` (`ops/scripts/docker-build.sh`)**
  stamp the git sha/tag/build-time into the image (build args **and** a baked-in
  `build-info.json`). Prefer these over a bare `docker compose build`.
- A bare **`docker compose build`** still stamps the commit *if* `build-info.json`
  is present at the repo root. Run `ops/scripts/install-git-hooks.sh` once per
  clone: the `.githooks` then refresh `build-info.json` on every `git pull` /
  checkout / commit, so even a plain `docker compose up --build` after a pull
  carries the commit.
- Building from a **source tarball with no `.git`** (and no `build-info.json`)?
  The image still runs; the badge just shows the version without a commit. Pass
  `GIT_SHA`/`GIT_TAG`/`BUILD_TIME` build args if you want the commit anyway.

`build-info.json` is generated (gitignored) — never commit it.

## Versioning

`version.json` is the single source of truth for the product version; every
workspace `package.json` and the root `VERSION` follow it. Changes are tracked
with changesets and shipped via `npm run release:plan` / `release:apply`. See
[RELEASE_PROCESS.md](RELEASE_PROCESS.md) for the full flow.
</content>
