---
"ultratorrent": minor
---

Policy scopes are now chosen from a list instead of typed by id, and a library-scoped policy actually matches something. The scope-id box was free text, so an operator had to know a library's UUID; worse, the preview never populated libraryId at all, meaning a library policy saved successfully and then silently governed no torrent. The library is now resolved from the intake record where there is one, and otherwise from the covering library root.
