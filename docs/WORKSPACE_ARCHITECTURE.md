# Workspace Architecture

How UltraTorrent's navigation works now: a **platform of Workspaces**. This is the
authoritative reference for the gen-2 shell. For the review that motivated it see
[NAVIGATION_ARCHITECTURE_REVIEW.md](NAVIGATION_ARCHITECTURE_REVIEW.md); for the low-level
nav model see [NAVIGATION.md](NAVIGATION.md); for how to add navigation see
[NAVIGATION_GUIDELINES.md](NAVIGATION_GUIDELINES.md) and
[MENU_STANDARDS.md](MENU_STANDARDS.md).

---

## The idea

UltraTorrent is not one application with one sidebar. It is **one platform containing
several Workspaces**, each of which behaves like its own application while remaining part
of the platform. The global navigation only ever lists Workspaces — it never grows as
modules are added, so the platform can scale to hundreds of modules without the nav
becoming a wall of links.

```
┌──────┬───────────────────────────┬─────────────────────────────┐
│ Rail │  Active-workspace sidebar │  Top bar (breadcrumbs · ⌘K) │
│ (9)  │  (that workspace only)    ├─────────────────────────────┤
│  🏠  │  ▸ Overview               │                             │
│  📥  │    Libraries              │   <page content / Outlet>   │
│ ▸🎬  │    Media Browser          │                             │
│  🤖  │    Duplicate Center       │                             │
│  📊  │    Subtitles ▸            │                             │
│  📁  │    Rename Engine          │                             │
│  🏗  │    Jobs                   │                             │
│  👤  │    Settings               │                             │
│  ⚙  │                           │                             │
│  ⬤  │                           │                             │  ← user menu
└──────┴───────────────────────────┴─────────────────────────────┘
```

Selecting a workspace **replaces** the sidebar with that workspace's own navigation and
opens its Overview. The rail stays; everything else is contextual to the current
workspace.

---

## The nine Workspaces

The global rail is fixed, in this order (`NAV_DOMAINS` in `navigation.ts`):

| # | Workspace | It answers | Primary contents |
|---|-----------|-----------|------------------|
| 1 | 🏠 **Dashboard** | "What's happening right now?" | Platform Overview, global Search |
| 2 | 📥 **Downloads** | "Get me the content." | Torrents, RSS, Release Scoring, Acquisition Intelligence |
| 3 | 🎬 **Media** | "Organize what I have." | Libraries, Browser, Duplicate Center, Subtitles, Rename, Jobs, Settings |
| 4 | 🤖 **Automation** | "Do things for me." | Rules, Notification Center |
| 5 | 📊 **Analytics** | "What was watched / is it healthy?" | Media-Server Analytics (Live, History, Reports, Newsletters, Import, Connections) |
| 6 | 📁 **Files** | "Work with the raw files." | File Manager |
| 7 | 🏗 **Infrastructure** | "The systems I connect to." | Engines, Indexers, Prowlarr |
| 8 | 👤 **Administration** | "People & policy." | Users, Audit |
| 9 | ⚙ **System** | "The platform itself." | Modules, Settings |

**Account is not a Workspace** — profile, password, 2FA, preferences, language, theme and
sign-out live in the **top-bar user menu**, reachable everywhere.

An empty Workspace (every child filtered out by RBAC/module state) is **dropped from the
rail entirely** — a user never sees a Workspace they can't enter.

---

## The shell

Everything below is a projection of one RBAC/module-filtered tree (`NAV_GROUPS`), so no
surface can drift from another or reveal a forbidden route. Files live in
`apps/frontend/src/components/layout/`.

### Workspace rail — `WorkspaceRail.tsx`
The only global navigation. One icon per visible workspace + a brand mark + a
hide-sidebar toggle. The active workspace shows an indicator bar; a workspace with any
badged item shows a dot. Desktop only; mobile uses `MobileDomainBar` (a bottom switcher).

- **Switch:** click an icon, or **`Ctrl/Cmd + 1…9`** (position on the rail).
- **Memory:** the last-selected workspace persists (`ut.workspace.last`) and is restored
  for routes that don't belong to any workspace (e.g. `/account` opened from the user
  menu). Resolution: `resolveActiveWorkspaceId(groups, path, search, fallback)` — a
  `/hub/:id` landing names its workspace, otherwise the active route's workspace, else
  the fallback, else the first workspace.
- **Landing:** `workspaceLanding(group)` sends a workspace to its first navigable page.

### Active-workspace sidebar — `Sidebar` (in `AppShell.tsx`)
Renders exactly one workspace. Leads with the **workspace's identity** (icon + name,
linking to its Overview); the redundant group header is suppressed (`hideHeader`). Keeps
every gen-1 capability: nested sub-menus, collapsible groups (persisted), badges,
keyboard nav, a Pinned section, and mobile drawer behaviour. A hide toggle on the rail
reclaims content width (the rail remains the compact nav).

### Top bar & breadcrumbs
Breadcrumbs root at the workspace and link it to its Overview:
`Workspace › Section › Page › Entity`. A detail page can name its entity
(`useBreadcrumbEntity`) so the trail ends with e.g. a movie's title, not "Details".

### Command palette — `Ctrl/Cmd + K`
Global fuzzy search (`lib/fuzzy.ts`) over pages, quick actions, and live entities (media
items, libraries, RSS rules, users, jobs). **Scoped search:** inside a workspace, `Tab`
(or the scope chip) limits results to that workspace. Empty query shows Pinned / Recent /
Favorites. See [NAVIGATION.md](NAVIGATION.md#command-palette).

### User menu
Top-right avatar → Account & security (`/account`), About/version, sign-out. This is where
Account lives instead of the rail.

---

## Workspace Overview — `WorkspaceOverview.tsx`

Every workspace opens on an Overview at `/hub/:workspaceId` (`ModuleHubPage`). It composes,
from the same filtered nav data:

1. **Quick Actions** — the workspace's common actions (reusing the gated palette actions,
   mapped per workspace in `workspace-config.ts`). Also appear in `Ctrl+K`.
2. **Pages** — a tile per navigable page (the `ModuleHub` grid), sub-pages as chips.
3. **Active Jobs** — a live widget of the workspace's running/queued jobs
   (`useWorkspaceJobs`, polling), for workspaces that run background work.

Because it's generated from nav data, adding a page to a workspace appears on its Overview
automatically.

---

## Jobs — the cross-subsystem aggregator

The platform runs work across five persisted job tables (`MediaProcessingJob`,
`SubtitleJob`, `MediaRenameJob`, `MediaAnalyticsImportJob`, `NotificationQueue`). The
backend **`jobs` module** exposes `GET /api/jobs`:

- Read-only; normalizes every subsystem into a uniform `JobSummary` with a canonical
  status (`queued | running | completed | failed | cancelled`).
- **RBAC-scoped per subsystem** — a caller only sees jobs of subsystems whose view
  permission they hold (super-admin sees all). Query by `subsystem`, `status`, `active`,
  `limit`.
- Job *creation and cancellation* stay on each subsystem's own module; this only reads.

Each workspace's Jobs widget requests the subsystems it owns
(`WORKSPACE_JOB_SUBSYSTEMS`); the **System** workspace sees all (the global jobs view).

---

## RBAC & module gating

Authorization is RBAC-only — there are no editions or tiers (see
[ARCHITECTURE.md](ARCHITECTURE.md) §Security). `visibleGroups(ctx)` filters the tree by
permission + module state once; the rail, sidebar, Overviews, palette, quick actions,
breadcrumbs, and jobs all consume the filtered result. Route guards (`ProtectedRoute`,
`ModuleRoute`) remain the authority — hiding is a convenience, never the enforcement.

New rule for the workspace model: **a workspace with zero visible items is pruned from the
rail** (extends gen-1's empty-group dropping to the top level).

---

## Scaling & extension

- **New module** → append one `NavContribution` to an existing workspace (see
  [NAVIGATION_GUIDELINES.md](NAVIGATION_GUIDELINES.md)). The rail never changes; the module
  appears in its workspace's sidebar, Overview tile grid, palette, and (if it declares a
  quick action / job subsystem) the workspace's Quick Actions / Jobs widget.
- **New workspace** → a rare, deliberate event: add one `NAV_DOMAINS` entry. Reserve it for
  a capability that belongs to none of the nine.
- **Plugins** → a contribution with an unknown domain lands in an auto-appended
  **Extensions** area (`EXTENSIONS_DOMAIN`), so third-party modules never touch the core
  rail.

This is intended to be the last *structural* navigation redesign the platform needs:
future growth is a data change (one contribution), not an architecture change.

---

## Performance

- The rail is a fixed nine icons (O(1)).
- The sidebar composes and renders only the **active** workspace's sub-tree.
- Badges are fetched lazily and permission-gated (`useNavBadges`).
- Palette entity providers are lazy and debounced; the jobs widget polls only while
  mounted.
- Long lists (Media Browser, Audit) virtualize.

---

## Responsiveness & accessibility

- **Desktop (lg+):** rail + active-workspace sidebar + top bar.
- **Mobile (<lg):** bottom workspace switcher (`MobileDomainBar`) + a swipe-dismissable
  drawer scoped to the active workspace.
- Semantic `<nav>` landmarks; `aria-current` on the active workspace / page; `Ctrl+1…9`
  and full palette keyboard control; `aria-keyshortcuts` on rail items; focus-visible
  rings; motion respects `prefers-reduced-motion`.

---

## Tests

`navigation.test.ts` (workspace resolution, IA invariants, no-empty-workspaces),
`nav-routes.test.ts` (no dead links), `WorkspaceRail.test.tsx`, `WorkspaceOverview.test.tsx`,
`jobs.service.spec.ts` (RBAC + normalization), `fuzzy.test.ts`, `CommandPalette.test.tsx`
(fuzzy + scoped search), `Breadcrumbs.test.ts` / `BreadcrumbContext.test.tsx`,
`MobileDomainBar.test.tsx`, `useSwipe.test.tsx`, `useNavPersonalization.test.tsx`,
`i18n.test.ts` (en-US/es-PR parity).

---

See also: [NAVIGATION.md](NAVIGATION.md) ·
[NAVIGATION_ARCHITECTURE_REVIEW.md](NAVIGATION_ARCHITECTURE_REVIEW.md) ·
[NAVIGATION_GUIDELINES.md](NAVIGATION_GUIDELINES.md) · [MENU_STANDARDS.md](MENU_STANDARDS.md) ·
[UX_GUIDELINES.md](UX_GUIDELINES.md) · [ARCHITECTURE.md](ARCHITECTURE.md)
