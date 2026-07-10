---
"ultratorrent": minor
---

Add the qBittorrent engine provider (Web API v2) behind the existing engine abstraction — the sturdier alternative to rTorrent for large libraries. New cookie-auth HTTP client (`infrastructure/qbittorrent/qbittorrent-client.ts`) and `QbittorrentProvider` (`infrastructure/engine/qbittorrent/qbittorrent.provider.ts`) implementing the full `TorrentEngineProvider` contract over the v2 API, with native→normalized mappers (state, file priority, trackers, infinite-eta sentinel), the magnet-aware add-confirm behaviour, and SSRF-safe URL adds. `EngineConnectionConfig` gains `baseUrl`/`username`/`password` and `EngineProviderFactory` now instantiates it for kind `qbittorrent`. This is the provider core only — encrypted-credential storage, the add-engine UI form, and a bundled qBittorrent compose service are follow-ups, so it is not yet operator-configurable from the UI.
