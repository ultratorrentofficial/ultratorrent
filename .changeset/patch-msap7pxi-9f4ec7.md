---
"ultratorrent": patch
---

A film title containing a slash no longer creates directories. `renderTemplate` interpolated token values into one string and then split it on `/` to get path segments, so a separator inside a VALUE was indistinguishable from one the template author wrote — `Face/Off` and `Mother/Android` each rendered four segments where the template asked for two, burying the file directories deep, and each subsequent run nested it one level further (one had been re-nested four times on a live library). `sanitizeSegment` had always listed `/` as illegal but never got to see the whole value; separators are now neutralised at substitution, which is what makes that existing rule reachable.
