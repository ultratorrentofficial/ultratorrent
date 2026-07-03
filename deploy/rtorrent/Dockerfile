# syntax=docker/dockerfile:1
# Minimal headless rTorrent for the OPTIONAL bundled UltraTorrent engine.
# Enabled with `docker compose --profile rtorrent up`. Unlike the ruTorrent
# bundle images, this exposes SCGI over TCP on 0.0.0.0:5000 so UltraTorrent's
# backend container can drive it directly (scgi-tcp, host `rtorrent`, port 5000).
FROM debian:bookworm-slim

# iproute2 provides `ss` for debugging the SCGI listener; gosu drops privileges
# to uid 1000 (matching the backend) after fixing the download-dir ownership.
RUN apt-get update \
  && apt-get install -y --no-install-recommends rtorrent ca-certificates iproute2 gosu \
  && rm -rf /var/lib/apt/lists/*

COPY rtorrent.rc /etc/rtorrent/rtorrent.rc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# SCGI control port (internal-only — never publish to the host; it is
# unauthenticated). Peer/DHT ports are 6890-6999 per the rc.
EXPOSE 5000

# The entrypoint starts as root, makes /downloads writable by uid 1000, then
# runs rtorrent as uid 1000 so downloaded files match the backend's `node` user.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
