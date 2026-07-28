# UX Guidelines — the App Shell

How UltraTorrent's shell *behaves*: navigation state, personalization, the command
palette, breadcrumbs, responsiveness, and accessibility. These are the conventions a
new page should honour so the whole app feels like one product. For *where a feature
goes* see [MENU_GUIDELINES.md](MENU_GUIDELINES.md); for the mechanics see
[NAVIGATION.md](NAVIGATION.md).

> **Now the Workspace model.** The shell has evolved from one sidebar-of-domains into a
> **platform of Workspaces**: a fixed global rail lists only the nine Workspaces, and
> selecting one replaces the sidebar with that Workspace's own navigation and Overview.
> The principles below still hold; the canonical shell reference is
> **[WORKSPACE_ARCHITECTURE.md](WORKSPACE_ARCHITECTURE.md)**, with conventions in
> [MENU_STANDARDS.md](MENU_STANDARDS.md).

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

## Notification surfaces

Notifications answer two questions and no more: *which events do I want*, and
*where do I receive them*. That constraint is a UX rule, not only an
architectural one — the system this replaced failed because its UI asked users to
reason about rules, audiences, routing precedence and templates.

- **The Events table is the whole configuration.** One row per event, one switch
  per channel. No per-row destination picker, no priority, no schedule.
- **Never offer a control the platform cannot honour.** A channel column is
  disabled until that channel can actually deliver, and the page says *why*
  ("Not connected", "no email relay configured") rather than failing at test time.
- **Never show a destination.** Masks only. An unverified connection must not look
  finished — it carries its own hint about what to do next.
- **The rich card is the message.** Where a card renders, the plain title line is
  suppressed rather than duplicated; severity, category and read state stay,
  because those are inbox concerns the card knows nothing about.
- **Accent is meaning, not decoration.** `stopped` is coral, `error` is red, and
  they are deliberately different — playback ending is not a failure. Never convey
  state by colour alone: every state also has an icon and an accessible label.
- **Personal settings live under Account**, reached from the user menu. They are
  not a rail entry, and there is no administrative screen that edits another
  person's preferences.

## Actions (CAMA)

Actions follow the same rule as navigation: **one registry, many projections**.
A screen never hardcodes a toolbar — it asks what applies to the current selection.
Mechanics are in [CAMA.md](CAMA.md); the conventions a surface must honour:

- **Never build an action list by hand.** Render `<ActionBar>` (toolbars) or
  `<ActionMenu>` (row clusters and kebabs) from `useContextActions()`. Both take the
  same contract, so a surface can switch shape without changing anything else.
- **A surface supplies handlers, not decisions.** What an action *is*, who may run it
  and when it applies are declared server-side. The surface only says how its ids run.
- **An action with no handler is never rendered.** The registry is platform-wide and
  will legitimately resolve actions your screen has not wired up; a button that does
  nothing reads as a broken feature, which is worse than the action living elsewhere.
- **Entities advertise their own state.** A row carries `capabilities` (`cancel`,
  `editable`, `ignorable`); an action requiring one is offered only when **every**
  selected entity advertises it — never applied to the qualifying subset.
- **Declare against a real endpoint.** Declaring an action is one object literal, which
  makes it cheap to declare one nothing can serve. `action-endpoint.spec.ts` enforces this.
- **Hiding is the default; disabling is a choice.** Hide what is irrelevant. Disable —
  with the reason in the title — when absence would read as a lost feature, as the
  Media Manager does for a locked item.

### Operations Mode vs "nothing is hidden"

Principle 1 says nothing is removed to make room, and Operations Mode hides advanced
actions. These do not conflict, and the distinction is the point:

- **Withholding** an action the user cannot run, or that cannot apply to what they
  selected, is honesty. It was never available.
- **Deferring** an action behind Operations Mode is *progressive disclosure*
  (principle 4), not removal. It stays permitted, stays in the command palette, and
  stays one toggle away — it is simply not in front of someone who came to look at a
  show rather than maintain one.

What would violate principle 1 is dropping a capability because a surface was
redesigned. CAMA does the opposite: it makes every declared action reachable from
every surface that wires it, instead of only the screen someone remembered to add it to.

## Times

Every displayed moment goes through `lib/format.ts` — `formatDateTime`,
`formatDate`, `formatTime`, `formatRelativeTime`. Never `toLocaleDateString()`,
`toLocaleString()` or `new Intl.DateTimeFormat` directly.

The reason is not tidiness. Each user has a **display timezone** on their profile
(`User.timezone`, null = follow the device), and the helpers are what apply it.
A raw call silently follows the *browser* instead, which looks correct on your own
machine and is wrong for anyone who set a zone.

This is enforced, not trusted: `src/lib/format-usage.test.ts` fails on a raw call
outside a short allow-list. It exists because the timezone feature shipped with
the helpers made zone-aware and **14 call sites still bypassing them** — including
the notification inbox, the surface the feature was asked for. A user reported it;
no gate caught it. If you need a shape the helpers do not offer, add it to
`format.ts` rather than reaching past it.

## When you add a surface

- Consume `useVisibleNavGroups()` / `NAV_GROUPS` — never re-derive the item list.
- Render actions from `useContextActions()` — never a hand-built toolbar.
- Localize every string in **both** locales, and format every time through `format.ts`.
- Add a focused test (see the list in [NAVIGATION.md](NAVIGATION.md#tests)).
- Verify it degrades: empty nav, storage failure, RBAC-pruned domain, no active match,
  and an **empty or unreachable action catalogue** (say so; do not render blank chrome).
