---
"ultratorrent": patch
---

Navigation redesign — Phase 2: registry-driven rail.

The sidebar is now **composed** from declarative contributions instead of a hand-ordered array. `navigation.ts` gains `NAV_DOMAINS` (the fixed domains with an `order`) and `NAV_CONTRIBUTIONS` — a list of `{ slot: { domain, order }, item }` where each module's top-level nav item *declares where it belongs* (`navSlot`). `composeNavGroups()` groups by domain, sorts by slot order, drops empty domains, and routes any contribution whose domain is unknown into an auto-appended **Extensions** area — so a future plugin can register navigation without touching the core rail. `NAV_GROUPS` is now `composeNavGroups()`.

Adding a module's nav is now appending one contribution (orders leave gaps of 10 so inserts never renumber neighbours), which is the structural change that lets the rail scale as the platform grows. The composed output is byte-for-byte the same rail as before, so the shell, breadcrumbs, command palette and RBAC/module pruning are unaffected.

5 new composer tests (domain/slot ordering, empty-domain pruning, unknown-domain → Extensions, no empty Extensions when all domains known, NAV_GROUPS === composed). 118 frontend tests green; typecheck + build clean.
