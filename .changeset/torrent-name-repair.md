---
'@ultratorrent/backend': patch
---

Fix torrents that display an infohash instead of their name. A magnet is named
after its infohash until metadata arrives, and neither engine reliably rewrites
that name afterwards — qBittorrent pins it permanently — so a torrent could sit
complete, seeding and correctly filed on disk while still being listed as
`246C4643….meta`. Placeholder names are now detected and repaired from the
engine's own file list, at the engine, so every view sees the real name.

Also: `rTorrent.renameTorrent` was a silent no-op (it wrote a custom key nothing
reads back) and now fails loudly, and `torrent_snapshots` no longer grows without
bound — snapshots for torrents the engine no longer has are pruned, instead of
lingering forever and polluting search and acquisition's duplicate check.
