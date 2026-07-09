---
"ultratorrent": minor
---

Torrent fetching: add an `SSRF_ALLOW_HOSTS` allowlist (comma-separated hostnames, IPs, or IPv4 CIDRs) so a self-hosted indexer on the LAN or Docker network — e.g. a Prowlarr that hands back `.torrent` proxy links on a private IP — can be fetched, while arbitrary internal URLs stay blocked. Empty by default (full SSRF protection unchanged); scheme allow-list, redirect refusal, and size caps still apply to allowlisted hosts. Fixes auto-downloads silently failing with "Torrent URL resolves to a blocked internal address" when the indexer's results carry no magnet.
