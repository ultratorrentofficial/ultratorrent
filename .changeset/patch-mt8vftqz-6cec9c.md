---
"ultratorrent": patch
---

File manager: a second FILE_MANAGER_ROOTS entry is reachable again. Browse paths were rebased onto the first root, so a folder living only in another root 500'd with ENOENT and a name present in both silently served the first root's copy. With several roots paths are now absolute (single-root deployments are unchanged), and / lists the roots themselves. Trash and quarantine now store a path relative to the root they recorded rather than the client-facing one, so restores round-trip whatever the root count.
