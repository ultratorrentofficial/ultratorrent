---
"ultratorrent": patch
---

Bundled rtorrent: persist session state promptly so a crash no longer loses recently-added torrents. The rc had no session-save schedule, so rtorrent only wrote full state on a clean shutdown — any torrent added since the last graceful stop was lost when the (sporadic, auto-restarted) libtorrent crash hit, which is why RSS-grabbed torrents 'downloaded' but never appeared. rtorrent.rc now saves each torrent's full state on add (event.download.inserted_new -> d.save_full_session) plus a 5-minute periodic session.save backstop
