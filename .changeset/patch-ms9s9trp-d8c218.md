---
"ultratorrent": patch
---

Every RSS rule now has an Export button, so a single show can be moved between installs without exporting the whole configuration. Measured on a live install: one rule is 971 bytes against 142 KB for all 163, which is what exceeded the receiving server's body limit in the first place. The endpoint and API client already supported this; only the affordance was missing.
