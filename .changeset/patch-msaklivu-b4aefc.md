---
"ultratorrent": patch
---

release.js no longer tells you to finish a --no-git release with a blanket commit. The flag exists because the script's own finalize step stages every tracked modification and pushes it; the skip-hint then printed that same command back, reading as the sanctioned way to finish. It now prints an explicit-path `git add` of the version files and consumed changesets, preceded by a `git status --short` check. Only changesets git actually tracks are named — `git add` is atomic across pathspecs, so one never-committed changeset would abort the whole command and silently stage nothing.
