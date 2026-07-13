---
"ultratorrent": patch
---

fix(media-server-analytics): imported plays now carry their stream quality, so Quality Distribution stops reading 99% Unknown

A Tautulli history row carries no quality at all — no resolution, codec, container or bitrate — and the importer mapped none of those columns. So every imported play stored a null resolution, and the Quality Distribution chart bucketed it as Unknown: 7,971 of 8,057 rows on one host, 17,024 of 17,062 on another. The only non-Unknown slices came from the live-session sync, a different code path.

The quality exists only in Tautulli's per-row get_stream_data, so the import now fetches it — 8 lookups in parallel, and only for rows that are new or still missing it, so a re-import of already-enriched history costs nothing. What was STREAMED wins over the source file: a 1080p source watched as a 480p transcode was watched at 480p.

Existing rows are healed in place, since createMany skips them on the unique key.
