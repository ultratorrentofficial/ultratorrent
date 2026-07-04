---
"ultratorrent": patch
---

RSS rules import now supports three merge modes: skip (default — leave existing rules), overwrite (replace matched rules' fields and their whole candidate set), and merge (append only non-duplicate match candidates to existing rules). Feeds are always reused by URL, never renamed. The import UI adds a mode-selection dialog and the summary reports overwritten/merged/skipped counts.
