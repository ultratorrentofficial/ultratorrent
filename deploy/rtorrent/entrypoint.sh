#!/bin/sh
set -e
# Run rtorrent as a configurable user so downloaded files land with an ownership
# you choose. Defaults to uid/gid 1000 (matches the backend's `node` user).
#
# If your downloads folder is owned by ANOTHER user (e.g. `plex`), set PUID/PGID
# to that user's id/gid (find them with `id <user>`). rtorrent then writes files
# AS that user, so this container never has to change the folder's ownership.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Best-effort so a non-root container on a root-owned volume doesn't abort here
# (set -e) before we can report a clearer reason below; rtorrent surfaces a real
# error if the session dir is genuinely unusable.
mkdir -p /downloads/.session 2>/dev/null || true

# Clear a stale session lock left by a previously-crashed rtorrent. Only one
# rtorrent runs per container, so any lock present at startup is stale — without
# this, a single crash wedges the container in a permanent "Could not lock
# session directory" restart loop.
rm -f /downloads/.session/rtorrent.lock 2>/dev/null || true

# DHT defaults OFF: this rtorrent build can hit a fatal DHT internal_error
# ("DhtServer::event_write called but both write queues are empty") that crashes
# the process. Trackers + PEX still find peers. Set RT_DHT=on to re-enable it.
DHT_OPT="-o dht.mode.set=disable"
case "${RT_DHT:-off}" in
  on | On | ON | auto | yes | 1 | true) DHT_OPT="-o dht.mode.set=auto" ;;
esac

# Launch rtorrent as the CURRENT user (no privilege drop).
run_as_current() {
  exec rtorrent -n -o import=/etc/rtorrent/rtorrent.rc $DHT_OPT
}

CUR_UID="$(id -u)"

# Case 1: the container was started as a NON-root user — e.g. a `user:` override
# in compose, or a host (notably Synology DSM) that runs containers non-root. We
# can neither chown /downloads nor switch users, so just run rtorrent as-is.
# Downloads will be owned by this uid; if you need a specific owner, set
# `user: "<uid>:<gid>"` on the rtorrent service and make the volume writable by it.
if [ "$CUR_UID" != "0" ]; then
  echo "rtorrent entrypoint: started as uid $CUR_UID (not root) — running as-is; PUID/PGID switch skipped." >&2
  if [ "$CUR_UID" != "$PUID" ]; then
    echo "rtorrent entrypoint: note PUID=$PUID differs from the container uid $CUR_UID; downloads will be owned by $CUR_UID." >&2
  fi
  run_as_current
fi

# Root: make the session dir writable by the runtime user (best-effort)...
chown "$PUID:$PGID" /downloads/.session 2>/dev/null || true
# ...and claim /downloads ONLY when it's an unclaimed, root-owned fresh volume.
# A folder already owned by a real user (e.g. a plex-owned bind-mount) is left
# untouched — set PUID/PGID to that user so rtorrent writes as them, no chown.
if [ "$(stat -c '%u' /downloads 2>/dev/null || echo 0)" = "0" ]; then
  chown "$PUID:$PGID" /downloads 2>/dev/null || true
fi

# Case 2: root, and we can drop privileges to PUID:PGID — the normal path. Verify
# the switch actually works first (a host may strip CAP_SETUID/CAP_SETGID even
# from root), so we never exec into a guaranteed "operation not permitted" crash.
if gosu "$PUID:$PGID" true 2>/dev/null; then
  exec gosu "$PUID:$PGID" rtorrent -n -o import=/etc/rtorrent/rtorrent.rc $DHT_OPT
fi

# Case 3: root but the privilege drop is blocked (CAP_SETUID/CAP_SETGID removed
# by the host). Rather than crash-loop, run rtorrent as root. Files will be
# root-owned; align the other containers or grant the caps if that's a problem.
echo "rtorrent entrypoint: cannot switch to $PUID:$PGID (CAP_SETUID/CAP_SETGID unavailable) — running as root." >&2
run_as_current
