---
"ultratorrent": patch
---

Saving a directory path now validates it against the hard storage roots (FILE_MANAGER_ROOTS) and, when the path is allowed but doesn't exist yet, prompts to create it. New GET /api/files/inspect (containment + on-disk state) and POST /api/files/ensure-dir (recursive mkdir inside the roots, audited) back a reusable useEnsureDirectory() hook. It is wired into every destination-path save form: Media Manager library create/edit, Add Torrent save path, RSS rule save path, Automation move/rename destinations, and the Settings default root path. Media library create/update now also asserts the path is within the hard roots server-side. Pure read-source inputs (rename-from source, scan/dry-run library, rename preview source) are intentionally left out, since creating an empty folder there is meaningless.
