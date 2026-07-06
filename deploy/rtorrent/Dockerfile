# syntax=docker/dockerfile:1
# Headless rTorrent for the OPTIONAL bundled UltraTorrent engine.
# Enabled with `docker compose --profile rtorrent up`. Exposes SCGI over TCP on
# 0.0.0.0:5000 so UltraTorrent's backend container drives it directly (scgi-tcp,
# host `rtorrent`, port 5000).
#
# Uses the maintained jesec/rtorrent build (https://github.com/jesec/rtorrent)
# instead of Debian's apt rtorrent 0.9.8 / libtorrent 0.13.8, which sporadically
# crashes on tracker announce ("priority_queue_insert(...) called on an invalid
# item") and on DHT. The jesec binary is fully static — no libtorrent runtime dep.
FROM debian:bookworm-slim

# ca-certificates: HTTPS trackers. iproute2: `ss` for debugging the SCGI socket.
# gosu: drop to the runtime uid after fixing download-dir ownership. curl: fetch
# the rtorrent binary at build time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates iproute2 gosu curl \
  && rm -rf /var/lib/apt/lists/*

# Pinned maintained rtorrent. TARGETARCH is buildkit-provided (amd64 / arm64) and
# matches the jesec asset naming (rtorrent-linux-<arch>).
ARG RTORRENT_VERSION=v0.9.8-r16
ARG TARGETARCH=amd64
RUN curl -fsSL -o /usr/local/bin/rtorrent \
      "https://github.com/jesec/rtorrent/releases/download/${RTORRENT_VERSION}/rtorrent-linux-${TARGETARCH}" \
  && chmod +x /usr/local/bin/rtorrent \
  && test -s /usr/local/bin/rtorrent

COPY rtorrent.rc /etc/rtorrent/rtorrent.rc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# SCGI control port (internal-only — never publish to the host; it is
# unauthenticated). Peer/DHT ports are 6890-6999 per the rc.
EXPOSE 5000

# The entrypoint starts as root, makes /downloads writable by the runtime uid,
# then runs rtorrent (the jesec binary on PATH at /usr/local/bin/rtorrent).
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
