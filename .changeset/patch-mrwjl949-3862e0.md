---
"ultratorrent": patch
---

The rename preview collapses skipped files too. Files the plan will not touch are not rename candidates either, and 30 of them sat between the 44 rows that were real work on a live show. They now hide behind their own 'Show N skipped files' toggle, alongside the existing one for files already in place. The two groups are disjoint by construction — the plan only marks 'unchanged' on a file it did not skip — so the counts never double-report. A skipped row keeps its reason (e.g. 'no video for episode S05E14 in this batch'), so the diagnostic is one click away rather than gone, and plan-level warnings stay visible above the list regardless. The live show's preview now opens on 44 rows out of 352.
