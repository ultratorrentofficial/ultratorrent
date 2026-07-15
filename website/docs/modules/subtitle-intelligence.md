---
id: subtitle-intelligence
title: Subtitle Intelligence
sidebar_position: 18
description: Find, score, validate, install, and synchronize the best subtitle for every movie and episode — automatically.
keywords: [subtitles, opensubtitles, subdl, ffsubsync, sync, srt, vtt, ass, movie hash, plex, jellyfin, emby, kodi, sdh, forced]
---

# Subtitle Intelligence

Subtitle Intelligence is a **core** module (`subtitle_intelligence`). It is not just
a downloader — it is a complete subtitle engine that finds the subtitle most likely
to be **perfectly synchronized** with each file, validates it, installs it where
your media server expects it, and keeps your libraries free of gaps.

## What it does

- **Fingerprints** every media file — the OpenSubtitles *movie hash* (a same-encode
  match, the highest-confidence key) plus runtime, resolution, codecs, release
  group, and IMDb/TMDB/TVDB ids (reusing what [Media Manager](/modules/media-manager)
  already measured).
- **Searches** multiple providers with a progressively-relaxed strategy, most
  confident first: **exact hash → release name → external id → title**. A
  title-only match is never installed automatically.
- **Scores** each candidate to a normalized **0–100** with an action tier — *auto*
  (install), *download* (verify then install), *review* (present to you), or
  *reject*. An exact hash match is trusted on its own.
- **Validates** before writing — malformed cues, negative or inverted timestamps,
  out-of-order cues, and (optionally) a subtitle that runs past the media's runtime
  are all caught.
- **Installs** a media-server-correct sidecar (`Movie.en.srt`, `Movie.en.forced.srt`,
  `Movie.en.sdh.srt`, `Show - S01E01.es-PR.srt`) for Plex / Jellyfin / Emby / Kodi —
  and **never overwrites** an original.
- **Synchronizes** to the audio with **FFsubsync**, or by a manual offset when the
  tool isn't installed. The original is always kept alongside the synced copy.
- **Monitors** libraries: a background scan finds items missing their required
  languages and (optionally) fetches them, per a per-library **language policy**.

## Providers

| Provider | Kind | Needs |
|----------|------|-------|
| OpenSubtitles | official API | API key (+ login for downloads) |
| SubDL | official API | API key |
| Local Repository | offline | a folder inside your storage roots |
| Podnapisi | unofficial JSON | — |
| YIFY Subtitles | scraping (movies) | — |
| SubtitleCat | scraping (auto-translated) | — |
| Addic7ed · Subs4Free | prepared | — |

All providers plug into one interface, so new sources drop in without touching the
engine. **YIFY and SubtitleCat are scraping-based** (the sites have no API), so
they are best-effort — reliable enough for everyday use, but a site redesign can
disable them without affecting the rest of the module.

## Optional tools (automatic sync)

Automatic audio-based sync needs `ffmpeg` + `ffsubsync`; the technical probe uses
`mediainfo`. None are required — without them the module still searches, scores,
validates, installs, and offers **manual-offset** sync. Provision them with:

```sh
ops/scripts/install-subtitle-tools.sh
```

or, for Docker, build with `--build-arg INSTALL_SUBTITLE_SYNC=true`.

## Pages

**Dashboard** · **Search** · **Synchronization** · **Validation** · **Languages** ·
**History** · **Providers** — under **Media Management → Subtitle Intelligence**.

## Security

Provider credentials are AES-256-GCM encrypted and redacted in the UI; downloads
are host-allow-listed (no SSRF) and validated before ever touching disk; all
filesystem access is confined to your storage roots; and every action is
permission-gated and audited.

## Permissions

`subtitle_intelligence.view` · `.search` · `.download` · `.synchronize` ·
`.providers` · `.settings` · `.manage` · `.admin`. Power User holds everything but
`admin`; regular users get view + search; read-only gets view.
