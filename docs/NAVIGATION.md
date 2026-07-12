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
- `NavItem` — `{ id, label, icon, to?, action?, external?, href?, children?,
  permission?, module?, end?, adminOnly?, superAdminOnly?, descriptionKey? }`.
  `external` marks an off-app link (the Prowlarr entry); `href` is its
  runtime-resolved URL.
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
| **Downloads** | Torrents → `/torrents` (sub-menu: Downloading/Seeding/Completed/Paused/Errors) · Engines → `/engines` · Indexers → `/indexers` |
| **RSS & Acquisition** | RSS Feeds → `/rss` · Release Scoring → `/release-scoring` · Acquisition Intelligence → `/media-acquisition` (sub-menu: Smart Download, Missing Episodes, Decision Simulator) · **Prowlarr** *(external link — shown only when the [Prowlarr integration](PROWLARR.md) is enabled and the user has `integrations.prowlarr.open`; opens the configured public URL in a new tab)* |
| **Media Management** | Media Dashboard → `/media` · Media Items → `/media/items` · Libraries → `/media/libraries` · Unmatched Media → `/media/unmatched` · Duplicates → `/media/duplicates` · Rename Engine → `/media/rename-preview` · IMDb Settings → `/media/settings/imdb` · Media Settings → `/media/settings` |
| **Media Server Analytics** *(module-gated)* | Analytics Dashboard → `/media-server-analytics` · Live Activity → `/media-server-analytics/live` · Recently Added → `/media-server-analytics/recently-added` · Watch History → `/media-server-analytics/watch-history` · Analytics Reports → `/media-server-analytics/reports` · Newsletters → `/media-server-analytics/newsletters` · Import Analytics → `/media-server-analytics/import` · Server Connections → `/media-server-analytics/connections` |
| **Automation** | Automation Rules → `/automation` · Notification Center → `/notifications` · Notification Channels → `/notifications/channels` · Notification Rules → `/notifications/rules` · Notification Templates → `/notifications/templates` · Notification Recipients → `/notifications/recipients` · Recipient Groups → `/notifications/groups` · Delivery History → `/notifications/history` · Queue Monitor → `/notifications/queue` · Provider Health → `/notifications/provider-health` · Notification Preferences → `/notifications/preferences` · Notification Settings → `/notifications/settings` |
| **Files** | File Manager → `/files` |
| **Administration** | Users → `/users` · Modules → `/modules` · Settings → `/settings` · Audit Log → `/audit` |
| **Account** | Profile → `/account` |

### Spec sub-features that are page sections (not separate routes)

Some finer sub-features live **inside** a page rather than as standalone routes,
so they appear under their page entry rather than as dead links:

- **Media Settings** hosts Metadata Providers, Artwork preferences, Subtitle
  preferences and Media Server Integrations. (**NFO generation** is *not* here —
  it lives on the media-item detail page, `/media/items/:id`.)
- **Automation Rules** hosts Triggers & Actions (the rule editor) and Job History
  (the per-rule logs dialog).
- **File Manager** hosts Trash and the Cleanup Wizard.
- **Settings** hosts the **Default Root Path** section (its own validated, audited
  `PUT /api/files/root` route), the Prowlarr integration card, the Media Server
  Analytics email + newsletter-image cards, and the generic key/value settings
  list.
- **Users** hosts Roles & Permissions (role assignment); **Profile** hosts Change
  Password and Two-Factor Authentication. **Language** and **Sign out** live in
  the top-bar user menu.

> **No UI, despite a backend:** **API Keys** have a working REST surface
> (`/api/api-keys`) but **no frontend page or section at all** — and the keys they
> mint cannot authenticate a request anyway (see
> [SECURITY.md](SECURITY.md#api-keys-are-not-a-credential-yet)). There is likewise
> no Webhooks page and no Sessions section on Profile. Do not link to them from
> the nav until they exist.

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
