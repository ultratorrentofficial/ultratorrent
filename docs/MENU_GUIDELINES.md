# Menu & Information-Architecture Guidelines

How to decide **where a feature goes** in UltraTorrent's navigation, and how to add
one without eroding the structure. The rail is a finite, shared resource; these rules
keep it short and predictable as the platform grows. For *how the shell behaves*
(personalization, palette, breadcrumbs, mobile) see [UX_GUIDELINES.md](UX_GUIDELINES.md);
for the mechanics see [NAVIGATION.md](NAVIGATION.md).

## The domains

The top level is a fixed, ordered set of **domains** (`NAV_DOMAINS`). Every feature
belongs to exactly one:

| Domain | It answers… | Examples |
|--------|-------------|----------|
| **Dashboard** | "What's the state of my system right now?" | Overview, global Search |
| **Downloads** | "Get me the content." | Torrents, RSS, Acquisition Intelligence, Indexers |
| **Media** | "Organize what I have." | Media Manager, Subtitles, duplicates, artwork/NFO |
| **Automation** | "Do things for me." | Automation Rules, Notification Center |
| **Files** | "Work with the raw files." | File browser, trash & recovery |
| **Monitoring** | "Is it healthy / what happened?" | Jobs, logs, analytics, media-server analytics |
| **Administration** | "Configure the platform." | Users, RBAC, modules, integrations, settings |
| **Account** | "My own profile & session." | Profile, preferences, sign-out |

If you can't say which domain a feature belongs to in one sentence, the feature is
probably two features.

## The rules

1. **New capabilities attach to an existing domain — never a new top-level group.**
   A new domain is a rare, deliberate event: add one to `NAV_DOMAINS` only when a
   capability genuinely belongs to none of the above. Ten top-level groups was the
   problem the redesign fixed; don't reintroduce it.

2. **Cap a domain at ~7 primary items.** Beyond that, the overflow lives *behind the
   domain's landing hub* (`/hub/:domainId`) and/or nests under a parent item, not as
   more top-level rows. The hub is the pressure-release valve, not the sidebar.

3. **Nest a multi-page sub-module under one parent.** A sub-module with several pages
   (Subtitles, Notifications, Media-Server Analytics) is **one** parent item whose own
   `to` is its dashboard, with the pages as `children`. Don't scatter its pages across
   the domain.

4. **Place by contribution, not by hand-ordering.** Append one `NavContribution`
   (`{ slot: { domain, order }, item }`) to `NAV_CONTRIBUTIONS`. Orders leave gaps of
   10 so an insert never renumbers neighbours. A plugin with an unknown domain falls
   back to the auto-appended **Extensions** area — it can never break the core rail.

5. **The command palette is the flat escape hatch.** As feature count grows, *search*
   absorbs the long tail. Never widen the sidebar to make a rarely-used page one click
   closer — pin/favorite/palette already cover that per user.

6. **Sub-features that are page sections are not nav entries.** Metadata Providers,
   Artwork, API Keys, Root Paths, Triggers & Actions live *inside* a page, not as dead
   links. A nav entry must map to a real, standalone route in `App.tsx`.

## Naming & icons

- Labels are **canonical-English keys** (never hardcoded display text), translated at
  render via the `nav` namespace. Add every label to **both** `en-US/nav.json` and
  `es-PR/nav.json` (`groups` / `items` / `descriptions`) — parity is test-enforced.
- Prefer a **task verb or noun the user would say**, not the internal module name
  ("Duplicates", not "Media Dedup Service").
- One icon per item, from `lucide-react`, visually distinct from its siblings.
- Give every top-level item a `descriptionKey` — it powers the hub tile subtitle and
  the palette result description.

## Visibility is RBAC + modules, never editions

There are no license tiers. An item is shown only when the user holds its `permission`
and its `module` is enabled (admins with `modules.manage` still see disabled-module
pages so they can turn them on). Hiding is a convenience; route guards
(`ProtectedRoute`, `ModuleRoute`) remain the authority. Never gate a menu entry on
anything but permission + module state.

## Checklist for a new page

- [ ] Route added in `App.tsx` under the right guard(s).
- [ ] Exactly one domain chosen; item added via a single `NavContribution` (or nested
      under an existing parent's `children`).
- [ ] Domain still ≤ ~7 primary items (else nest or lean on the hub).
- [ ] Stable `id`, distinct icon, `permission`/`module` gates, `descriptionKey`.
- [ ] Labels + description in **both** locale `nav.json` files.
- [ ] Detail routes: `DETAIL_LABELS` extended; rich detail pages call
      `useBreadcrumbEntity`.
- [ ] `navigation.test.ts` still green (add a case if the item has non-trivial gating).
