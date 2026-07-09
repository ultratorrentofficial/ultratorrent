---
"ultratorrent": patch
---

Renamer: never move a primary video onto a corrupt-template path. A library naming template corrupted to a bare `{` (an unclosed token, which also isn't an illegal filename char) rendered every episode's destination to the literal `{`, so renames clobbered each file to `<show>/{` and episodes overwrote one another. `buildRenamePlan` now validates the rendered path with a new `isRenderedPathSafe()` helper (non-empty, no unresolved `{`/`}`, basename ends in the file's extension) and skips the file with an "invalid naming template" warning instead of destroying its name.
