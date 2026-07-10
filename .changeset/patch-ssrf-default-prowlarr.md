---
"ultratorrent": patch
---

Default the torrent-fetch SSRF allow-list to the bundled Prowlarr so auto-downloads work out of the box. `docker-compose.yml` now sets `SSRF_ALLOW_HOSTS: ${SSRF_ALLOW_HOSTS:-prowlarr}`. Previously the default was empty, so any grab from the bundled Prowlarr (which returns `.torrent` proxy links on a private Docker IP) failed with *"Torrent URL resolves to a blocked internal address"* and auto-downloads silently did nothing — even though the Prowlarr connection test passed (the health check trusts private hosts; the torrent fetch is a separate, stricter guard). Documented the requirement and this "passing test / failing downloads" trap in `.env.example`, `docs/DOCKER.md`, `docs/INSTALL.md`, `docs/PROWLARR.md`, and `docs/SECURITY.md`. Override the variable to trust additional self-hosted indexers (keep `prowlarr` in the list when using the bundled one, e.g. `SSRF_ALLOW_HOSTS=prowlarr,indexer.lan`).
