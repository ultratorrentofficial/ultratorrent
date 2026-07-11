---
"ultratorrent": patch
---

Fixes library scans that would freeze partway and never finish. Case-insensitive title lookups against the IMDb catalogue were scanning the entire 8.9-million-row table (measured at ~48 seconds per lookup), and because those lookups run per media item they saturated the database and stalled everything else. Adding trigram indexes brings the same lookup down to ~180ms. Separately, background jobs interrupted by a restart or deploy used to stay "running" forever; they are now marked as interrupted at startup instead of piling up.
