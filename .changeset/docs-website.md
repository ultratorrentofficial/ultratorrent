---
'@ultratorrent/backend': patch
---

Fix the bundled Caddy reverse-proxy profile returning 502. `deploy/Caddyfile` proxied to
`frontend:80`, but the frontend image is built on `nginx-unprivileged` and listens on
**8080**, so nothing was behind the upstream. Also corrected two stale docs:
`MISSING_EPISODES.md` claimed auto-acquisition was unimplemented (it shipped), and
`API.md` claimed rTorrent was the only engine (qBittorrent is fully implemented).

Adds a Docusaurus documentation site under `website/`, whose reference section
(endpoints, permissions, modules, environment variables, database schema) is generated
from the compiled application at build time so it cannot drift from what ships.
