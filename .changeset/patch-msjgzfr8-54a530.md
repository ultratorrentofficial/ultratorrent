---
"ultratorrent": patch
---

RSS-rule-scoped scheduler policies now match. The resolver required a rule id the preview never supplied, so a policy scoped to a rule saved successfully and governed no torrent. The rule is resolved from the download evaluations, counting only rows that actually downloaded and taking the most recent when a torrent was grabbed more than once.
