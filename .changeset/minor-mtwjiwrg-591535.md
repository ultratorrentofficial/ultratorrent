---
"ultratorrent": minor
---

Media Server Analytics: add an in-app IP Geolocation admin (like the local IMDb dataset manager) — a config area for MaxMind account id and license key (encrypted), a built-in database downloader/updater with status, and scheduled auto-refresh. Replaces the compose geoipupdate sidecar; the backend downloads the GeoLite2 databases itself, verifies them, and reloads with no restart, while IP lookups stay fully offline.
