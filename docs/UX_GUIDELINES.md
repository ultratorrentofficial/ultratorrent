# UX Guidelines — the App Shell

How UltraTorrent's shell *behaves*: navigation state, personalization, the command
palette, breadcrumbs, responsiveness, and accessibility. These are the conventions a
new page should honour so the whole app feels like one product. For *where a feature
goes* see [MENU_GUIDELINES.md](MENU_GUIDELINES.md); for the mechanics see
[NAVIGATION.md](NAVIGATION.md).

## Principles

1. **Nothing is removed or hidden to make room.** Every redesign step preserved every
   feature and its discoverability. Consolidation means *grouping*, never dropping.
2. **One source of truth.** The sidebar, breadcrumbs, palette, module hubs, contextual
   sub-nav, and mobile domain bar are all projections of `NAV_GROUPS`. Build the next
   surface from that data too, so nothing drifts.
3. **RBAC in, always.** Every surface consumes the *already-filtered* nav, so none can
   ever reveal a route the user can't reach. Filtering happens once, in `visibleGroups`.
4. **Progressive disclosure.** Short rail → domain hub → page → sub-page. Depth is
   opt-in; the common path stays shallow.
5. **The user personalizes; we don't reshuffle.** Order is stable and predictable;
   pinned/favorites/recent adapt *per user* without moving anyone else's furniture.

## Navigation state & persistence

All persisted in `localStorage`; all degrade gracefully if storage throws.

| Concern | Key | Notes |
|---------|-----|-------|
| Rail collapsed (icon-only) | `ut.sidebar.collapsed` | Domain-switcher flyouts on hover |
| Group collapse | `ut.nav.groups.collapsed` | Active group auto-expands regardless |
| Sub-menu expand | `ut.nav.items.expanded` | Active branch auto-expands |
| Pinned / Favorites / Recent | per-user (keyed by user id) | `useNavPersonalization`; Recent capped at 8 |

**Auto-expand always wins over persisted collapse** for the branch containing the
active route — a user never lands on a page whose nav entry is hidden.

## Personalization

- **Pin** — promotes a page to a top-of-rail *Pinned* section; toggle from the rail or
  inline in the palette.
- **Favorite** — a starred set surfaced in the palette's quick-access view.
- **Recent** — the last 8 visited pages, recorded by `recordVisit`; detail routes fold
  into their parent nav entry (`activeEntryId`) so "Recent" lists pages, not URLs.

These are conveniences layered on a stable IA — they never change the order or
visibility of the base rail.

## Command palette (Ctrl/Cmd + K)

- **Empty query** → quick access: Pinned, Recent, Favorites.
- **With a query** → Pages (filtered nav) + Actions (add torrent, scan library, find
  duplicates, create RSS rule, automation rules) + live Entities (media items,
  libraries) via lazy, debounced providers.
- Keyboard-first: `↑/↓` move, `Enter` navigates/runs, `Esc` closes. Inline pin/star
  toggles. Fully localized under `shell.command.*`.
- It's the **flat escape hatch** for the whole app — the answer to "the sidebar is
  getting long" is always the palette, never a wider rail.

## Breadcrumbs

- Derived from the tree: `Group › [Parent ›] Item [› Detail]`.
- A detail page names its entity with `useBreadcrumbEntity(pathname, name)` so the
  trail ends with the real title (e.g. a movie name), scoped by pathname so a stale
  label never leaks to the next page.
- `/hub/:domainId` resolves to its domain crumb.

## Module landing hubs

Every domain has a hub at `/hub/:domainId` (`ModuleHub`): a tile per navigable page
(icon, label, description) with sub-pages as chips. It's generated from nav data, so a
new page appears automatically. Sidebar group headers and collapsed-rail domain icons
link to the hub; the chevron still toggles the group.

## Contextual sub-nav

`ContextualSubNav` shows the active domain's sibling pages as a horizontal strip under
the top bar (second row for a nested branch's children). It enables lateral movement
without the sidebar and is the primary in-page nav on mobile. It never adds a link the
sidebar lacks.

## Responsive & mobile

- **Desktop (lg+)** — persistent sidebar (expandable/collapsible), top bar with
  breadcrumbs + palette, contextual sub-nav.
- **Mobile (<lg)** — hamburger drawer (slide-in; dismiss via Esc, backdrop, or
  **left-swipe** `useSwipeToDismiss`) **plus** a fixed **bottom domain switcher**
  (`MobileDomainBar`): one tap to any domain hub, trailing *Menu* opens the full drawer.
  Content carries bottom padding so the bar never overlaps it.
- Horizontal strips (contextual sub-nav, domain bar) scroll rather than wrap; the page
  body never scrolls horizontally.
- Respect `env(safe-area-inset-bottom)` for the bottom bar.

## Accessibility

- Semantic `<nav>` landmarks with descriptive `aria-label`s.
- `aria-expanded` on group/sub-menu toggles; `aria-current="page"` on the active row,
  tab, chip, and domain.
- Focus-visible rings on every interactive element; icon-only rows carry a `title`.
- Keyboard: Esc closes drawer & palette; Enter/Arrows drive the palette.
- Touch targets on the mobile bar are ≥ 44px tall.

## When you add a surface

- Consume `useVisibleNavGroups()` / `NAV_GROUPS` — never re-derive the item list.
- Localize every string in **both** locales.
- Add a focused test (see the list in [NAVIGATION.md](NAVIGATION.md#tests)).
- Verify it degrades: empty nav, storage failure, RBAC-pruned domain, no active match.
