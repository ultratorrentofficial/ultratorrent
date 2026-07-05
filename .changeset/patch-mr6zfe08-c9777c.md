---
"ultratorrent": patch
---

Prevent overlapping IMDb dataset imports. ImdbDatasetImporterService.startImport now refuses to spawn a second worker while one is pending/running (returns the in-flight import instead) — the single choke point for Import-now, Update-now, and the scheduler. ImdbService guards download+import with an in-flight flag + DB active-import check, and marks any import left running after a restart as failed on startup so a dead job can't wedge future runs. The frontend disables Update-now while an import is active and surfaces a friendly message when a duplicate is rejected.
