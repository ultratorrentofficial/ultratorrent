---
"ultratorrent": patch
---

Renamer: a video is no longer planned as a sidecar of itself. When the source parsed to no content type (a bare season folder rather than a release name), the sidecar pass classified against the batch kind and re-planned every video, producing a duplicate rename that failed ENOENT after the primary had already moved the file — reporting failures on a run that had actually succeeded.
