---
"ultratorrent": patch
---

The library form's "Organise automatically" toggle now actually saves. `autoOrganize` was added to the schema and read by the organiser, but the service the API routes library writes through never persisted it — so the control shipped in v0.64.0 was inert, and the library mode validation added alongside it sat on `MediaService.createLibrary`, which has no callers at all. Both now live on `MediaLibraryService`, the path the controller uses, with the spec retargeted there. Also wires the movie identity repair's preview/apply endpoints.
