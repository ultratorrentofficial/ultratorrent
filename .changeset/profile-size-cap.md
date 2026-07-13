---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': minor
---

feat(media-acquisition): an auto-download profile can cap release size

A profile tier **outranks** the global default candidates, so the moment a profile
matches, the defaults — and the only size cap in the system — are never consulted.
`MediaAcquisitionProfile` already had `minSizeBytes`/`maxSizeBytes` columns and a
migration, but **nothing read them**: `profileToInput` hard-coded `sizeRules: {}`, no
DTO accepted them, and no UI offered them.

The result, on a real library: every Euphoria episode arrived under 1 GB via the
`1080p x265 (≤1 GB)` default — until `TV 1080p (auto-grab)` matched and pulled a
**1.63 GB** `Euphoria US S03E08`, because that profile had no ceiling to enforce.

The columns are now wired end to end: they become the tier's `sizeRules`, the create/
update DTO accepts them, and the profile dialog offers a **Max release size (GB)** field
(blank = no limit). The cap is opt-in — an uncapped profile behaves exactly as before.
