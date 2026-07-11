---
"ultratorrent": patch
---

Parking queue: also park torrents that have moved **nothing for hours with no seed connected**, even when their tracker claims seeders exist. Tracker seeder counts are frequently stale — on one host 66 of the 100 active download slots were held by torrents whose tracker advertised a seeder while they sat at zero bytes for 24 hours, which the seeder-count rule alone could never free. The stall rule judges only hard evidence (zero throughput, zero connected seeds, for `stalledAfterMinutes`, default 3h), so a merely-slow torrent is never touched. Revival is likewise now evidence-based — a seed actually connecting or bytes actually moving — because reviving on the tracker's claim would re-park the torrent on the very next tick, forever.
