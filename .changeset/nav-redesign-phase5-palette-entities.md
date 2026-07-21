---
"ultratorrent": minor
---

Navigation redesign — Phase 5: command palette searches actions and live entities, not just pages.

The Ctrl/Cmd-K palette now searches three kinds of result, each permission- and module-gated so it only offers what the user can reach:

- **Pages** — the RBAC-filtered nav (as before).
- **Quick actions** — navigational commands (Add torrent, Scan library, Find duplicates, Create RSS rule, Automation rules), filtered by label/keywords; running one goes straight to where the operation lives instead of navigating like a page.
- **Live entities** — async, debounced backend search over **media items** (movies/shows) and **libraries**, each under its own section with a loading indicator. Selecting one jumps to that entity (e.g. `/media/items/:id`).

Sources are wired through a small provider hook (`usePaletteProviders`) — adding another entity source or action is one gated entry, so Users/Jobs/Docs slot in trivially once their search endpoints exist. The palette stays self-contained (plain debounced state, no react-query dependency) so it remains cheap and easy to test. Empty-query quick access (Pinned/Recent/Favorites) and inline pin/star from Phase 4 are unchanged.

2 new palette tests (a quick action runs instead of navigating; async entity results appear under their section and navigate to the entity). 135 frontend tests green; typecheck + build clean; en-US/es-PR at parity.
