---
'@ultratorrent/backend': minor
---

The Media Manager now reads what a media file actually **is**, instead of trusting what
it is called.

`deriveFileTechInfo()` derived a file's codec/resolution/hdr by parsing its **filename**
— and the renamer strips exactly those tokens. Once a file becomes
`Ted Lasso - S02E03 - Do the Right-est Thing.mp4`, the quality information is simply
gone and nothing can recover it. On a real 28,994-file library that meant **4%** of files
had a `videoCodec`, **17%** a `resolution`, and **0%** any HDR value.

Everything downstream that reads those columns was therefore guessing. `media-duplicate`
scores a copy as `resolution * 10 + codec`, so with both null it scored nearly every file
0 and could not say which duplicate was better. `quality-compare` says so in its own
docstring: *"it parses the release names (the only signal available for an owned torrent)…
Bitrate is intentionally excluded: it is not reliably encoded in release names."*

A new `MediaProbeService` reads the container itself via **mediainfo** — the same library
tinyMediaManager uses. It emits JSON directly and costs ~18 MB in the image, where ffmpeg
would cost ~440 MB. A probe reads the header, not the stream: 110–190 ms per file measured
against a NAS. `MediaFile` gains `width`, `height`, `bitrateKbps`, `durationSec`,
`audioChannels` and `frameRate`, plus a `techSource` discriminator (`filename` vs `probe`)
— provenance is the point, because a value you cannot trust is worse than no value, and it
is also how the backfill knows what is left to do.

`MediaProbeBackfillService` fills the existing library in the background: 200 files every
5 minutes at concurrency 4, so a 29k-file library completes in about a day without ever
hammering disks that are also serving Plex. It is resumable by construction — the working
set is a query ("never probed, not already failed"), not a cursor — and a file that cannot
be read records *why* and is never retried, so one corrupt file is not re-probed forever.
Where mediainfo is absent the service degrades to a no-op rather than failing the boot.

This deliberately does **not** change acquisition matching: before a download exists the
only signal is the release name, so the profile gates stay name-based. What it enables is
everything after the file lands — truthful duplicate resolution, upgrade decisions that
can finally see real bitrate, and the ability to catch a release that lied about what it
was.
