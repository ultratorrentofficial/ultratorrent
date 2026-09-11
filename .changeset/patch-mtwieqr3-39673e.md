---
"ultratorrent": patch
---

Media Server Analytics: add an optional geoipupdate sidecar (profile 'geoip') that keeps the MaxMind GeoLite2 City/ASN databases current automatically, downloading only changed editions into the shared volume on a schedule. The backend reloads a refreshed database with no restart and still makes no outbound call itself; enable it with a MaxMind account id and license key.
