---
"ultratorrent": patch
---

Build tooling: git commit/tag/build-time stamping is now folded into a canonical `ops/scripts/docker-build.sh` wrapper used by every build path (new `npm run build:docker`, the `package` script, and the deploy scripts), so images self-stamp their commit without remembering to pass build args. A bare `docker compose build` still works and falls back to the plain version (correct for throwaway dev builds).
