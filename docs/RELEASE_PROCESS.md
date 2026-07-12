# Release Process

UltraTorrent is a single **Community** product built from one repository. There
are no editions, overlays, or private mirrors — this repo is the public product.
Releases are **changeset-driven**: every change carries a changeset declaring its
SemVer impact, and cutting a release consumes the pending changesets into a
version bump + CHANGELOG entry.

## Versioning model

`version.json` is the **single source of truth** (mirrored to a flat root
`VERSION` for the running app):

```jsonc
{ "version": "X.Y.Z",
  "editions": { "community": "X.Y.Z", "sdk": "X.Y.Z" } }
```

- `version` — the one canonical product version. Every workspace `package.json`
  (`apps/backend`, `apps/frontend`, `packages/shared`) follows it exactly.
- `editions.community` — always tracks the product version (the public
  UltraTorrent repo).
- `editions.sdk` — the `packages/shared` contracts version, written to
  `packages/shared/VERSION`. It normally tracks the product but can be bumped on
  its own track (`node scripts/version.mjs bump <level> --edition sdk`).

Version helpers:

```bash
npm run version:show      # print product / community / sdk versions
npm run version:check     # CI gate: fail if any package.json or VERSION drifts
npm run version:sync      # rewrite VERSION files + every package.json from version.json
```

The running app exposes its version at `GET /api/system/version`, resolved from
`ULTRATORRENT_VERSION` (set in Docker via `--build-arg`) → the `VERSION` file
(dev) → the built-in default.

## Authoring a changeset

Every change that should appear in a release ships with a changeset. Author one
and commit it alongside the work it describes:

```bash
node ops/scripts/changeset-add.js --level <patch|minor|major> --summary "…"
# or: npm run changeset:add -- --level patch --summary "…"
```

Rubric: **fixed it → patch · added to it → minor · broke/removed it → major.**
The changeset is written to `.changeset/<level>-<id>.md` and stays pending until
a release consumes it. The CHANGELOG section a changeset lands in follows its
level: patch → **Fixed**, minor → **Added**, major → **Changed**.

## Cutting a release

Two steps, both wrapping `ops/scripts/release.js`:

```bash
# 1) Plan (read-only): list pending changesets, the resulting bump level, and
#    current → next version. Writes nothing.
npm run release:plan

# 2) Apply: consume the changesets and finalize the release.
npm run release:apply -- --yes
```

`release:apply` is `node ops/scripts/release.js --apply`; the bare command
refuses to write and prints what it *would* do — pass `--yes` to actually apply.
Applying:

1. Bumps the canonical `version` on the root `package.json` by the highest
   pending level.
2. Prepends a dated `## [X.Y.Z] - DATE` block to `CHANGELOG.md`, summaries
   grouped by level.
3. Deletes the consumed `.changeset/*.md`.
4. Runs `ops/scripts/sync-versions.js` to propagate the new version to every
   workspace `package.json`, `version.json` (+ `editions` in lockstep), root
   `VERSION`, and `packages/shared/VERSION`.
5. Commits `release: vX.Y.Z`, tags `vX.Y.Z`, and pushes the branch + tag.

Pass `--no-git` to stop after the file changes and finalize git yourself.

## Building the Docker images

Image packaging is a **separate** step from the version release (nothing is
built or pushed by `release:apply`):

```bash
npm run package
```

This reads `version.json` and builds two images, each tagged with the version
and `latest`-style bare name:

| Image | Dockerfile |
|-------|-----------|
| `ultratorrent/backend:<version>` (+ `ultratorrent/backend`) | `apps/backend/Dockerfile` |
| `ultratorrent/frontend:<version>` (+ `ultratorrent/frontend`) | `apps/frontend/Dockerfile` |

## CI

GitHub Actions under `.github/workflows/`:

- **core-ci.yml** (name "CI") — a `build-test` job (install → build
  `@ultratorrent/shared` → lint → prisma generate → `test` → `build`) and a
  `docker` job that builds the backend + frontend images.
- **docs.yml** (name "Docs") — builds the `website/` documentation site (broken
  links fail the build) and publishes it to GitHub Pages on `main`; pull requests
  build it as a check but never publish.
- **security.yml** — secret scan, `npm audit`, license report, container scan.
- **cla.yml** — contributor licence agreement check.

## Pre-release checklist

1. `npm run build` and `npm run test` pass.
2. `npm run version:check` is green (no package.json / VERSION drift).
3. `prisma migrate deploy` applies cleanly; OpenAPI (`/api/docs`) generates.
4. Every user-facing change since the last release has a pending changeset.
5. `npm run release:plan` shows the expected bump and version.
6. ARCHITECTURE.md + its Change Log are updated for any architectural change.
</content>
</invoke>
