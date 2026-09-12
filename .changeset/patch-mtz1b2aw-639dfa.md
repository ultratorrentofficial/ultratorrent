---
"ultratorrent": patch
---

Stream Control: enforcement records a diagnosable reason (each stream's title/device/playback-state and whether it counted) surfaced as a collapsible reason in Enforcement History; and enforcement now waits at least one poll cycle before acting so a just-paused or just-handed-off stream settles in a fresh snapshot first (fixes an actively-watched stream being terminated because a stale/under-reported paused stream still counted).
