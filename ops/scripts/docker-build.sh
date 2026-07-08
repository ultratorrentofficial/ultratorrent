#!/usr/bin/env bash
#
# Canonical Docker image build. Stamps the running git commit / describe-tag /
# build-time into the image via build args, so GET /api/system/version — and the
# UI version badge — report the exact commit a deploy is running (two deploys can
# share a version number but differ by commit).
#
# Every build path should go through this script (npm run build:docker, the
# deploy scripts, CI) so stamping is automatic and consistent. Building outside
# it (a bare `docker compose build`) still works — the image just falls back to
# the plain version, which is the right behaviour for throwaway dev builds.
#
# Usage:
#   ops/scripts/docker-build.sh [compose build args...]   # e.g. backend frontend
#   ops/scripts/docker-build.sh                           # all services
#
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root (holds docker-compose.yml)

# Best-effort: an image built from a tarball / shallow export with no .git just
# reports the version, so never fail the build on a missing git.
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
GIT_TAG="$(git describe --tags --always --dirty 2>/dev/null || true)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export GIT_SHA GIT_TAG BUILD_TIME

echo "docker-build: GIT_TAG=${GIT_TAG:-<none>} GIT_SHA=${GIT_SHA:0:12}${GIT_SHA:+…} BUILD_TIME=${BUILD_TIME}"
exec docker compose build "$@"
