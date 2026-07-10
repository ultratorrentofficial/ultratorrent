---
"ultratorrent": patch
---

Version badge: always surface the git commit, even for a plain `docker compose build`. The commit previously reached the image only via the `GIT_SHA`/`GIT_TAG`/`BUILD_TIME` Docker build args, so an image built without them (a bare `docker compose build`) reported `gitSha: null` and the UI showed the version with no commit. Now the build stamps a baked-in `build-info.json` (`ops/scripts/stamp-build-info.js`) that the backend reads at runtime — `resolveBuildInfo()` resolves each field env (build args) → baked file → null — so `GET /api/system/version` and the version badge can always render `v<version> - (<short-sha>)`. Stamping is automatic via `ops/scripts/docker-build.sh` and the `.githooks` (installed with `ops/scripts/install-git-hooks.sh`) that refresh the stamp on `git pull`/checkout/commit.
