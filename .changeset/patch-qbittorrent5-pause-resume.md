---
"ultratorrent": patch
---

**qBittorrent 5 support: pause, resume, start and stop now actually work.** qBittorrent 5.0 (WebAPI 2.11) renamed `pause`/`resume` to `stop`/`start` and *removed* the old endpoints, so against a 5.x server every one of those four calls hit a `404 Endpoint does not exist` — pausing or resuming a torrent from the UI, and automation rules that pause, all failed silently. The provider now reads the server's WebAPI version once and speaks whichever dialect it implements, keeping `pause`/`resume` for pre-5.0 servers.
