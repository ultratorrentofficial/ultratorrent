---
"ultratorrent": minor
---

A library's mode no longer answers two questions. Choosing "preview" to keep the automatic organiser away also vetoed manual renames — Execute reported "0 applied, N skipped" as a success — and made the previewed destinations differ from what an execute would produce. New `autoOrganize` flag carries the automation question alone; a library's mode is now always a real filesystem verb, and `preview` is refused with a message naming the replacement. Existing libraries migrate with their behaviour preserved: only the two relocating verbs were ever auto-organised, so only those are opted in, and a `preview` library becomes `rename_in_place` (the verb that cannot fork a show) while staying opted out. The manual rename preview now uses `dryRun` with the library's real mode, matching what the organiser has done since the flag was added.
