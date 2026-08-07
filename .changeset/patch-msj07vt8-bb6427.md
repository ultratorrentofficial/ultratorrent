---
"ultratorrent": patch
---

A [dupN] suffix left behind by a failed import can now be restored to its canonical name. The suffix means 'something else holds the real name'; when an import fails partway nothing ever claims it, no duplicate group forms, and the restoration inside a resolution never runs. The new sweep renames only where the canonical name is free — it never decides a real duplicate and deletes nothing — and the index now follows the rename, which the existing restoration did not do.
