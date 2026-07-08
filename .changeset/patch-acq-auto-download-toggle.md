---
"ultratorrent": patch
---

Media Acquisition → Settings now has an "Auto-download missing episodes" toggle, plus "Search interval (minutes)" and "Max searches per sweep" fields (shown when enabled). Previously `autoSearchMissing` was only settable via the API; it's now controllable in the UI. Backed by the existing `AcquisitionSettings` + `PATCH /media-acquisition/settings`. en-US + es-PR i18n.
