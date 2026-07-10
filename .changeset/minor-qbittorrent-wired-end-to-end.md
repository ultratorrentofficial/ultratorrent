---
"ultratorrent": minor
---

Make the qBittorrent engine operator-configurable end to end. Encrypted credential storage (AES-256-GCM `password` in the engine config via the shared `__encrypted` convention, decrypted only when the provider connects; `list()` never returns it), the DTO gains `baseUrl`/`username`/`password` (with `mode` now optional), the Engines page offers a qBittorrent kind with a base URL / username / password form (blank password on edit keeps the stored one), and a profile-gated `qbittorrent` Docker Compose service (`lscr.io/linuxserver/qbittorrent`, reached at `http://qbittorrent:8080`) with `.env`/docs. Enable it with `docker compose --profile qbittorrent up -d`, then add the engine under Infrastructure → Engines.
