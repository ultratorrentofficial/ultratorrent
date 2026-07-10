---
"ultratorrent": patch
---

Audit trail: the expanded row details now show metadata in plain language instead of a raw JSON dump. Keys are turned into readable labels (e.g. "Library path", "IMDb ID") and values are formatted by type — byte sizes, counts, dates, Yes/No, and comma-joined lists. Genuinely nested values (objects or lists of objects) are still shown as formatted JSON, since there's no lossless flat form for them.
