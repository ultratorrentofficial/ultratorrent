---
"ultratorrent": patch
---

Audit log entries now name the show and episode they acted on. Previously the Target column showed only an opaque id (a uuid or torrent info-hash), so you couldn't tell what an entry was about without looking the id up. Each entry now also shows a readable name — for example "Silo (2023) — S01E03" — both in the collapsed row and beside the raw target in the details.
