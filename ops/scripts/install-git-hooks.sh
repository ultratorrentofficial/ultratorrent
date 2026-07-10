#!/usr/bin/env bash
#
# install-git-hooks.sh — point this repo's git hooks at the tracked .githooks/
# dir so build-info.json is auto-refreshed on pull/checkout/commit (see
# .githooks/* and ops/scripts/stamp-build-info.js).
#
# Run once per clone on any host that builds images from a `git pull` (e.g. the
# deploy host). Idempotent and best-effort. The canonical build script
# (ops/scripts/docker-build.sh) stamps regardless, so this is extra insurance
# for a bare `docker compose build`.
#
# Usage: ops/scripts/install-git-hooks.sh
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "install-git-hooks: not a git work tree — skipped"
  exit 0
fi

chmod +x .githooks/* 2>/dev/null || true
git config core.hooksPath .githooks
echo "install-git-hooks: core.hooksPath -> .githooks (post-merge/checkout/commit stamp build-info.json)"
