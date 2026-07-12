# Contributing to UltraTorrent

Thanks for your interest in improving UltraTorrent! This guide covers how we
branch, commit, and review changes. For environment setup and the codebase tour,
see [DEVELOPMENT.md](DEVELOPMENT.md).

- [Before you start](#before-you-start)
- [Branching](#branching)
- [Conventional commits](#conventional-commits)
- [Code style](#code-style)
- [Changesets](#changesets)
- [Pull request process](#pull-request-process)
- [Developer Certificate of Origin (DCO)](#developer-certificate-of-origin-dco)
- [License of contributions](#license-of-contributions)

---

## Before you start

- For anything non-trivial, **open an issue first** to discuss the approach.
- Make sure your change fits the architecture: read
  [ARCHITECTURE.md](ARCHITECTURE.md) and the coding standards in
  [DEVELOPMENT.md](DEVELOPMENT.md#coding-standards).
- Run the project locally and confirm the existing tests pass before you begin.

## Branching

- The default branch is `main`; it should always be releasable.
- Create a focused branch off `main` per change, named `<type>/<short-slug>`:

| Branch prefix | For |
|---------------|-----|
| `feat/` | a new feature |
| `fix/` | a bug fix |
| `docs/` | documentation only |
| `refactor/` | internal change, no behavior difference |
| `test/` | adding or fixing tests |
| `chore/` | tooling, deps, build |

Examples: `feat/qbittorrent-provider`, `fix/refresh-token-reuse`,
`docs/api-engines`.

Keep branches small and single-purpose. Rebase on top of the latest `main` before
opening a PR rather than merging `main` into your branch.

## Conventional commits

We use [Conventional Commits](https://www.conventionalcommits.org/). The format
is:

```
<type>(<optional scope>): <short summary>

<optional body — what & why, not how>

<optional footer — BREAKING CHANGE:, Closes #123, Co-authored-by:, Signed-off-by:>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`,
`build`, `ci`. Suggested scopes mirror the workspaces/modules: `backend`,
`frontend`, `shared`, `auth`, `torrents`, `engine`, `rtorrent`, `realtime`,
`audit`, `prisma`.

Examples:

```
feat(engine): add Transmission provider behind TorrentEngineProvider
fix(auth): burn refresh-token family on reuse detection
docs(api): document /api/torrents bulk endpoint
refactor(rtorrent): extract state mapping into a pure function
```

Breaking changes must include a `BREAKING CHANGE:` footer (or `!` after the type,
e.g. `feat(api)!: …`).

## Code style

- **TypeScript strict mode** is on across the repo — keep your changes warning
  clean.
- Run before pushing:

  ```bash
  npm run lint      # ESLint, runs with --max-warnings 0
  npm run test      # Jest where present
  npm run build     # ensure shared/backend/frontend still compile
  ```

- Follow the existing module/layer conventions: thin controllers, logic in
  services, normalized provider data, permissions from the shared catalog, DTO
  validation on all input, and audit logging for destructive actions.
- Update or add tests for behavior you change.
- Update relevant docs in the same PR (`docs/*`, the `website/` documentation
  site, this guide). Don't hand-edit `CHANGELOG.md` — it is generated from
  changesets when a release is cut (see below).

## Changesets

Every user-facing change ships with a **changeset** declaring its SemVer impact.
Author one and commit it alongside your work:

```bash
npm run changeset:add -- --level <patch|minor|major> --summary "<concise summary>"
# or: node ops/scripts/changeset-add.js --level <…> --summary "<…>"
```

Rubric: **fixed it → patch · added to it → minor · broke/removed it → major.**
This writes a `.changeset/*.md` that stays pending until a maintainer cuts a
release, which consumes it into the version bump and the `CHANGELOG.md` entry.
Docs-only or tooling-only changes need no changeset. See
[VERSIONING.md](VERSIONING.md).

## Pull request process

1. Ensure `lint`, `test`, and `build` pass locally.
2. Push your branch and open a PR against `main`.
3. In the PR description, include:
   - **What & why** — the problem and your approach.
   - **Linked issue** — `Closes #NNN` where applicable.
   - **Testing** — how you verified the change (commands, manual steps).
   - **Screenshots** for UI changes.
   - Any **breaking changes** or migration notes.
4. Keep the PR scoped to one logical change. Large PRs are hard to review — split
   when you can.
5. Include a [changeset](#changesets) for any user-facing change
   (`npm run changeset:add -- --level <level> --summary "…"`).
6. Address review feedback by pushing follow-up commits (we squash on merge, so
   don't worry about a tidy intermediate history).
7. A maintainer merges once CI is green and the review is approved. CI
   (`.github/workflows/core-ci.yml`) runs lint → prisma generate → tests → build,
   then builds both Docker images; `docs.yml` builds the documentation site.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/).
By contributing, you certify that you wrote the patch or otherwise have the right
to submit it under the project's license. You assert this by **signing off** every
commit:

```bash
git commit -s -m "feat(engine): add Deluge provider"
```

The `-s` flag appends a trailer to your commit message:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email must be real and match your Git identity. PRs whose commits are
not signed off may be asked to amend. To sign off an existing branch:

```bash
git rebase --signoff main
```

## License of contributions

UltraTorrent is licensed under **AGPL-3.0-or-later**. By submitting a
contribution, you agree that it will be distributed under the same license. Note
the AGPL's network-use clause: anyone running a modified version as a service must
offer its source to users.

**Contribution licensing grant.** UltraTorrent is licensed under AGPL-3.0. By
submitting a contribution you also grant the project maintainer (the copyright
holder) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license
to use, reproduce, modify, and **relicense your contribution under other terms**,
in addition to the AGPL-3.0 above. You retain the copyright to your contribution;
this grant does not take it away.

> If your employer owns your work, make sure you have permission to contribute
> under these terms.

This grant is formalized in the **[Contributor License Agreement](../CLA.md)**.
A CLA Assistant bot comments on your first pull request; sign once by commenting
`I have read the CLA Document and I hereby sign the CLA`. Maintainers and bots
are allow-listed and do not need to sign.

## Modules

UltraTorrent is a single-tier community product built from one codebase
([BUILD.md](BUILD.md)); every feature is a module declared in the module registry
([MODULES.md](MODULES.md)). When contributing:

- Put shared types, permissions, and event names in `@ultratorrent/shared` so the
  API and UI agree, rather than duplicating them.
- Add new capabilities as modules with a manifest (tier `core` or `community`),
  and gate their endpoints with RBAC (`@UseGuards(JwtAuthGuard, PermissionsGuard)`
  + `@RequirePermissions(...)`).
- Optional external integrations resolve through provider interfaces (e.g. the
  `LicenseProvider` binds the default `CommunityLicenseProvider`).
</content>
