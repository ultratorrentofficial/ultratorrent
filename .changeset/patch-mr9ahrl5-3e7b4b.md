---
"ultratorrent": patch
---

Bundled rtorrent engine image: replace Debian's apt rtorrent 0.9.8 / libtorrent 0.13.8 (which sporadically crashes on tracker announce with 'priority_queue_insert(...) called on an invalid item', and on DHT) with the maintained jesec/rtorrent static binary (pinned v0.9.8-r16). Same SCGI-TCP:5000 wiring, rc, entrypoint, uid-drop, and /downloads/.session persistence — only the rtorrent binary changes
