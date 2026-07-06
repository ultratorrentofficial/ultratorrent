---
"ultratorrent": patch
---

Live Activity overhaul: real-time updates (WebSocket session-event push + 8s poll; backend session poll 30s→15s) so it no longer needs a manual reload, now-playing poster artwork via an auth-injected backend image proxy (Plex/Jellyfin/Emby), a summary KPI strip (streams/watchers/bandwidth/transcodes), a stream-mix proportion bar, and redesigned session cards with posters, playback-method colors, quality chips (resolution/codec/bitrate/container) and progress
