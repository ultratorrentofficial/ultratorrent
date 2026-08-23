#!/usr/bin/env bash
# Build UltraTorrent Installer binaries.
#
# Mirrors clients/console/build.sh deliberately: `clients/` sits outside the
# `packages/*` and `apps/*` workspace globs, so `npm install`, `npm test
# --workspaces` and the release tooling never see this module. It versions and
# ships independently of the server it deploys — which is the point, since one
# installer has to work against several releases.
#
# Windows is a first-class target, not an afterthought: `ultratorrent-install.exe`
# is built from the same source by the same command as every other platform, so
# a change that breaks the Windows build breaks THIS script rather than being
# discovered on someone's laptop.
#
# Usage: ./build.sh [version]
set -euo pipefail

cd "$(dirname "$0")"
export PATH="/usr/local/go/bin:$PATH"

REPO_ROOT="$(cd ../.. && pwd)"
VERSION="${1:-$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo dev)}"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# CGO_ENABLED=0 is what makes one binary work on every target of its platform.
# The installer runs on whatever the administrator already has — an old Ubuntu,
# a current Debian, a Windows Server — and a dynamically linked build fails on
# the older ones with a link error that says nothing about the real cause.
export CGO_ENABLED=0

LDFLAGS="-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.built=${BUILT}"

# Vet both platforms before building either.
#
# `go vet` is GOOS-sensitive: it only ever checks the files that build for the
# target it is run against, so vetting Linux alone leaves every Windows-tagged
# file unchecked. Running both is what makes the platform split honest.
echo "vet"
for goos in linux windows; do
  echo "  ${goos}"
  GOOS="$goos" go vet ./...
done

echo
echo "test"
go test ./... >/dev/null

mkdir -p dist
build() {
  local os="$1" arch="$2" ext="${3:-}"
  local out="dist/ultratorrent-install-${os}-${arch}${ext}"
  echo "  ${out}"
  GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "$LDFLAGS" -o "$out" ./cmd/ultratorrent-install
}

echo
echo "ultratorrent-install ${VERSION} (${COMMIT})"
build linux amd64
build linux arm64
build windows amd64 .exe
# arm64 Windows is deliberately absent: the brief admits it only once the whole
# selected UltraTorrent stack is proven to run there, and shipping a binary
# implies a claim nobody has tested.

echo
( cd dist && sha256sum ultratorrent-install-* > SHA256SUMS && cat SHA256SUMS )
