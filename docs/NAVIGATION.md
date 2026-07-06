# Navigation & App Shell

UltraTorrent's UI navigation is a single **declarative, typed tree** consumed by
the sidebar, breadcrumbs, and command palette. There are no editions or license
tiers — visibility is controlled **only** by RBAC permissions and module
enablement. The server remains authoritative; UI hiding is a convenience layer.

## Source of truth

`apps/frontend/src/components/layout/navigation.ts`

- `NAV_GROUPS: NavGroup[]` — the information architecture (groups → items →
  optional nested children). Every `to` maps to a real route in `App.tsx`.
- `NavGroup` — `{ id, title, icon, items }`.
- `NavItem` — `{ id, label, icon, to?, action?, children?, permission?, module?,
  end?, adminOnly?, superAdminOnly?, descriptionKey? }`.
- `visibleGroups(ctx)` — filters the tree for the current user.
- `flattenForSearch(groups)` — flattens (filtered) groups into command-palette entries.
- `isItemActive` / `isBranchActive` — query-aware active + branch-active checks.
- `tNav(t, section, english)` — resolves a canonical-English key to a localized string.

All labels are **canonical-English keys**, never hardcoded display text. They are
translated at render time via the `nav` i18n namespace (`groups`, `items`,
`descriptions`, `details`). Adding a label without a matching `nav` key fails the
`i18n.test.ts` nav-coverage test.

## Navigation hierarchy

| Group | Entries (→ route) |
|-------|-------------------|
| **Overview** | Dashboard → `/dashboard` · Search → command palette |
| **Downloads** | Torrents → `/torrents` (sub-menu: Downloading/Seeding/Completed/Paused/Errors) · Engines → `/engines` |
| **RSS & Acquisition** | RSS Feeds → `/rss` · Release Scoring → `/release-scoring` · Acquisition Intelligence → `/media-acquisition` (sub-menu: Smart Download, Missing Episodes, Decision Simulator) |
| **Media Management** | Media Dashboard → `/media` · Media Items → `/media/items` · Libraries → `/media/libraries` · Unmatched Media → `/media/unmatched` · Duplicates → `/media/duplicates` · Rename Engine → `/media/rename-preview` · IMDb Settings → `/media/settings/imdb` · Media Settings → `/media/settings` |
| **Media Server Analytics** *(module-gated)* | Analytics Dashboard → `/media-server-analytics` · Live Activity → `/live` · Recently Added → `/recently-added` · Watch History → `/watch-history` · Analytics Reports → `/reports` · Newsletters → `/newsletters` · Import Analytics → `/import` · Server Connections → `/connections` |
| **Automation** | Automation Rules → `/automation` |
| **Files** | File Manager → `/files` |
| **Administration** | Users → `/users` · Modules → `/modules` · Settings → `/settings` · Audit Log → `/audit` |
| **Account** | Profile → `/account` |

### Spec sub-features that are page sections (not separate routes)

Some finer sub-features live **inside** a page rather than as standalone routes,
so they appear under their page entry rather than as dead links:

- **Media Settings** hosts Metadata Providers, Artwork preferences, Subtitle
  preferences, NFO tooling and Media Server Integrations.
- **Automation Rules** hosts Triggers & Actions and Job History.
- **File Manager** hosts Root Paths and Trash / Cleanup.
- **Settings** hosts API Keys, Webhooks, Integrations, Notifications and system
  health surfaces.
- **Users** hosts Roles & Permissions; **Profile** hosts Change Password,
  Two-Factor Authentication and Sessions. **Language** and **Sign out** live in
  the top-bar user menu.

When any of these graduates to its own route, add a `NavItem` (ideally a nested
child under the page's entry) plus its `nav` keys.

## Behavior

- **Collapsible groups** — each top-level group header toggles its items;
  collapse state persists in `localStorage` (`ut.nav.groups.collapsed`). A group
  containing the active route **auto-expands** regardless.
- **Collapsible sub-menus** — items with `children` expand/collapse (chevron);
  state persists (`ut.nav.items.expanded`) and the active branch auto-expands.
- **Icon-only rail** — the sidebar collapses to icons (`ut.sidebar.collapsed`);
  every row shows a `title` tooltip. Nested children are reached by expanding the rail.
- **Mobile** — a hamburger opens a slide-in drawer; navigating closes it; Escape
  and backdrop-click dismiss it.
- **Active highlighting** — exact for `end` items and query-param views
  (`/torrents?state=…`), prefix for detail pages (`/media/items/:id` keeps
  *Media Items* active). Parents highlight when a descendant is active.
- **Breadcrumbs** — derived from the tree: `Group › [Parent ›] Item [› Detail]`.

## Command palette (Ctrl/Cmd + K)

`apps/frontend/src/components/layout/CommandPalette.tsx`

- Opens with **Ctrl+K / Cmd+K**, the top-bar Search button, or the Overview →
  Search entry.
- Searches the **already-filtered** navigation entries (RBAC + module aware), so
  it can never surface a route the user isn't allowed to see.
- Matches label, group and description; `↑/↓` move, `Enter` navigates, `Esc`
  closes; includes an empty state. Fully localized (`shell.command.*`).

## RBAC & module visibility rules

`visibleGroups(ctx)` where `ctx = { hasPermission, isEnabled, canManageModules, isSuperAdmin }`:

1. An item with `permission` is hidden unless the user holds it.
2. An item with `module` is hidden when the module is **disabled** — *unless* the
   user can manage modules (`modules.manage`), so admins can still reach the
   locked-module page.
3. `adminOnly` requires module-management; `superAdminOnly` requires the super-admin role.
4. A parent with no visible children **and** no own destination is dropped; a
   group with no visible items is dropped (no bare headers).
5. Module enablement is **never** authorization. Route guards (`ProtectedRoute`
   for permissions, `ModuleRoute` for enablement) remain the enforcement point;
   the palette and breadcrumbs only ever show already-filtered entries.

## Adding navigation for a new module

1. Add the route(s) in `App.tsx`, wrapped in `ProtectedRoute` (permission) and,
   for module-gated features, `ModuleRoute`.
2. Add a `NavGroup` or `NavItem` in `navigation.ts` with `permission` and/or
   `module` gates, a stable `id`, an `icon`, and a `descriptionKey`.
3. Add the label/description keys to **both** `en-US/nav.json` and
   `es-PR/nav.json` (`groups` / `items` / `descriptions`) — parity is enforced by tests.
4. If it introduces detail routes, extend `DETAIL_LABELS` in `Breadcrumbs.tsx`.

## Accessibility

Semantic `<nav>` landmarks; `aria-expanded` on group/sub-menu toggles;
`aria-current="page"` on active rows; focus-visible rings throughout; icon-rail
tooltips; Escape closes the drawer and palette; Enter/Arrow keys drive the palette.

## Tests

`navigation.test.ts` (tree filtering, module-manager visibility, child pruning,
active/branch matching, search flattening), `Breadcrumbs.test.ts` (nested +
detail trails), `CommandPalette.test.tsx` (filtering, empty state, keyboard),
`i18n.test.ts` (en-US/es-PR key parity + nav-label coverage).
