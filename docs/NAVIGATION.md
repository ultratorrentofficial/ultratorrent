# Navigation & Application Shell

This document describes UltraTorrent's sidebar information architecture (IA),
how menu visibility is decided, the platform-version surfaces, and how to extend
the menu safely.

## Source of truth

The navigation is **code-defined**, not database-seeded. There is no `Menu`
table, no Prisma menu seed, and no migration for menu changes — a new
installation gets the current IA simply by running the shipped frontend bundle.
"Updating the menu seed" therefore means editing one file and shipping it:

- **`apps/frontend/src/components/layout/navigation.ts`** — the single
  `NAV_GROUPS` array (typed `NavGroup[]`), plus `visibleGroups()` and
  `isItemActive()`.
- **`apps/frontend/src/components/layout/AppShell.tsx`** — renders the grouped
  sidebar, the collapsible rail, the top bar, the version badge, and the user
  menu.
- **`apps/frontend/src/components/layout/Breadcrumbs.tsx`** — derives the
  top-bar breadcrumb trail from `NAV_GROUPS`.

> Module manifests (`apps/backend/.../manifests.ts`) also carry a `menu` field.
> It is **not** consumed by the sidebar today; the frontend IA is authoritative.
> If you add a nav entry, add it to `navigation.ts` (not only the manifest).

## Group structure

`NAV_GROUPS` is an ordered list of titled groups:

| Group | Contains |
|-------|----------|
| Overview | Dashboard |
| Torrents | All Torrents + `?state=` sub-views (Downloading/Seeding/Completed/Paused/Errors) |
| Automation | RSS Feeds, Automation |
| Files & Media | File Manager, Media Renamer, Media Servers, Media Acquisition, Release Scoring |
| Infrastructure | Engines, Multi-Server, Node Agent |
| Fleet | Overview, Nodes, Node Groups, Policies, Activity, Alerts, Central Backups, Central Updates |
| Business | Customers, Provisioning, Billing |
| Analytics | Analytics |
| Administration | Users, Modules, License, UPLM Export, White Label, Settings |
| System | Audit Log |

A group header is rendered only when at least one of its items is visible.

## Visibility: RBAC + module gating

Each `NavItem` may declare:

- `permission?: Permission` — the user must hold it (RBAC).
- `module?: string` — the module must be enabled (license/enablement).

`visibleGroups(hasPermission, isEnabled)` keeps an item when **both** gates pass
(absent gate = pass) and then drops any group left with no items. This is how
RBAC and licensing collapse the menu. Visibility is a UI convenience only — the
server still enforces via `ProtectedRoute`/`ModuleRoute` on the route and RBAC +
`ModuleGuard` on the API. Never rely on a hidden menu item for security.

## Active state

`NavLink` matches on pathname only, which would light up every `/torrents?state=…`
entry at once. `isItemActive(item, pathname, search)` is query-aware:

- An item with a `?state=` query is active only when the current `state` param
  matches.
- The base `/torrents` ("All Torrents", `end`) is active only with **no** state
  filter.
- Other `end` items match exactly; non-`end` items match as a path prefix (so a
  detail route like `/fleet/nodes/:id` keeps "Nodes" active).

## Breadcrumbs

`crumbsFor(pathname)` matches the path against `NAV_GROUPS` (longest prefix) to
produce `Group › Item [› Detail]`. Detail routes not present in the nav
(`/account`, `/rss/rules/:id`, `/fleet/nodes/:id`, `/customers/:id`) are mapped
in `DETAIL_LABELS`.

## Platform version

The version is read from the public `GET /api/system/version` (never hardcoded;
the endpoint's value flows from `version.json` → `VERSION`). It surfaces via:

- `hooks/useVersion.ts` — cached TanStack Query hook.
- Sidebar footer badge and the user menu (both open the About dialog).
- `components/AboutDialog.tsx` — product, version, edition, API version, build
  time, commit, and runtime.

## Adding or extending a nav item

1. Ensure the destination **route exists** in `App.tsx` (with its
   `ProtectedRoute` permission and, for premium/enterprise, `ModuleRoute`).
2. Add a `NavItem` to the right group in `navigation.ts` with a `lucide-react`
   `icon`, and the matching `permission` and/or `module` gates.
3. If it is a detail route that should show a breadcrumb tail, add an entry to
   `DETAIL_LABELS` in `Breadcrumbs.tsx`.
4. Update the tests in `navigation.test.ts` / `Breadcrumbs.test.ts` if you
   change group membership or matching behavior, then run `npm test`.

Do not add an entry whose route does not exist — the menu must contain no dead
links.
