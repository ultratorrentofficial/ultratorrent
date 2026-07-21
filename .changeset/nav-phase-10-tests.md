---
'@ultratorrent/frontend': patch
---

nav(Phase 10): tests sweep. Adds IA-invariant tests over the real NAV_GROUPS
(domains compose in canonical order, none empty, ≤9 top-level; every entry has a
stable id/label/icon; every leaf is a real destination — route, action, or
external link; globally-unique ids) and a "no dead links" guard that asserts every
in-app nav destination maps to a real route declared in App.tsx (58 destinations).
Frontend suite now 221 tests.
