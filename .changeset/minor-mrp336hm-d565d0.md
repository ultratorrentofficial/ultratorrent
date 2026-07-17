---
"ultratorrent": minor
---

File Manager move/copy intelligence: a move/copy is now preflighted against the destination. When the same file is already there (matched by size + partial content hash) or the same TV episode exists as a different release, the operator gets a per-conflict decision — Replace, Keep both, Keep existing & delete source, or Skip — with the release quality of each side laid out and the smarter default pre-selected (identical → delete redundant source; better release → replace). Displaced files route through Trash by default, with a permanent-delete toggle. Episode identity and quality comparison reuse the RSS/acquisition engines (releaseIdentity, compareQuality) so 'same episode' means the same thing everywhere. New endpoints POST /files/move-conflicts (read-only analysis) and POST /files/resolve-conflicts (per-item execution, same result envelope as bulk).
