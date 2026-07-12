---
'@ultratorrent/frontend': patch
---

Replace the 126 placeholder slates in the documentation with real screenshots captured
from a running instance (112 app screens plus two terminal panels rendered from real
`docker compose` output). The 16 third-party screens — Synology, QNAP, Portainer,
Proxmox, TrueNAS, Unraid, Plex — remain placeholders, since they are not UltraTorrent.

The screenshots are redacted: media titles, release names, posters, file paths, audit
targets and media-server usernames are blurred, while the interface itself — buttons,
badges, counts, progress bars, headings — stays sharp. `scripts/capture-screenshots.mjs`
regenerates them and encodes that policy as default-deny: inside a data card, text is
blurred unless it is provably interface furniture.
