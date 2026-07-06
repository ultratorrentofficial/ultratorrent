---
"ultratorrent": patch
---

SMTP settings: add an explicit 'Use authentication' toggle so newsletters can send through relays that reject AUTH (e.g. internal/localhost postfix). When off, no user/pass is sent regardless of a saved username; back-compat: existing configs with a username keep authenticating
