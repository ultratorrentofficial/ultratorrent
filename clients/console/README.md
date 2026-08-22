# UltraTorrent Console (`utconsole`)

A read-only terminal view of a running UltraTorrent install.

It **observes and never manages**. Every request it makes is a `GET` against
`/api/operations`, authenticated as an ordinary account. That is not a promise
this program makes about itself — the server refuses anything else regardless of
what a client asks for, and read-only-ness comes from the account's role plus an
API surface that has no mutating route on it.

## Install

One static binary, no runtime, no libc dependency:

```bash
./build.sh                      # writes dist/ for linux, darwin, windows
scp dist/utconsole-linux-amd64 host:/usr/local/bin/utconsole
```

`CGO_ENABLED=0` is what lets one binary run on both a current Ubuntu and a QNAP
whose glibc is years older. A dynamically linked build fails on the older one
with a link error that says nothing about the real cause.

## Use

```bash
utconsole login --server https://your-install    # once; stores a rotating token
utconsole                                        # the console
utconsole snapshot --domains system,torrents     # one reading, as JSON
utconsole logout
```

**Point `--server` at the application root, not the backend port.** The backend
container does not publish its port on either deployed host; the frontend serves
`/api` through to it. On synoplex that is `http://127.0.0.1:8888`, on the QNAP
`http://127.0.0.1:18888`, and from anywhere else it is whatever public URL the
app is served at.

Keys: `tab` / `1`–`9` switch views, `r` refreshes now, `p` pauses polling,
`f` cycles the stream filter, `q` quits.

## The event stream

The **Stream** view is a live narrative fed by a websocket, not by polling. The
console speaks the Socket.IO subset it needs directly — framing, one handshake,
a heartbeat — rather than taking a dependency on a full client, and after the
handshake the only frame it ever sends is a pong. Read-only holds on the
realtime path exactly as it does over REST.

The token travels in the CONNECT payload rather than the query string, which the
gateway also accepts: the console reaches the API through nginx, and nginx
writes request URLs to its access log — a query-string token would be written to
disk in plain text on every reconnect, on the host being monitored.

**The buffer is not history.** It holds the last 200 events that arrived while
this console was open, it does not backfill, and the view says so every time it
renders. The record of what happened is the audit log.

## What it needs from an account

The `console.view` permission, which grants **access to the client and nothing
else**. Every panel is still gated by that domain's own view permission, so a
console user sees exactly what the same account sees in the web app — no more.
`READ_ONLY`, `USER` and `POWER_USER` hold it out of the box.

An account with `console.view` and no domain permissions is refused at startup
with a message saying so, rather than opening onto sixteen empty boxes.

## What it does not do

- **No writes.** No pause, no delete, no retry. Those live in the web app,
  behind their own permissions.
- **No history.** The console shows what is true now, plus whatever has arrived
  on the stream since it connected. The record of what happened is the audit
  log, `GET /api/audit`; presenting a bounded ring buffer as history would be a
  lie about what it holds.
- **No alert acknowledgement.** Alerts are computed from current state each time
  a snapshot is built. They have no identity that survives a restart and cannot
  be silenced — the way to make one go away is to fix what it reports. A dismiss
  key would promise something the server cannot honour.
- **No direct integrations.** No database, no Redis, no torrent engine, no media
  server, no filesystem. It talks to one HTTP API.

## How it treats the server

A console is watched *by* people and points *at* a machine that may be having a
bad day, so it is deliberately cheap:

- Each view requests only the domains it displays, never all sixteen.
- The refresh interval is clamped to the floor the server advertises in
  `capabilities.limits.minSnapshotIntervalSeconds`.
- `p` stops polling entirely rather than freezing a copy, so a paused console
  costs the server nothing.
- A failed refresh leaves the last good reading on screen with the failure and
  its age in the status bar. A console that quits when the server hiccups is
  useless exactly when it is needed.

Torrent figures carry an `observed` age, because the server reads them from what
its engine poller last saw rather than asking the engines again on your behalf.

## Configuration

`~/.config/utconsole/config.json`, mode `0600`, holding the server URL and a
**rotating** refresh token — no password is ever stored. Override the location
with `UTCONSOLE_CONFIG`.

The token is kept in a file rather than an OS keyring because these run on
headless servers where no keyring daemon exists, and a keyring that silently
falls back to a file is worse than a file that says so. The console warns once
if the file is group- or world-readable.

## Compatibility

The console checks the operations contract version at startup. Same major means
compatible; a newer minor means compatible with fields this build ignores; a
different major is refused with both versions named, rather than rendering
nonsense from a shape it is guessing at.

## Layout

```
cmd/utconsole/      CLI entry point and subcommands
internal/api/       contract types + the read-only HTTP client
internal/config/    the two things worth persisting
internal/ui/        Bubble Tea model, views, formatting, theme
```

`clients/` sits outside the repo's `packages/*` and `apps/*` npm workspace
globs, so `npm install` and the release tooling never see this module. It builds
and versions independently of the server, which is the point: one console has to
work against several installs.

## Tests

```bash
go test ./...
```

They cover what breaks quietly: refresh happening *before* a 401 rather than
after, a revoked session failing once instead of looping, an incompatible
contract being refused, forbidden panels explaining themselves rather than
rendering a zero value as data, and the config file being written owner-only.
