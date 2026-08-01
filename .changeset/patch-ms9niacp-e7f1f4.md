---
"ultratorrent": patch
---

A managed rule's own save path is now the single answer to where its show stages. Missing-episode grabs previously derived a separate path under the profile's staging root, so the same show staged in two places depending on whether an RSS feed match or a missing-episode search found the release. That derivation was necessary before rules were guarded — a managed rule's save path still pointed into a library then, and staging there would have imported the library into itself — but the rule service refuses that combination now, so the premise is gone. A path is still invented for a managed rule that has none.
