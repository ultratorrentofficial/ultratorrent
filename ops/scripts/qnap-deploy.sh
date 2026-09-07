#!/bin/sh
# Deploy UltraTorrent to the constrained NAS, and prune what it supersedes.
#
# The NAS never builds — it pulls what the build host pushed to the registry,
# retags to the bare names its compose file uses, restarts, and then removes the
# versions it no longer needs.
#
# WHY THIS EXISTS
#
# The build host has always pruned local images to current + previous on every
# deploy. The NAS path never did, because it was a handful of commands typed by
# hand rather than a script. By 2026-09-07 that had accumulated 98 UltraTorrent
# images and 54 GB of reclaimable data, on a box with 7.8 GB of RAM.
#
# PORTABILITY — this is BusyBox, not GNU
#
#   * `sort -V` DOES NOT EXIST here. Copying the build host's prune verbatim
#     leaves the keep-list empty, and its `[ -n "$KEEP" ]` guard then skips the
#     prune entirely — a silent no-op that looks like it worked. The numeric
#     field sort below is the portable equivalent, and it orders 0.83.10 after
#     0.83.9, which a lexical sort does not.
#   * Docker is not on PATH; it lives under Container Station.
#   * `/root` is a volatile ramdisk, wiped on reboot. Install this somewhere
#     under /share instead.
#
# NOTE: /bin/sh here is bash 3.2. An apostrophe inside a ${VAR:?message}
# expansion is read as an unterminated quote by that version — "the build host's
# registry" in this very line's default message made the whole file unparseable,
# and only on the NAS. Keep apostrophes out of parameter-expansion messages.
#
# Usage (from the deployment directory, or with COMPOSE_DIR set):
#   REGISTRY=<host:port> qnap-deploy.sh <version> [service ...]
#   REGISTRY=<host:port> qnap-deploy.sh --prune-only
set -eu

PATH="$PATH:/share/CACHEDEV1_DATA/.qpkg/container-station/bin"
export PATH

# Both are supplied by the caller, because this repository is public and carries
# no real addresses or deployment paths. The values for a given installation live
# in the gitignored host inventory.
COMPOSE_DIR="${COMPOSE_DIR:-$PWD}"
: "${REGISTRY:?set REGISTRY to the registry the build host pushes to, e.g. REGISTRY=host:5000}"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || {
  echo "no docker-compose.yml in $COMPOSE_DIR — cd to the deployment directory or set COMPOSE_DIR" >&2
  exit 1
}

# Keep this many versions of each service, newest first. The build host's
# registry keeps the same number, so a rollback target always exists in both.
KEEP_VERSIONS=2

log() { echo "$@"; }

prune() {
  log "== prune local images (keep current + previous) =="

  # Scoped to our own repositories deliberately: an unrelated image carrying a
  # semver tag would otherwise sort highest and evict the real previous version,
  # leaving nothing local to roll back to.
  keep="$(docker images --format '{{.Repository}}:{{.Tag}}' \
          | grep -E 'ultratorrent-core-(backend|frontend)' \
          | sed 's/.*://' \
          | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
          | sort -u -t. -k1,1n -k2,2n -k3,3n \
          | tail -"$KEEP_VERSIONS" || true)"

  if [ -z "$keep" ]; then
    # Loudly, not silently. An empty keep-list means the tag shape changed or a
    # tool behaved differently, and pruning nothing while reporting success is
    # how 54 GB accumulated unnoticed in the first place.
    log "   !! no semver tags found — refusing to prune. Check the tag format." >&2
    return 0
  fi

  removed=0
  for ref in $(docker images --format '{{.Repository}}:{{.Tag}}' \
               | grep -E 'ultratorrent-core-(backend|frontend)'); do
    tag="${ref##*:}"
    # `latest` is what the compose file references; never remove it.
    [ "$tag" = "latest" ] && continue
    printf '%s\n' "$keep" | grep -qx "$tag" && continue
    # A tag a running container still references simply fails to remove. Fine.
    if docker rmi "$ref" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done

  # Dangling layers left behind once the tags above were removed.
  docker image prune -f >/dev/null 2>&1 || true

  log "   kept: $(printf '%s' "$keep" | tr '\n' ' ')+ latest"
  log "   removed: $removed tag(s)"
  log "== docker space =="
  docker system df 2>/dev/null | head -3 || true
}

if [ "${1:-}" = "--prune-only" ]; then
  prune
  exit 0
fi

VERSION="${1:?usage: qnap-deploy.sh <version> [service ...]}"
shift || true
SERVICES="${*:-backend frontend}"

log "== pull $VERSION =="
for svc in $SERVICES; do
  docker pull "$REGISTRY/ultratorrent-core-$svc:$VERSION" | tail -1
done

log "== retag to the names compose uses =="
for svc in $SERVICES; do
  docker tag "$REGISTRY/ultratorrent-core-$svc:$VERSION" "ultratorrent-core-$svc:latest"
done

log "== up =="
cd "$COMPOSE_DIR"
# Never build here: a full build takes 30-40 minutes and has wedged the daemon.
docker compose up -d --no-build $SERVICES 2>&1 | tail -6

log "== verify =="
for svc in $SERVICES; do
  if [ "$svc" = "backend" ]; then
    docker exec "ultratorrent-core-backend-1" cat /app/build-info.json 2>/dev/null || true
  fi
done

prune
