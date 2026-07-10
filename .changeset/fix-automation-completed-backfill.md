---
"ultratorrent": patch
---

Automation: `torrent.completed` rules (e.g. "delete on complete") now fire for torrents that were already complete when first seen, that finished while the app wasn't polling, or that completed before the rule existed. Previously the trigger was a one-shot rising edge on the persisted progress snapshot (`<1 → ≥1`), so any torrent already past 100% at its first snapshot was permanently past the edge and its completion rules never ran — leaving completed torrents seeding forever. `AutomationEngine.reconcileCompleted` now re-evaluates already-complete torrents against every enabled `torrent.completed` rule each sync cycle, using `AutomationLog` as an idempotency ledger (shared with the edge path) so each rule runs at most once per torrent; a failed run isn't recorded as done, so a rule blocked by a transient error retries next cycle.
