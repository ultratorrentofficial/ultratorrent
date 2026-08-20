---
"@ultratorrent/backend": patch
---

fix(renamer): climb the whole container chain, not three levels of it

`showFolderRoot` stopped after a hard-coded three levels. A library that had
already run the pre-fix renamer holds `Extras`/`Season NN` chains deeper than
that, and stopping short does not leave a file alone — it returns a root that is
itself inside a season folder, so `resolveDestination` re-appends the template's
`Season NN` and creates `Season 3/Season 3`. The bound is now the path's own
depth; the filesystem-root and library-floor breaks are what keep the climb safe.
Also heals folders the old bound created, since the climb now passes them too.
