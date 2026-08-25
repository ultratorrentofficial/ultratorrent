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
# The console is embedded, so an installation ends with a working console and no
# second download. See internal/console/payload/README.md.
#
# PAYLOAD is committed EMPTY and filled in per platform below. The trap restores
# it however this script exits — an interrupted build must not leave an 8 MB
# binary sitting in a tracked file, where it would be committed by accident and
# would make every later `git status` dirty.
PAYLOAD="internal/console/payload/utconsole.bin"
CONSOLE_DIST="$(cd ../console 2>/dev/null && pwd)/dist"
restore_payload() { : > "$PAYLOAD"; }
trap restore_payload EXIT INT TERM
restore_payload

# Fill it for THIS machine before testing. The tests that matter — that the
# installed console is the embedded one, that the launcher moves the session off
# the home directory — skip when no console is aboard, so testing against the
# empty placeholder would quietly prove nothing.
HOST_CONSOLE="${CONSOLE_DIST}/utconsole-$(go env GOOS)-$(go env GOARCH)"
if [ -f "$HOST_CONSOLE" ]; then
  cp "$HOST_CONSOLE" "$PAYLOAD"
  echo "console: $(basename "$HOST_CONSOLE") embedded for the test run"
else
  echo "console: none built for this machine — embedded-console tests will skip"
fi
echo

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

  # Embed the console for the SAME platform. Getting this wrong would ship an
  # installer that writes a binary the host cannot execute, which is worse than
  # shipping none: a missing console is reported, a foreign one just fails.
  local console="${CONSOLE_DIST}/utconsole-${os}-${arch}${ext}"
  if [ -f "$console" ]; then
    cp "$console" "$PAYLOAD"
    echo "  ${out}  (console ${os}/${arch} embedded)"
  else
    restore_payload
    echo "  ${out}  (no console for ${os}/${arch} — build clients/console first)"
  fi

  GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "$LDFLAGS" -o "$out" ./cmd/ultratorrent-install
  restore_payload
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
