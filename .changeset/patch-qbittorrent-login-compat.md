---
"ultratorrent": patch
---

qBittorrent client: accept the modern login contract. qBittorrent 5.x answers a successful `POST /api/v2/auth/login` with `204 No Content` (not `200 "Ok."`) and sets a `QBT_SID_<port>` session cookie (not `SID`). The client now treats `204` or `200 "Ok."` as success, extracts the cookie by name (`QBT_SID`/`QBT_SID_<port>`/`SID`), and echoes the full `name=value` back on every request — previously it hard-coded `SID=` and auth failed. Found via a live smoke test against `lscr.io/linuxserver/qbittorrent`.
