---
"ultratorrent": minor
---

Personal email notifications (Phase 4). One shared SMTP transport as infrastructure with a personal destination per user - reusing the transport that already existed for newsletters rather than adding a second. Connect-and-verify in one step, encrypted destinations that are never returned, asynchronous bounded-retry delivery that re-checks every precondition at send time, and HTML/plaintext rendering from the canonical presentation.
