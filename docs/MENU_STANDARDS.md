# Menu Standards

The visual and textual conventions for UltraTorrent navigation — labels, icons, badges,
ordering, and visual hierarchy. Keeps every Workspace feeling like one product. See
[NAVIGATION_GUIDELINES.md](NAVIGATION_GUIDELINES.md) for where things go and
[WORKSPACE_ARCHITECTURE.md](WORKSPACE_ARCHITECTURE.md) for the model.

## Labels

- **Canonical-English keys**, never hardcoded display text — resolved at render through
  `tNav(t, section, english)` against the `nav` namespace (`groups` / `items` /
  `descriptions` / `details`). Every label ships in **both** `en-US` and `es-PR`
  (test-enforced parity).
- Prefer a **task word the user would say** over the internal module name — "Duplicates",
  not "Media Dedup Service".
- Title Case for items and Workspaces. Keep it to 1–3 words; the description carries detail.
- Every top-level item has a `descriptionKey` — it powers the Overview tile subtitle and
  the palette result description.

## Icons

- One icon per Workspace and per item, from **`lucide-react`**, visually distinct from its
  siblings.
- **Workspace rail icons** (fixed): Dashboard `LayoutDashboard` · Downloads `Download` ·
  Media `Clapperboard` · Automation `Bot` · Analytics `BarChart3` · Files `FolderTree` ·
  Infrastructure `Server` · Administration `ShieldCheck` · System `Cpu`. These are the
  platform's landmarks — change them only with intent (users navigate by them).
- Icon language: pick the icon for the **noun/task**, not the technology (a library is
  `Library`, not a database cylinder). Reuse the same icon for the same concept across
  Workspaces (e.g. `History` for any history view, `SlidersHorizontal` for any settings).
- Size: `h-5 w-5` on the rail, `h-4 w-4` in sidebar rows; `shrink-0` always.

## Badges

Badges are permission/module-gated (`useNavBadges`) and render as an aggregate **dot** on
a rail icon and a **count** on the sidebar row. Tones:

| Tone | Use for |
|------|---------|
| `primary` (default) | Counts needing attention but not urgent — jobs running, RSS matches, unread |
| `warning` | Degraded/attention — provider warnings, storage nearing full, updates available |
| `danger` | Errors — failed jobs/deliveries, storage alerts |

Keep badges truthful and rare; a permanently-badged item is noise. Counts cap at `99+`.

## Ordering

- **Rail:** the fixed Workspace order (Dashboard → System); Account is not on the rail.
- **Within a Workspace sidebar:** Overview first; then primary pages by task frequency;
  sub-modules (with `children`) grouped; **Jobs** and **Settings** last. Contribution
  `order` values leave gaps of 10 so inserts don't renumber neighbours.
- **Destructive / administrative** items sit apart and read distinctly (color + a confirm
  step) — never adjacent to a routine action they could be mis-clicked for.

## Visual hierarchy

Communicated by placement and type, not decoration:

- **Workspace identity** — icon + name at the top of its sidebar (the "you are here").
- **Primary pages** — regular weight; **Overview** pinned top; **Jobs/Settings** pinned
  bottom.
- **Active** — `aria-current` + an accent (rail indicator bar, sidebar highlight,
  breadcrumb bold-final).
- **Nested** — indentation + a collapse chevron; the active branch auto-expands.

## Motion

Subtle only. A cross-fade on Workspace switch; sidebar/drawer slides; chevron rotation. All
respect `prefers-reduced-motion` (`motion-reduce:animate-none`). No motion that blocks
interaction or repeats.

## Accessibility

Semantic `<nav>` landmarks with `aria-label`; `aria-current="page"` on the active
Workspace/page/tab; `aria-expanded` on toggles; `aria-keyshortcuts` for `Ctrl+1…9`;
focus-visible rings on every interactive element; icon-only controls carry a `title`;
touch targets ≥ 44px on mobile bars.
