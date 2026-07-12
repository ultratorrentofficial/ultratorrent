# Versioning Policy

UltraTorrent carries a **single canonical version**, managed with a lightweight
changeset flow modeled on
[Changesets](https://github.com/changesets/changesets) (the `.changeset/*.md`
convention, driven by the scripts in `ops/scripts/` — no CLI, since this is an
npm-workspaces monorepo). This is the standing policy for **what** bumps the
version and **how** it reaches what users and admins actually see. There is one
versioned unit — the product — and every workspace package ships on that same
number. Every change is documented as a changeset.

---

## 1. Version shape (SemVer)

A version is three numbers: **`MAJOR.MINOR.PATCH`** (e.g. `1.2.3`). You bump
exactly one per release; everything to its right resets to `0`.

| Bump | `1.2.3` becomes |
|------|-----------------|
| patch | `1.2.4` |
| minor | `1.3.0` |
| major | `2.0.0` |

The tooling does the arithmetic — **the human picks which word.**

---

## 2. The rubric — patch vs minor vs major

> **Fixed it → patch. Added to it → minor. Broke or wiped it → major.**

| Tag | Meaning | Use when… | Examples |
|-----|---------|-----------|----------|
| **`patch`** | nothing new, just fixed | bug fix, query/perf fix, copy/icon tweak — no new user-facing capability | "filterless RSS rule no longer grabs the whole feed", "correct a tooltip", "speed up snapshot sync" |
| **`minor`** | new stuff, backward-compatible | added a feature/panel/admin screen; existing data + config still work | "add matched-rule to the torrent drawer", "new automation trigger", "add a KPI widget" |
| **`major`** | breaking / operator-impacting | a migration that drops/rewrites data, a config-incompatible change, removing a core system, an auth/permission overhaul | "purge a storage path", "rename settings keys", "rework the engine abstraction" |

Day-to-day, almost everything is **`minor`** (new capability) or **`patch`**
(fixes). **`major`** is rare and deliberate.

---

## 3. What is versioned

This repo has **one** canonical version: the root `package.json` (`ultratorrent`).
The workspace packages (`@ultratorrent/shared`, `-backend`, `-frontend`) are
**not** versioned independently — they're satellites kept in lockstep with the
root.

The same number is read at runtime/build from several places, all kept in sync:

| Where | Read by | How |
|-------|---------|-----|
| `version.json` | source-of-truth mirror | one canonical number |
| `VERSION` | `GET /api/system/version` | backend runtime read (`apps/backend/src/config/configuration.ts`) |
| `apps/frontend` sidebar footer `v…` | `GET /api/system/version` (`useVersion`) | fetched from the backend |
| each workspace `package.json` | tooling / metadata | mirrored |
| `packages/shared/VERSION` | contracts tag | mirrored (lockstep) |

`ops/scripts/sync-versions.js` propagates the root version into all of them —
**one-way**, root is the source of truth. `npm run version:check` validates there
is no drift.

---

## 4. Workflow — how a version gets bumped

1. **Declare intent.** Lead the request with a level, e.g.
   `[minor] add matched-rule row to the torrent drawer`.
   - No level + the task changes app code → default to `patch`, but confirm the
     level before editing.
   - Non-code work (questions, infra, ops, docs, versioning chores) needs no
     changeset.
2. **Do the work.**
3. **Author the changeset** (before committing):
   ```bash
   npm run changeset:add -- --level <patch|minor|major> --summary "<concise summary>"
   # or: node ops/scripts/changeset-add.js --level <…> --summary "<…>"
   ```
   This writes a `.changeset/*.md`. Commit it with the work.
4. **Release** (when shipping) — the operator triggers it by saying **`release`**.
   Until then, changesets just accumulate in `.changeset/`.

---

## 5. Cutting a release — the `release` trigger

Authoring a changeset does **not** bump anything; changesets pile up, one per
shipped task, and are consumed only when a release is cut. Nothing
auto-releases — it is always an explicit operator action.

### The step (run on `main`, tree clean)

1. **Plan (read-only).** Prints pending changesets, the bump level, and
   `current → next`. Writes nothing:
   ```bash
   npm run release:plan        # node ops/scripts/release.js
   ```
   If empty, nothing to release. Review with the operator before applying.

2. **Apply** — consume the changesets (bump root `package.json`, append
   `CHANGELOG.md`, delete the consumed `.changeset/*.md`) and sync the satellites:
   ```bash
   npm run release:apply -- --yes     # node ops/scripts/release.js --apply --yes
   ```
   A bare apply requires **`--yes`** (an accident guard): without it, the script
   prints what it *would* bump and stops. Under the hood it bumps the root
   `package.json`, prepends a dated `CHANGELOG.md` section (summaries grouped by
   level), deletes the consumed `.changeset/*.md`, runs
   `ops/scripts/sync-versions.js`, then commits, tags `vX.Y.Z`, and pushes. Pass
   `--no-git` to stop after the file changes and finalize git yourself.

3. **Review** `git diff` — confirm the bump level, the `CHANGELOG.md` entry, the
   synced `version.json`/`VERSION`/package.json satellites, and that the consumed
   `.changeset/*.md` are deleted.

4. **Package + publish (separate deploy step).** Building the Docker images is a
   separate deploy step, independent of the version bump.

5. **Deploy.** Operators pick up the new version on their `git pull` + build. If
   the displayed numbers ever drift (e.g. an out-of-band edit), re-run
   `npm run version:sync` to bring the satellites back in line with the root.

> **No npm publish.** Packages are `private` and there is no registry step —
> "release" here means *bump + changelog + sync + commit + tag*, distributed by
> the dev → `main` → operator `git pull` flow. `release:apply` commits, tags
> `vX.Y.Z`, and pushes **the current branch** plus the tag to `origin`.
