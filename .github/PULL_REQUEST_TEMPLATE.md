<!--
Thanks for contributing to UltraTorrent.

Delete any section that does not apply — an honest short PR beats a long one with
every box ticked. The checklists exist so a reviewer can see what you already
thought about, not to be filled in wholesale.

Contribution process, conventional commits and changesets: docs/CONTRIBUTING.md
-->

## Summary

<!-- What this changes, in a sentence or two. -->

## Why

<!--
The problem, not the patch. If it is a bug, what was happening; if it is a
feature, what could not be done before.
-->

Closes #
Related to #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Performance
- [ ] Security fix
- [ ] Documentation
- [ ] UI / UX
- [ ] API
- [ ] Database / migration
- [ ] Deployment / installer / Docker
- [ ] Provider / integration
- [ ] Build / CI / tooling

## Affected areas

<!-- Modules as declared in the module registry — see docs/MODULES.md. -->

- [ ] Frontend
- [ ] Backend
- [ ] `@ultratorrent/shared` (types, permissions, event names)
- [ ] API
- [ ] Database / Prisma
- [ ] Authentication / users / RBAC
- [ ] Torrents / torrent engine integration
- [ ] RSS Feeds
- [ ] Media Acquisition Intelligence (Smart Download, Missing Episodes)
- [ ] Media Discovery
- [ ] Media Intake
- [ ] Media Manager (incl. renamer, duplicate detection)
- [ ] Library Cleanup (deletes media — flag this one)
- [ ] Indexers / Prowlarr / Torznab / Newznab
- [ ] Metadata providers / media server integration
- [ ] Storage profiles / path mapping / files
- [ ] Notifications
- [ ] Scheduler / background jobs
- [ ] System / settings / module registry / operations
- [ ] Docker / Compose / installer / deployment
- [ ] Documentation
- [ ] i18n
- [ ] Other

## Implementation notes

<!--
Decisions a reviewer would otherwise have to reverse-engineer: a tradeoff you
made, an approach you rejected, a constraint that forced the shape of this.
-->

## Architecture / design impact

- [ ] No architectural change
- [ ] `docs/ARCHITECTURE.md` updated, with a dated Change Log row
- [ ] Changes an existing architectural contract
- [ ] Adds a new module, provider or workflow
- [ ] Affects event-driven behaviour
- [ ] Affects module gating or an optional capability

<!--
If a contract changed, say what and why.

Worth checking before you ask for review — these are the ones that cause a PR to
be sent back:

  • Reuse the existing abstraction. A second watchlist, a second match engine or
    a second acquisition path is the failure mode this project guards against
    hardest: two systems that answer the same question WILL drift, and the one
    nobody is looking at is the one that goes wrong.
  • Shared types, permissions and event names belong in `@ultratorrent/shared`,
    so the API and the UI cannot disagree about them.
  • New endpoints are gated — `@UseGuards(JwtAuthGuard, PermissionsGuard)` plus
    `@RequirePermissions(...)`. A new capability is a module with a manifest.
  • A new domain event needs a catalogue entry. The bus REFUSES an unregistered
    event at publish time, and a test asserts every key in `DOMAIN_EVENTS` has a
    definition — so a missing entry is a silent no-op, not an error.
-->

## Database / migration impact

- [ ] No database change
- [ ] `prisma/schema.prisma` changed
- [ ] Migration added
- [ ] Backfill or data migration required
- [ ] Verified against existing data
- [ ] Rollback implications considered

**Migration notes:**

<!--
Schema changes, defaults, indexes, uniqueness, backfill, upgrade impact.

Two things specific to this repository:

  • Migrations run at CONTAINER START — the backend image is
    `prisma migrate deploy && node dist/main.js`. A migration that fails does not
    fail a deploy step; it crash-loops the backend. Test it against a database
    with real data in it, not only an empty one.
  • PostgreSQL treats NULLs as DISTINCT in a unique constraint, so a "unique when
    present" rule needs a partial unique index rather than a plain one.
-->

## API / compatibility

- [ ] No public API change
- [ ] Backward-compatible change
- [ ] **Breaking** API change
- [ ] Request or response shape changed
- [ ] New endpoint
- [ ] Existing endpoint behaviour changed

<!-- If breaking: what breaks, and what an existing client has to do about it. -->

## Security / RBAC

- [ ] No security impact
- [ ] Authentication behaviour changed
- [ ] Authorization / RBAC changed
- [ ] Permission checks added or updated
- [ ] Secret handling changed
- [ ] Outbound network or provider access changed
- [ ] Input, path or URL validation changed

<!--
See docs/SECURITY.md.

If this is remediation for a privately reported vulnerability, keep the details
out of this description — a public PR discloses just as effectively as a public
issue does. Reference the private report instead.
-->

## Internationalization

- [ ] No user-facing strings changed
- [ ] `en-US` updated
- [ ] `es-PR` updated
- [ ] Parity verified (`apps/frontend/src/i18n/i18n.test.ts`)

## Testing

<!--
What you actually ran and what you verified by hand. For a bug fix, the useful
sentence is how you confirmed it failed before the change and passes after it.
-->

- [ ] Unit tests added or updated
- [ ] Regression test covering the reported bug
- [ ] Existing suite passes (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] Backend typecheck passes (`npx tsc --noEmit -p apps/backend/tsconfig.json`)
- [ ] Frontend typecheck passes (`cd apps/frontend && npx tsc`)
- [ ] Build passes (`npm run build`)
- [ ] Migration applied against a database with existing data
- [ ] Docker / Compose starts cleanly
- [ ] Manual verification

<!--
The two typechecks are separate on purpose: the root `--noEmit` does NOT enforce
`noUnusedLocals`, and the production frontend build does — so a PR can be green
locally and fail the image build.

A fresh build and boot is the only thing that catches NestJS dependency-injection
and module-wiring errors: they throw at bootstrap, and a stale `dist/` hides them.
-->

**Commands run:**

```text
npm run lint
npm test
npm run build
```

## UI evidence

<!--
Screenshots or a short recording for anything visual — before and after where it
helps. Include the narrow viewport too if layout changed.

Check them before uploading: a capture of almost any UltraTorrent screen contains
your library, and a settings page may contain an API key or a tracker URL.
-->

## Breaking changes

- [ ] None
- [ ] Yes — described below

<!-- What breaks, who notices, and the upgrade path. -->

## Before requesting review

- [ ] Scoped to one logical change
- [ ] Conventional commit messages (`feat(engine): …`, `fix(discovery): …`)
- [ ] Changeset included for a user-facing change —
      `npm run changeset:add -- --level <patch|minor|major> --summary "…"`
      <!-- fixed it → patch · added to it → minor · broke or removed it → major.
           Docs-only and tooling-only changes need none. -->
- [ ] Documentation updated where behaviour changed
- [ ] No secrets, credentials, tokens, private URLs or personal data in the code,
      tests, fixtures, logs or screenshots
- [ ] CLA signed — the bot comments on your first PR and tells you the exact
      phrase to reply with
