---
"ultratorrent": patch
---

Episodes whose torrent is no longer in the client are released back into the search pool. A removed torrent sits in no parking table, so nothing would ever probe it and the episode stayed stamped grabbed forever; on a live install, 81 of 95 stuck grabs whose torrent was not parked were simply gone. It refuses to act unless the picture is trustworthy: every engine must answer, the listing must be non-empty, and torrents the database believes are parked must actually appear in it — because an unreachable or half-started engine looks exactly like every torrent having been removed, and acting on that would release the whole backlog including live downloads.
