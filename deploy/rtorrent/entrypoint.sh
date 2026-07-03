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

mkdir -p /downloads/.session

# Clear a stale session lock left by a previously-crashed rtorrent. Only one
# rtorrent runs per container, so any lock present at startup is stale — without
# this, a single crash wedges the container in a permanent "Could not lock
# session directory" restart loop.
rm -f /downloads/.session/rtorrent.lock

# Our own session dir must be writable by the runtime user (best-effort).
chown "$PUID:$PGID" /downloads/.session 2>/dev/null || true
# Only claim the downloads root when it's an UNCLAIMED, root-owned fresh volume.
# A folder already owned by a real user (e.g. a plex-owned bind-mount) is left
# untouched — set PUID/PGID to that user so rtorrent writes as them, no chown.
if [ "$(stat -c '%u' /downloads 2>/dev/null || echo 0)" = "0" ]; then
  chown "$PUID:$PGID" /downloads 2>/dev/null || true
fi

# DHT defaults OFF: this rtorrent build can hit a fatal DHT internal_error
# ("DhtServer::event_write called but both write queues are empty") that crashes
# the process. Trackers + PEX still find peers. Set RT_DHT=on to re-enable it.
DHT_OPT="-o dht.mode.set=disable"
case "${RT_DHT:-off}" in
  on | On | ON | auto | yes | 1 | true) DHT_OPT="-o dht.mode.set=auto" ;;
esac

exec gosu "$PUID:$PGID" rtorrent -n -o import=/etc/rtorrent/rtorrent.rc $DHT_OPT
