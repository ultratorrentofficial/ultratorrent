---
"ultratorrent": patch
---

Fix duplicate cleanup failing with "Path is outside the allowed roots" whenever the file-manager Default Root Path is narrowed to a subtree that holds no media library.

There are two path boundaries: the ops hard roots (`FILE_MANAGER_ROOTS`) and a DB-configured Default Root Path that narrows *browsing* to a subtree. Duplicate cleanup validated each path against the hard roots (in both `preview` and `resolve`) but then executed the delete through the narrowed boundary, so the two disagreed: preview promised "Moving N files to Trash" and execution refused every one of them after the operator confirmed. With libraries under `/downloads/TV` and `/downloads/Movies` and the browse root set to `/downloads/complete`, cleanup was broken for every library.

`FilePathService` now exposes `storageSafety` — pinned to the hard roots, never narrowed — and `FilesService.remove` takes a `PathScope` (`'browse'` default, `'storage'` for system-initiated maintenance) which it threads into `TrashService.moveToTrash` so the trash directory and the recorded `originalPath` are sited in the root that actually contains the file. Duplicate cleanup now runs in `storage` scope, matching the boundary its own preflight checks. The file manager's own browse/cleanup paths are unchanged and still honour the narrowed root.

Also hardens `PathSafety.toRelative`: an uncontained path was rebased against `roots[0]`, producing a `..`-escaping string (`/../TV/show.mkv`) that looked like a valid relative path and only failed containment when something resolved it back — reporting the error far from the mistake. It now refuses such a path outright.
