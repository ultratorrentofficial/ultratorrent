---
"ultratorrent": patch
---

Dashboard "Recent activity" now spells out what media is being handled and what was attempted, instead of a bare "Media rename". Media rename/organize events read "Renamed media for 9-1-1 (2018)" with a `from → to` detail line (or applied/skipped/failed counts when there's no single move); Smart Download events read "Downloaded/Upgraded {release}" and "Download failed for {release}" with the error as detail. Backed by enriched audit metadata — `MediaService.apply` records the media name (title + year) and a representative from/to, and the download executor records the release name — plus a new optional `detail` line rendered under each activity row.
