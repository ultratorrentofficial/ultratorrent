---
"ultratorrent": minor
---

Media Server Analytics (Phase 6e): DB normalization + sync overhaul. New MediaServerLibrary/MediaServerUser/MediaProviderSyncRun entities + stream-detail capture (container/bitrate/audio codec); MediaServerSyncService pulls provider libraries (capability-aware, upsert+prune) and derives users from watch history, hourly + on demand with run tracking. ReportFilter gains connectionId/libraryName/userName dimensions unlocking dashboard server/library/user filters; new bandwidth-over-time aggregation. Frontend: server/library/user selectors, bandwidth chart, provider Sync button
