#!/usr/bin/env bash
# Build UltraTorrent Console binaries.
#
# Deliberately a script and not part of the npm build: `clients/` sits outside
# the `packages/*` and `apps/*` workspace globs, so `npm install`, `npm test
# --workspaces` and the release tooling never see this module. The console
# versions and ships independently of the server it talks to — which is the
# point, since one console has to work against several installs.
#
# Usage: ./build.sh [version]
set -euo pipefail

cd "$(dirname "$0")"
export PATH="/usr/local/go/bin:$PATH"

REPO_ROOT="$(cd ../.. && pwd)"
VERSION="${1:-$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo dev)}"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# CGO_ENABLED=0 is what makes one binary work on every target. QNAP and Ubuntu
# ship different glibc vintages, and a dynamically linked build would fail on
# the older one with a link error that says nothing about the real cause.
export CGO_ENABLED=0

LDFLAGS="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.built=${BUILT}"

mkdir -p dist
build() {
  local os="$1" arch="$2" ext="${3:-}"
  local out="dist/utconsole-${os}-${arch}${ext}"
  echo "  ${out}"
  GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "$LDFLAGS" -o "$out" ./cmd/utconsole
}

echo "utconsole ${VERSION} (${COMMIT})"
build linux amd64
build linux arm64
build darwin amd64
build darwin arm64
build windows amd64 .exe

echo
( cd dist && sha256sum utconsole-* > SHA256SUMS && cat SHA256SUMS )
