---
"ultratorrent": patch
---

Library browser: a bulk 'delete files' now clears the selection the moment it is dispatched, not when the background job settles. When that settle callback did not run, the next delete dialog inherited the previous selection's count, so a fresh smaller selection still prompted for the earlier larger number and the type-the-count safeguard stopped describing what would be deleted.
