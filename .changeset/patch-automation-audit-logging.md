---
"ultratorrent": patch
---

Automation rule executions are now recorded in the audit trail and the dashboard's Recent activity, not just the rule's own run history. Each run (success or failure) is mirrored as an `automation.rule.executed` audit entry carrying the rule name, the actions it ran, and the torrent it acted on (or the failure reason). Both screens humanize it — e.g. "Automation: Remove torrent after download" with the torrent as a detail line, and a red "failed" state with the error when a run errors.
