---
"ultratorrent": patch
---

fix(media-server-analytics): watch history is imported per library, so the Libraries report stops attributing everything to Unknown

Tautulli's get_history rows carry NO library field at all — not library_name, not section_id (verified against a live server). The importer read r.library_name anyway, which is always undefined, so almost every imported play landed with a null library and the analytics Libraries report bucketed it as Unknown: 7,972 of 8,057 rows on one host (98.9%), 17,025 of 17,062 on another (99.8%).

The only thing that knows a row's library is the SECTION it was fetched under, so history is now imported per library — get_libraries, then get_history?section_id=N per section, stamping the name — followed by one unfiltered pass for history that belongs to no current section (clips, live TV, a deleted library), which genuinely has no library.

Rows already imported without a library are healed in the same pass. Re-importing alone would have fixed nothing: the unique key makes createMany skip the existing row, null library and all.
