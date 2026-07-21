---
"ultratorrent": minor
---

Navigation redesign — Phase 3: sidebar features (collapse-all, badges, domain-switcher flyout).

Three additions on top of the existing collapsible/persisted sidebar:

- **Collapse all / Expand all.** One toolbar toggle above the nav sets every domain group collapsed or expanded at once, persisted with the existing group-collapse state.

- **Status badges.** Nav items can now carry a live count/status badge. A permission- and module-gated, lazy `useNavBadges` hook is the source (a query never runs for a surface the user can't see), wired first to the **Duplicate Center** (groups awaiting review). Expanded rail shows a count pill; the collapsed rail shows a corner dot on the domain icon. Adding more badges is one gated query each.

- **Collapsed rail = domain switcher (the approved A+B hybrid).** The collapsed icon rail now shows one icon per *domain* instead of every page, and hovering or focusing a domain icon opens a flyout with that domain's pages. The rail no longer grows with the feature count, yet every page stays one hover away — this is what lets the sidebar scale. A short close delay lets the pointer travel from icon into the flyout; the flyout is `position: fixed` so it escapes the rail's scroll clipping.

4 new badge-hook tests (surfaces the duplicates badge, empty when nothing to review, no query without permission or with the module off). 122 frontend tests green; typecheck + build clean; en-US/es-PR shell strings at parity.
