---
"ultratorrent": patch
---

Media Server Analytics: the Watch History table now shows each viewer's operator-set friendly name instead of the raw login handle the media server reported. The friendly name (MediaServerUser.displayName) is resolved per page and matched within a connection by provider user id, falling back to the stored handle.
