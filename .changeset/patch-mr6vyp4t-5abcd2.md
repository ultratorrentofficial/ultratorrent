---
"ultratorrent": patch
---

Fix: the IMDb dataset import panel now refreshes when a long import finishes even if the WebSocket completion event is missed. A long import (title.principals is ~90M rows) emits no progress events for minutes and can outlast a socket reconnect, so the terminal event could be lost and the history/status never updated. The settings page now polls the imports + provider status every 4s while an import is active (from the live panel or the newest history row, so a page reload mid-import still tracks it) and reconciles the live panel to completed/failed from the polled history.
