---
"ultratorrent": minor
---

Rich notification presentation and shared playback primitives (Phase 3). One canonical presentation model backs both the in-app card and the Live Activity dashboard, so playback notifications and live session cards share one implementation. Also fixes a standing privacy defect: liveActivity() returned every session column including ipAddress, and now projects explicitly.
