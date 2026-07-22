# Operations — building, shipping and deploying UltraTorrent

How a change gets from a working tree onto running hardware, and the failures that
shaped the procedure. Every rule here exists because skipping it broke something.

This document is **public and identity-free**. It describes *roles*, not machines.
The mapping from role to actual host — SSH alias, address, port, checkout path — is
private and lives in `ops/hosts.local.md` (gitignored; see
[Host inventory](#host-inventory)).

- [Roles](#roles)
- [The deploy pipeline](#the-deploy-pipeline)
- [Pre-release gates](#pre-release-gates)
- [Cutting a release](#cutting-a-release)
- [Deploying to the build host](#deploying-to-the-build-host)
- [Shipping to a constrained host](#shipping-to-a-constrained-host)
- [Disk discipline](#disk-discipline)
- [Verification](#verification)
- [Failure catalogue](#failure-catalogue)
- [Host inventory](#host-inventory)

---

## Roles

| Role | What it is | Builds images? |
| --- | --- | --- |
| **dev** | The workstation holding the working tree. Runs the backend from systemd and the frontend from Vite dev. | No |
| **build host** | A capable amd64 box running the full stack. Builds every image and serves them to the others. | **Yes** |
| **constrained host** | A NAS running the same stack on weak hardware. | **Never** |

A constrained host must never build. On the NAS this project runs on, a full
in-place build takes 30–40 minutes, spikes load average past 25, and has wedged the
Docker daemon outright. Images are built once on the build host and shipped.

---

## The deploy pipeline

```
dev            build host                       constrained host
────           ──────────                       ────────────────
commit ─push─► git pull
               build (STAMPED)  ──registry──►   pull ─► retag ─► up -d --no-build
               up -d
               prune
```

Both hosts run the **same image**, never two independent builds of the same commit.

---

## Pre-release gates

Run all of these before cutting anything. Each catches a class the others miss.

| Gate | Command | Catches |
| --- | --- | --- |
| Backend types | `npx tsc --noEmit -p apps/backend/tsconfig.json` | type errors |
| Frontend build config | `cd apps/frontend && npx tsc` | `noUnusedLocals` (**the root `--noEmit` does not enforce it**) |
| Unit tests | `npm test --workspace @ultratorrent/backend` | logic regressions |
| i18n parity | `cd apps/frontend && npx vitest run src/i18n/i18n.test.ts` | missing locale keys |
| **Fresh boot** | build + boot on a spare port | **NestJS DI / module-wiring errors** |

The last one is not optional and not covered by the others. Circular imports and
missing providers throw only at **bootstrap**, only on a **fresh build** — and the
dev box hides them, because systemd keeps running a stale compiled `dist/` with the
old modules already in memory.

```bash
cd apps/backend && npm run build
# Spare port so it does not clash with the running service. Do NOT pkill by name —
# it would match the systemd process too; scope by port.
sudo bash -c 'set -a; . /etc/ultratorrent/backend.env; set +a; \
  PORT=4999 timeout 30 node dist/main.js' 2>&1 \
  | grep -E "successfully started|can't resolve"
```

Fix pattern for a genuine module cycle whose dependency is only needed at runtime:
inject `ModuleRef` and resolve with `moduleRef.get(X, { strict: false })` at call
time instead of constructor injection.

---

## Cutting a release

Versioning is changeset-driven with a single canonical version. See
[VERSIONING.md](VERSIONING.md).

```bash
npm run changeset:add -- --level <patch|minor|major> --summary "…"   # per change
npm run release:plan                                                  # read-only
npm run release:apply -- --yes --no-git                               # bump only
```

> **Always pass `--no-git`.** Without it, `release.js` finalises with
> `git commit -a`, which stages **every tracked modified file** — sweeping any
> unrelated work-in-progress into the release commit and pushing it. Bump with
> `--no-git`, then stage the version files by explicit path and commit/tag/push
> yourself.

Tags are lightweight, so `--follow-tags` skips them. Push explicitly:

```bash
git push origin main && git push origin vX.Y.Z
```

After a release, confirm the changeset was actually consumed and `CHANGELOG.md`
gained its section. A bump that leaves its changeset pending will re-file the same
summary under the *next* version.

---

## Deploying to the build host

```bash
git pull --ff-only origin main
ops/scripts/docker-build.sh backend frontend
docker compose up -d backend frontend
```

**Build through `ops/scripts/docker-build.sh`, never a bare `docker compose build`.**
The script stamps the git sha/tag/build-time into the image (build args plus a baked
`build-info.json`). A bare build leaves `gitSha` null, so `GET /api/system/version`
and the UI version badge cannot tell you what is actually running — which is exactly
what you need when a deploy misbehaves.

If you must use compose directly, pass the stamps yourself:

```bash
export GIT_TAG=$(git describe --tags --always) \
       GIT_SHA=$(git rev-parse HEAD) \
       BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose build backend frontend
```

Only `backend` and `frontend` rebuild; datastores keep running. The backend applies
Prisma migrations on boot. A stamped build always recreates the backend (the stamp
changes), so expect a brief restart.

An untracked `docker-compose.override.yml` on a host carries its local bindings and
build args — compose merges it automatically. **Do not pass `-f`**, which would
disable that merge.

---

## Shipping to a constrained host

The build host runs a `registry:2` container. Push the built images to it and pull
them down on the target — layers dedupe and an interrupted pull resumes, which
matters on slow hardware.

```bash
# On the build host
docker tag ultratorrent-core-<svc>:latest <registry>/ultratorrent-core-<svc>:<version>
docker push <registry>/ultratorrent-core-<svc>:<version>

# On the constrained host
docker pull <registry>/ultratorrent-core-<svc>:<version>
docker tag  <registry>/ultratorrent-core-<svc>:<version> ultratorrent-core-<svc>:latest
docker compose up -d --no-build backend frontend
```

The **retag to the bare `ultratorrent-core-<svc>:latest`** matters: that is the name
Compose derives from the project directory, and `--no-build` will otherwise not find
an image. The target needs the registry in its `insecure-registries` (plain HTTP).

`docker save … | ssh … docker load` also works and needs no registry, but transfers
every layer every time.

Two things that look like failures and are not:

- `compose up` may print `Error response from daemon: No such container: <id>` while
  recreating. That is a stale-container race, not a failure — re-check `docker ps`
  before concluding anything broke.
- The pulled image gets a **different image ID** than the source, because the
  registry round-trip recompresses layers. **Verify by `build-info.json`, never by
  image ID.**

Some services are profile-gated. A bare `docker compose down` skips them and then
fails to remove the network they are still attached to. Keep `COMPOSE_PROFILES` set
in the host's `.env` so `up` and `down` stay symmetric.

---

## Disk discipline

**Prune on every deploy.** Each in-place build leaves cache behind. Left alone it
filled a 228 GB root disk to 100%, which crash-looped Postgres on its checkpoint
(`PANIC: could not write … No space left on device`) and took the whole application
down mid-deploy. Roughly six rebuilds in one session were enough.

```bash
docker builder prune -f --keep-storage 10GB   # keeps the next build fast
docker image prune -f                          # dangling only
df -h /
```

Escalations, in order of aggressiveness:

| Situation | Command | Note |
| --- | --- | --- |
| Routine | `builder prune -f --keep-storage 10GB` | after every deploy |
| Disk pressure | `builder prune -af` | reclaims everything; next build is slow |
| Historical versions | `docker rmi <registry>/ultratorrent-core-*:<old-version>` | tagged images survive `image prune -f` |

Keep the current and one previous version tagged so a rollback does not need a
rebuild. **`docker image prune -a` will remove images that are merely stopped, not
just dangling** — prefer removing specific old tags.

The registry itself accumulates too. `registry garbage-collect` only reclaims blobs
no manifest references, so deleting old **tags** in the registry is a prerequisite —
and the delete API is off unless the registry was started with
`REGISTRY_STORAGE_DELETE_ENABLED=true`.

---

## Verification

Never trust container uptime alone — hosts may run a non-local timezone.

```bash
docker ps                                            # healthy?
docker exec <backend> cat /app/build-info.json       # gitSha / gitTag / buildTime
docker logs <backend> | grep -E "migrat|successfully started"
```

`build-info.json` is the authority on what is running. Confirm **both** hosts report
the same `gitSha`.

The version endpoint is reachable from inside the container:

```bash
docker exec <backend> node -e 'const h=require("http");
h.get({host:"127.0.0.1",port:4000,path:"/api/system/version"},r=>{
  let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode,d));});'
```

`curl` and `wget` are not installed in the backend image; use `node`. The host's
`localhost:4000` may be a *different* service entirely — always check through the
container.

---

## Failure catalogue

Each of these cost a broken deploy. They are why the rules above exist.

| Date | Symptom | Cause | Rule it produced |
| --- | --- | --- | --- |
| 2026-07-04 | Backend crash-looped, 502 on login | NestJS module cycle; passed tsc + unit tests | Fresh-boot gate |
| 2026-07-06 | Frontend image never built; release dead | `noUnusedLocals` enforced only by the frontend build config | `cd apps/frontend && npx tsc` |
| 2026-07-06 | `Conflict. The container name … is already in use` | Half-recreated container after a failed build | `docker rm -f <name>`, then `up -d` |
| 2026-07-10 | `docker: command not found` over SSH | A login shell re-inits PATH and drops the container runtime's bin | Non-login SSH, `export PATH=…` once |
| 2026-07-14 | Postgres crash-loop, app down mid-deploy | Build cache filled the root disk to 100% | Prune every deploy |
| 2026-07-21 | `docker compose down` failed, daemon wedged | Profile-gated services skipped, network still attached | `COMPOSE_PROFILES` in `.env` |
| 2026-07-22 | Deployed image reported `gitSha: null` | Bare `docker compose build` | Build via `docker-build.sh` |

Shell gotcha behind the 2026-07-10 entry: `VAR=x cmd1 && cmd2` scopes `VAR` to
`cmd1` only. For multi-step remote commands use
`ssh <host> 'export PATH=…; cmd1 && cmd2'`.

---

## Host inventory

Actual hosts are **not** recorded in this repository. Create `ops/hosts.local.md`
(gitignored) mapping each role to its SSH alias, address/port, checkout path,
compose working directory, registry address, and any deploy wrapper. Template:

```markdown
| Role | Alias | Address | Checkout | Compose dir | Notes |
| --- | --- | --- | --- | --- | --- |
| build host       | … | … | … | … | registry at …:5000, wrapper at … |
| constrained host | … | … | … | … | never build here; PUID/PGID … |
```

If a host carries a deploy wrapper script, keep the script on the host and record
its path there — wrappers encode host-specific paths and do not belong in a public
repository.
