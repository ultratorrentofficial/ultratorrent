---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': minor
---

feat(media): a library scan now tells you when two folders hold the same show

The duplicate-show merge flow (detect → choose the real path → preview → confirm →
re-home + delete) already existed, but nothing pointed the operator at it: a scan that
found `Happy's Place (2024)` sitting beside `Happys Place` said nothing, and the panel
had to be discovered.

A scan now runs the detection and reports what it found. `ScanSummary` carries
`duplicateShows`, the count rides on the `library_scan` completed event, and the
Libraries page raises a toast — *"2 possible duplicate show folders found. Nothing was
changed. Review them under Media → Duplicates and choose the real path."*

The scan deliberately **reports and stops**. It never merges on its own: a merge moves
files and permanently deletes a folder, and nothing in the scan can know which of the
two paths is the real one. That decision, the preview of every move and deletion, and
the confirmation all stay with the operator.

Detection is best-effort — a library whose duplicates cannot be computed is still a
successfully scanned library.
