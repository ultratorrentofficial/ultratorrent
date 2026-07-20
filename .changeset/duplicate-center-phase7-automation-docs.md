---
"ultratorrent": minor
---

Duplicate Center Phase 7 — events, automation, notifications, docs, and test coverage.

The Duplicate Center could detect and clean duplicates, but it was invisible to the rest of the platform: no WebSocket events, no automation triggers, and the `media.duplicate` notification rule was seeded **enabled** yet nothing ever emitted it — a rule that looked configured in the UI and could not fire.

**WebSocket.** Twelve `media_manager.duplicates.*` events — scan `started`/`progress`/`completed`/`failed`/`cancelled`, `group.updated`, resolution `started`/`progress`/`completed`/`partial`/`failed`, and `restored`. Prefixed `media_manager.` deliberately: the gateway derives its room from the event-name prefix, and a `media.*` name would have broadcast library paths and file counts to the room every authenticated user joins. A client correlates on the `scanId`/`resolutionId`.

**Notification Center.** `MediaDuplicateService.detect` now emits `media.duplicate` (finally), plus `media.duplicate_detected` and `media.duplicate_review_required`; the resolution service emits `media.duplicate_cleanup_completed`/`_failed`. Payloads carry the keys the card renderer and rule conditions read — `mediaTitle`, `wastedBytes`, `requiresReview`, `confidence`, `reviewUrl` — so a rule can say "only when more than 50 GB is reclaimable" with no code change. Deduped on the result shape, so a scheduled scan that keeps finding the same groups notifies once, not hourly. A scan that finds nothing, and an unchanged rescan, emit nothing.

**Automation.** Six triggers (`media.duplicate_scan_completed`, `_detected`, `_requires_review`, `_savings_threshold`, `_cleanup_completed`, `_cleanup_failed`) and three **non-destructive** actions (`media_run_duplicate_scan`, `media_ignore_duplicate_group`, `media_duplicate_report`). There is **no** automated destructive-cleanup action — the brief requires that one be gated behind an explicit opt-in, a dedicated elevated permission, preview persistence, trash-only behaviour, a strict confidence policy and a per-run file/byte cap, none of which exists yet. And no `exact_duplicate_detected` trigger: exact matching needs content hashing, which does not exist, and a rule that can never fire is worse than an absent one.

Wiring the actions surfaced a real gap: `runEventAction` (the event-trigger dispatch path) never delegated media actions — only the torrent-completion path did — so a rule on any `media.*`/`rss.*` event could not run a media action at all. Fixed, with a test that pins it.

**Docs.** New `DUPLICATE_CENTER.md`, `DUPLICATE_DETECTION.md`, `DUPLICATE_CLEANUP_SAFETY.md`, each with mermaid workflow diagrams; `MEDIA_MANAGER.md`, `API.md`, `MODULES.md`, `SECURITY.md`, `README.md` and the ARCHITECTURE change log updated. The docs state plainly what does **not** exist — no content hashing, so no `exact_hash` reason and nothing to fingerprint.

**Tests.** An event-contract spec (8) that asserts the producer, not just the constant, so `media.duplicate` cannot silently go dark again; ignore-persistence and stale-group-retention specs (a false positive stays dismissed across a rescan, and a human-touched group is never dropped); and automation catalog/dispatch tests proving the duplicate actions route to media and that no destructive resolve action exists.

`MediaDuplicateService` and `DuplicateResolutionService` gain `RealtimeGateway` + `EventEmitter2` injections; both already resolvable in the module, clean Nest boot verified.
