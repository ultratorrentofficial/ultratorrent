---
"ultratorrent": minor
---

Media Intake no longer silently drops a release when the destination name is taken. It now distinguishes a retry from a collision by inode: the same file is skipped as before, but a DIFFERENT file is moved aside to '<name> [dupN]' and the new copy takes the canonical name, so both land in the library where the duplicate engine and the media server can show them. Previously the new release stayed in staging seeding forever while the job reported success, and nothing could see it because staging belongs to no library. The suffix is [dupN] rather than (N) because (N) is already how episode titles carry a part number — a live library holds 481 of them — and parseItemIdentity yields the same identity with or without it, so both copies group together. Duplicate resolution is also inode-aware now: a hardlinked candidate contributes zero to expected savings, and a path sharing the keeper's inode is never trashed.
