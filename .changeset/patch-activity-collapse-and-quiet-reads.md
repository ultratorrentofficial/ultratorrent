---
"ultratorrent": patch
---

Recent activity noise cleanup: (1) stop writing an audit entry every time the Prowlarr settings page is read — a polled GET was flooding the audit trail and activity feed; only changes are audited now. (2) The activity feed now also collapses repeated user-attributed events (e.g. a polled read, or several torrent adds) into a single "· actor — N events" line, while keeping renames and downloads individual so they still name their show/release, and grouping automation runs by rule so a busy rule reads "Automation: <rule> — N events" instead of many lines.
