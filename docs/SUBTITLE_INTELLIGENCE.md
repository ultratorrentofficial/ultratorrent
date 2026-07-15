# Subtitle Intelligence

Subtitle Intelligence is a **core** UltraTorrent module (id `subtitle_intelligence`,
route `/api/subtitle-intelligence`, menu group **Subtitle Intelligence**) — the
definitive subtitle system. It is not merely a downloader: it fingerprints every
media file, searches multiple providers with a progressively-relaxed strategy,
scores and validates each candidate, and installs the best as a
media-server-correct sidecar (which the Media Manager scanner then discovers),
**never overwriting an original**. It is an original UltraTorrent implementation,
locked and always-on (`tier: 'core'`), controlled entirely through RBAC.

- Backend: `apps/backend/src/modules/subtitle-intelligence/`
- Frontend: `apps/frontend/src/pages/subtitle-intelligence/`
- Depends on the `auth`, `files`, `audit`, `settings`, and `media_manager` modules.

> This module extends [MEDIA_MANAGER.md](MEDIA_MANAGER.md): it reuses `MediaItem`,
> `MediaFile` (mediainfo probe data) and `MediaExternalId`, and the subtitles it
> installs are ordinary sidecars that Media Manager's `MediaSubtitleService`
> continues to discover.

---

## Contents

- [Overview](#overview)
- [Video fingerprinting](#video-fingerprinting)
- [Providers](#providers)
- [Search strategy](#search-strategy)
- [Scoring engine](#scoring-engine)
- [Validation engine](#validation-engine)
- [Synchronization](#synchronization)
- [Installation & naming](#installation--naming)
- [Language policy](#language-policy)
- [REST API](#rest-api)
- [Events & automation](#events--automation)
- [Security model](#security-model)
- [Data model](#data-model)
- [Frontend pages](#frontend-pages)
- [Roadmap](#roadmap)

---

## Overview

The pipeline, end to end:

```
fingerprint ─▶ search (L1 hash → L2 release → L3 external-id → L4 title)
     │                        │
     │                        ▼
     │                     score (0–100 → auto/download/present/reject)
     │                        │
     ▼                        ▼
 (reused MediaFile probe)  validate ─▶ install sidecar ─▶ media-server refresh ─▶ notify
```

Every route is guarded by `JwtAuthGuard` + `PermissionsGuard`; downloads, provider
changes, and language-policy changes are audited. Long-running work runs through
an in-process queue (`SubtitleJob`) that streams progress over WebSocket and
fails orphaned rows out on restart — the same pattern as Media Manager's job
queue.

### Graceful degradation (no hard binary requirements)

Consistent with the rest of the platform (the mediainfo probe is optional),
Subtitle Intelligence never *requires* an external binary:

- **Validation** has a pure, dependency-free core that parses SRT/VTT/ASS text
  directly. An optional deeper pass (subtitle end vs measured runtime) uses the
  existing mediainfo/ffprobe data when present and no-ops otherwise.
- **Synchronization** ships behind a provider abstraction; the FFsubsync provider
  stays inert when the binary is absent (see [Synchronization](#synchronization)).

---

## Video fingerprinting

`VideoFingerprintService` builds a media file's search **identity**
(`SubtitleFingerprint`, one row per item). It reads only 128 KiB regardless of
file size, confined to the ops hard roots (`FilePathService`), and reuses what
Media Manager already measured rather than re-probing:

| Field | Source |
|-------|--------|
| `movieHash` | OpenSubtitles hash — file size + first & last 64 KiB (`fingerprint/moviehash.ts`, pure) |
| `sha256` | Sampled content hash (head+tail+size) — cheap, dedup-friendly, not a full-file digest |
| `runtimeSec`, `frameRate`, `resolution`, `videoCodec`, `audioCodec`, `container`, `releaseGroup`, `hdr` | `MediaFile` (mediainfo probe) |
| `imdbId`, `tmdbId`, `tvdbId` | `MediaExternalId` (+ `MediaItem.seriesImdbId` for TV episodes) |
| `season`, `episode`, `mediaType` | `MediaItem` |

The **movie hash** is the highest-confidence key: a match means the subtitle was
timed against *this* encode, which is why it floors the score at the auto tier.

---

## Providers

Business logic depends only on the `SubtitleProvider` interface
(`providers/subtitle-provider.ts`); `SubtitleProviderRegistry` is the sole place
that knows concrete classes. Provider config (enablement, priority, credentials)
lives in `SubtitleProviderConfig`, with secrets AES-256-GCM encrypted at rest.

| Provider | Kind | Credentials |
|----------|------|-------------|
| **OpenSubtitles** | Official REST API | API key (+ username/password for downloads) |
| **SubDL** | Official REST API | API key |
| **Local Repository** | Offline (filesystem) | repo path (within the hard roots) |
| **Podnapisi** | Unofficial JSON API | none |
| **YIFY Subtitles** | Scraping (movies, IMDb id) | none |
| **SubtitleCat** | Scraping (by title, auto-translated) | none |
| Addic7ed · Subs4Free | Interface prepared | — |

- **SubDL / YIFY / Podnapisi** serve subtitles as ZIPs, extracted with the
  dependency-free reader in `providers/zip.ts` (zlib `inflateRaw` + a
  central-directory parse — no unzip binary). **SubtitleCat** serves plain `.srt`.
- **Local Repository** is fully offline: it walks a configured folder (validated
  to sit inside `FILE_MANAGER_ROOTS`) for subtitle files matching the media by
  title/release, and — for an episode query — never returns the wrong `SxxEyy`.
- ⚠️ **YIFY and SubtitleCat are SCRAPING providers** — the sites have no API, so
  these parse public HTML. They are best-effort by nature (a site redesign can
  break the parser) and were verified against the live sites at build time
  (YIFY's ZIP download requires a `Referer`, which is handled; SubtitleCat exposes
  auto-translated languages in the `.srt` filename, flagged `machineTranslated`).
  Each provider only fetches from its own hosts (per-provider SSRF allow-list).
- **Podnapisi** uses its structured JSON search (not scraping), but is an
  unofficial endpoint; its normalization is unit-verified against the documented
  shape rather than a live response.

> **User-Agent is mandatory.** OpenSubtitles (and any Cloudflare-fronted host)
> reject a UA-less request — the exact trap the Trakt integration hit. Every
> provider call sends `User-Agent` + `Api-Key`. Downloads consume a small daily
> quota (via a JWT from `/login`); the remaining quota is surfaced, never
> discovered mid-pipeline.

---

## Search strategy

`search/search-strategy.ts` plans progressively-relaxed levels, most-confident
first, and the service stops relaxing once a level yields an auto-tier candidate:

| Level | Matches on |
|-------|-----------|
| **1** | Exact movie hash (+ file size) |
| **2** | Release name / group / source / resolution |
| **3** | IMDb / TMDB / TVDB + season/episode/year |
| **4** | Title + year + season/episode |

A **title-only (level 4) match is never auto-accepted** — `levelAllowsAutoAccept`
excludes it, and the pipeline presents rather than installs it.

---

## Scoring engine

`search/scoring.ts` (pure) turns every candidate into a normalized **0–100**
score and an action tier:

| Signal | Δ | | Signal | Δ |
|--------|---|-|--------|---|
| Movie hash | +50 | | Preferred language | +5 |
| File size | +10 | | Forced (when wanted) | +3 |
| External id | +15 | | Preferred provider | +3 |
| Season/episode | +15 | | Machine translation | −20 |
| Release group | +10 | | Wrong runtime | −25 |
| Runtime match | +8 | | Wrong edition | −40 |
| Source / resolution | +5 / +3 | | Unknown release | −10 |
| Trusted uploader | +4 | | | |

| Tier | Range | Behaviour |
|------|-------|-----------|
| `auto` | 90–100 | Download + validate + install automatically |
| `download` | 75–89 | Download, verify sync, install if it checks out |
| `present` | 50–74 | Surface to the user; never auto-install |
| `reject` | <50 | Discard |

An exact hash match **floors** the score at 90 regardless of other metadata — a
same-encode guarantee is trusted on its own.

---

## Validation engine

`validation/subtitle-validator.ts` (pure) parses SRT/VTT/ASS and rejects broken
subtitles before install: empty/unrecognizable bodies, malformed cues, negative
or inverted timestamps, and out-of-order cues are **errors** (invalid); overlaps
and unusually large gaps are non-fatal **warnings**. It returns the timing
envelope (`startMs`/`endMs`) so an optional runtime cross-check can compare the
subtitle end to the media's measured duration.

---

## Synchronization

Behind the `SubtitleSynchronizationProvider` abstraction, two engines ship:

- **Manual offset** (`ManualOffsetProvider`) — pure, always available. Shifts
  every timestamp by an operator-supplied offset (and optional linear drift)
  via `sync/retime.ts`, preserving the file's exact format. This is the fallback
  that works with no binary at all.
- **FFsubsync** (`FfsubsyncProvider`) — audio-based automatic sync. **Inert when
  the `ffsubsync` binary is absent**: `isAvailable()` probes once (like the
  mediainfo `hasBinary`), and the workflow records "sync skipped (ffsubsync not
  installed)" rather than failing. See [Installing the optional binaries](#installing-the-optional-binaries).

The workflow (`SubtitleSyncService`) is: choose the engine (auto → FFsubsync when
available, else the supplied manual offset) → re-time → `validateSync` (reject an
implausible offset) → **preserve the original** (copied to a `.orig` sibling,
never overwritten) → **install the synced copy** as the active sidecar → record a
`SubtitleSynchronization` row (provider, method, offset, drift, confidence,
original + synced paths). `GET …/sync/capabilities` reports which engines can run.

### Validation depth (runtime cross-check)

Beyond the pure structural checks, the download flow now runs an optional
**runtime cross-check** (`validation/runtime-check.ts`): it compares the
subtitle's last cue to the media's *measured* runtime (already on `MediaFile`
from the mediainfo probe — no new binary). A subtitle that ends well **after** the
media does is almost certainly timed for a different cut, so it is rejected. The
delta and method (`pure` vs `mediainfo`) are recorded on `SubtitleValidation`.

## Installing the optional binaries

Automatic sync needs `ffmpeg` + `ffsubsync` (and the technical probe uses
`mediainfo`). None are required — the module degrades gracefully — so they are
**not** baked into the default image. Provision them with the idempotent script:

```sh
ops/scripts/install-subtitle-tools.sh          # mediainfo + ffmpeg + ffsubsync
WITH_FFSUBSYNC=0 ops/scripts/install-subtitle-tools.sh   # skip the heavy sync stack
```

For Docker, opt in at build time (keeps the default image lean):

```sh
docker build --build-arg INSTALL_SUBTITLE_SYNC=true -f apps/backend/Dockerfile .
```

---

## Installation & naming

`SubtitleInstallService` writes the sidecar next to the video using the
convention Plex / Jellyfin / Emby / Kodi all read (`sidecarPath`, pure):

```
Movie (2020).en.srt      Movie (2020).es-PR.srt
Movie (2020).en.forced.srt   Movie (2020).en.sdh.srt   Show - S01E01.en.srt
```

The write is confined to the hard roots and **never overwrites an existing file
it did not create** — a colliding target gets a numbered variant. Installed
subtitles are recorded in `SubtitleDownload` and linked into `MediaSubtitle` so
they show up in Media Manager immediately.

---

## Language policy

`SubtitleLanguageSetting` is per library: required / preferred / forced languages,
hearing-impaired and machine-translation preferences, preferred-provider order, a
minimum acceptance score, and automatic replacement. Search defaults its language
list from these when the caller does not specify one.

---

## REST API

All paths under the global `/api` prefix, guarded by `JwtAuthGuard` +
`PermissionsGuard`.

| Method | Path | Permission |
|--------|------|------------|
| GET | `/subtitle-intelligence/dashboard` | `subtitle_intelligence.view` |
| GET | `/subtitle-intelligence/providers` | `subtitle_intelligence.view` |
| PATCH | `/subtitle-intelligence/providers/:provider` | `subtitle_intelligence.providers` |
| POST | `/subtitle-intelligence/providers/:provider/test` | `subtitle_intelligence.providers` |
| POST | `/subtitle-intelligence/providers/health-check` | `subtitle_intelligence.providers` |
| POST | `/subtitle-intelligence/libraries/:libraryId/scan-missing` | `subtitle_intelligence.search` (detached) |
| GET | `/subtitle-intelligence/libraries/:libraryId/languages` | `subtitle_intelligence.view` |
| PATCH | `/subtitle-intelligence/libraries/:libraryId/languages` | `subtitle_intelligence.settings` |
| POST | `/subtitle-intelligence/items/:id/fingerprint` | `subtitle_intelligence.search` |
| POST | `/subtitle-intelligence/items/:id/search` | `subtitle_intelligence.search` |
| GET | `/subtitle-intelligence/items/:id/candidates` | `subtitle_intelligence.view` |
| POST | `/subtitle-intelligence/candidates/:candidateId/download` | `subtitle_intelligence.download` |
| GET | `/subtitle-intelligence/sync/capabilities` | `subtitle_intelligence.view` |
| POST | `/subtitle-intelligence/downloads/:downloadId/synchronize` | `subtitle_intelligence.synchronize` |
| GET | `/subtitle-intelligence/downloads/:downloadId/synchronizations` | `subtitle_intelligence.view` |
| POST | `/subtitle-intelligence/validate` | `subtitle_intelligence.view` |
| GET | `/subtitle-intelligence/downloads` | `subtitle_intelligence.view` |
| GET | `/subtitle-intelligence/history` | `subtitle_intelligence.view` |

### Permissions

| Permission | Grants |
|------------|--------|
| `subtitle_intelligence.view` | Read dashboard, providers, candidates, downloads, history. |
| `subtitle_intelligence.search` | Fingerprint + search an item. |
| `subtitle_intelligence.download` | Download + install a subtitle. |
| `subtitle_intelligence.synchronize` | Synchronize a subtitle (reserved for phase 2). |
| `subtitle_intelligence.manage` | Bulk operations (reserved). |
| `subtitle_intelligence.providers` | Configure / test providers. |
| `subtitle_intelligence.settings` | Change per-library language policy. |
| `subtitle_intelligence.admin` | Full module administration (reserved). |

Role grants: Power User holds view → settings (all but `admin`); User holds
`view` + `search`; Read-Only holds `view`.

---

## Events & automation

- **WebSocket** (scoped to `subtitle_intelligence.view`): `subtitle_intelligence.job.*`,
  `.downloaded`, `.download_failed`, `.synchronized`, `.validation_failed`.
- **Notification Center** domain events on the bus: `subtitle.downloaded`,
  `subtitle.failed`, `subtitle.missing`, `subtitle.synchronized`,
  `subtitle.validation_failed`, `subtitle.updated`.
- **Automation triggers** (category `subtitle`): `subtitle.missing`,
  `subtitle.downloaded`, `subtitle.synchronized`, `subtitle.validation_failed`.
  **Actions**: `subtitle_scan_missing` (scan a library — usable from any trigger,
  e.g. `torrent.completed → subtitle_scan_missing`) and `subtitle_download`
  (fetch the best candidate for the trigger's `itemId`). Fired via a lazy
  `AutomationEngine` lookup so the module never hard-depends on automation.

## Background jobs

Two `@Interval` schedulers keep libraries healthy without user action (each
re-entrancy-guarded, each unit isolated):

| Job | Cadence | Behaviour |
|-----|---------|-----------|
| `subtitle_provider_health` | hourly | Liveness + quota refresh for enabled providers (no-op when none configured). |
| `subtitle_missing_scan` | 5-min tick, **opt-in** | When `media.subtitles.autoScanIntervalMinutes` is set, sweeps enabled libraries for gaps. |

The **missing-subtitle scan** diffs each matched item's present languages (this
module's downloads + Media Manager's discovered sidecars) against the library's
policy, raises `subtitle.missing` (Notification Center + automation trigger) per
gap, and — when `media.subtitles.autoDownload` is on — fetches the best candidate
meeting the library's minimum score. It reads `MediaItem` rows, so it covers
freshly-downloaded items on its next pass with **no media-pipeline coupling**. Run
it on demand with `POST …/libraries/:id/scan-missing` (detached → `{ jobId }`).

---

## Security model

- **Root-path enforcement.** Fingerprint reads and sidecar writes call
  `FilePathService.assertWithinHardRoots(...)`, confining all filesystem access to
  `FILE_MANAGER_ROOTS`.
- **Encrypted credentials.** Provider secrets (API key / username / password) are
  AES-256-GCM encrypted at rest via `SecretCipher` and redacted (`••••••••`) in
  every API response.
- **SSRF + download safety.** Provider hosts are allow-listed; downloads are
  size-capped and format-sniffed, and validated before ever touching disk.
- **RBAC + auditing.** Every route is permission-gated; downloads, provider
  changes, and language-policy changes are audited with actor + request origin.

See [SECURITY.md](SECURITY.md).

---

## Data model

Prisma models (`apps/backend/prisma/schema.prisma`, migration
`20260715120000_subtitle_intelligence`):

| Model | Purpose |
|-------|---------|
| `SubtitleProviderConfig` | Per-provider enablement, priority, encrypted creds, health, quota. |
| `SubtitleFingerprint` | A file's search identity (hashes + technical metadata + ids). |
| `SubtitleCandidate` | A normalized, scored provider result. |
| `SubtitleDownload` | An installed subtitle (authoritative acquisition record). |
| `SubtitleValidation` | A pre-install structural (+ optional runtime) check result. |
| `SubtitleLanguageSetting` | Per-library language policy. |
| `SubtitleHistory` | Append-only per-item action trail. |
| `SubtitleJob` | In-process job row for WebSocket progress + restart reconciliation. |
| `SubtitleSynchronization` | A sync result (provider/method/offset/drift/confidence + preserved original & synced paths). |

---

## Frontend pages

All routes wrapped in `<ModuleRoute moduleId="subtitle_intelligence">` and gated
on `subtitle_intelligence.view`:

| Route | Page |
|-------|------|
| `/subtitles` | Dashboard (totals, provider health, by-language) |
| `/subtitles/search` | Item search → scored candidates → download |
| `/subtitles/sync` | Synchronization — engine status + per-download auto/manual sync |
| `/subtitles/validation` | Validation dry-run — paste a subtitle, see issues |
| `/subtitles/languages` | Per-library language policy + "scan for missing" |
| `/subtitles/history` | Installed subtitles + full activity trail |
| `/subtitles/providers` | Provider configuration + connection test |

---

## Roadmap

Phase 1 shipped fingerprinting, OpenSubtitles, the 4-level search, scoring,
validation, install, and the core UI. **Phase 2** added synchronization (FFsubsync
+ manual offset, inert-safe), the runtime cross-check, the Synchronization +
Validation UI, and the optional-binary installer. **Phase 3** added the **SubDL**
and **Local Repository** providers and the per-library **Language Policy** UI.
**Phase 4** adds the automation triggers/actions, the missing-subtitle scan +
provider-health **background jobs**, the bulk scan endpoint, and the Downloads /
History UI. Later phases add: Alass, and further hardening (broader tests, the
public docs site page).

See also: [MEDIA_MANAGER.md](MEDIA_MANAGER.md) · [ARCHITECTURE.md](ARCHITECTURE.md)
· [SECURITY.md](SECURITY.md).
