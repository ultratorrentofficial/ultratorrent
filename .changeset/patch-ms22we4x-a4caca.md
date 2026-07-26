---
"ultratorrent": patch
---

Media-server sessions are no longer ended on a single missed poll: a grace period plus re-attachment of sessions whose provider id changed, fixing spurious stop/start notifications, fragmented watch history and inflated completed-play counts
