---
"ultratorrent": patch
---

fix(docker): re-add SETUID/SETGID caps to the rtorrent service so gosu can drop to PUID:PGID on hosts (Synology) that strip them
