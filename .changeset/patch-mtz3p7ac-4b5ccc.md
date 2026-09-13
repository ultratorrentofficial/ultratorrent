---
"ultratorrent": patch
---

Stream Control: raise the default enforcement grace period from 10s to 60s, so a transient over-limit (a pause registering, a device handoff whose old session is still winding down, a re-buffer) resolves before any termination.
