---
"ultratorrent": patch
---

Fix Tautulli analytics import failing with "Failed to parse URL" when the source address is entered without a scheme (e.g. `192.168.99.10:8181`). The import provider now normalizes the base URL, defaulting to `http://` when no scheme is present and stripping trailing slashes. Regression test covers scheme-less, explicit-scheme, and trailing-slash cases.
