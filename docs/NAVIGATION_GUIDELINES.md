# Navigation Guidelines (Workspace era)

How to add or change navigation in the workspace model without eroding it. Supersedes the
domain-era [MENU_GUIDELINES.md](MENU_GUIDELINES.md) (still accurate for the underlying
registry mechanics). See [WORKSPACE_ARCHITECTURE.md](WORKSPACE_ARCHITECTURE.md) for the
model and [MENU_STANDARDS.md](MENU_STANDARDS.md) for labels/icons/badges.

## The rules

1. **A feature attaches to exactly one Workspace.** If you can't name its Workspace in one
   sentence, it's probably two features. The nine Workspaces and their remit are in
   [WORKSPACE_ARCHITECTURE.md](WORKSPACE_ARCHITECTURE.md#the-nine-workspaces).

2. **Never add a top-level entry.** The global rail is Workspaces only, fixed forever. New
   capability → a `NavContribution` into a Workspace, never a new rail icon.

3. **A new Workspace is a rare, deliberate event.** Add a `NAV_DOMAINS` entry only when a
   capability genuinely belongs to none of the nine. Expect to justify it in review.

4. **Cap a Workspace sidebar at ~7–10 primary items.** Overflow nests under a sub-module
   parent (e.g. Subtitle Intelligence, the Notification Center) or lives behind the
   Workspace Overview — not as more top-level rows.

5. **Every nav entry maps to a real route.** No dead links — enforced by
   `nav-routes.test.ts`. Sub-features that are *sections within a page* (API Keys, Root
   Paths, Metadata Providers) are not nav entries.

6. **Visibility is RBAC + module state, never editions.** Gate items with `permission`
   and/or `module`; route guards remain the authority. An item the user can't use is
   hidden; a Workspace with nothing visible is pruned from the rail.

## Adding a page to a Workspace

1. Add the route in `App.tsx` under `ProtectedRoute` (+ `ModuleRoute` if module-gated).
2. Append one `NavContribution` to `NAV_CONTRIBUTIONS` in `navigation.ts`: pick the
   `slot.domain` (the Workspace id) and an `order` (gaps of 10), and give the `item` a
   stable `id`, a distinct icon, `permission`/`module` gates, and a `descriptionKey`.
3. Add the label + description to **both** `en-US/nav.json` and `es-PR/nav.json`
   (`items` / `descriptions`) — parity is test-enforced.
4. Detail routes: extend `DETAIL_LABELS` in `Breadcrumbs.tsx`; for a rich detail page call
   `useBreadcrumbEntity(pathname, entity?.name)`.

No extra wiring is needed for the Overview tile, contextual sidebar, breadcrumb, palette
page result, or mobile switcher — all are composed from the contribution.

## Wiring a Quick Action

Add a gated `PaletteAction` in `usePaletteProviders.ts` with a `scope` (the Workspace id),
then list its `id` under that Workspace in `WORKSPACE_ACTION_IDS` (`workspace-config.ts`).
It then appears both on the Workspace Overview and in `Ctrl+K` (scoped search included).

## Surfacing jobs

If a feature runs background work in one of the five job tables, it already appears in
`GET /api/jobs`. To show it on a Workspace's Overview, list the subsystem under that
Workspace in `WORKSPACE_JOB_SUBSYSTEMS`. New job *kinds* within an existing table need no
change; a genuinely new job table needs a case in `JobsService.loadSubsystem`.

## Adding a Workspace (rare)

1. Add a `NAV_DOMAINS` entry (id, title, distinct icon, `order`).
2. Move/registers contributions into it.
3. Add its title to `nav.json` `groups` (both locales).
4. If it runs jobs / has quick actions, add `workspace-config.ts` entries.
5. Update `navigation.test.ts` IA assertions and this doc's Workspace table.

## Checklist

- [ ] One Workspace chosen; item added via a single contribution (or nested under a
      parent's `children`).
- [ ] Workspace sidebar still ≤ ~10 primary items.
- [ ] Stable `id`, distinct icon, gates, `descriptionKey`.
- [ ] Labels/description in both locales.
- [ ] Route exists (`nav-routes.test.ts` green); detail routes handled.
- [ ] Quick action / job subsystem wired if applicable.
