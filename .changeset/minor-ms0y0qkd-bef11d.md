---
"ultratorrent": minor
---

Personal Discord notifications (Phase 6). One personal webhook per user, with the SSRF allow-list applied to the supplied host rather than a resolved address so DNS rebinding cannot defeat it. Webhooks are encrypted and never returned, mentions are disabled at the payload level, and messages render as embeds carrying the accent as the stripe colour.
