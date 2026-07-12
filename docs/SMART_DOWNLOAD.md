# Smart Download

**Smart Download** is UltraTorrent's acquisition decision engine. Instead of grabbing
the first matching release, it evaluates every candidate and selects the **best
acceptable** one — deciding *what* to acquire, *when*, *which release*, and *whether to
upgrade* something you already have.

It is the evolution of the **Media Acquisition Intelligence** module
(`media_acquisition_intelligence`, RBAC `media_acquisition.*`) — see
[MEDIA_ACQUISITION_INTELLIGENCE.md](MEDIA_ACQUISITION_INTELLIGENCE.md) for the
watchlist/profile/approval foundations this builds on.

> **It orchestrates, it does not duplicate.** Smart Download consumes the RSS module's
> **Smart Match** preference lists (`match-engine.ts` / `buildSmartCandidates`) and the
> Release Scoring engine as the source of truth — it never re-implements quality
> preferences. See the RSS Smart Match endpoints in [API.md](API.md).

## Contents
- [Decision pipeline](#decision-pipeline)
- [Decisions](#decisions)
- [Acquisition profiles](#acquisition-profiles)
- [Upgrade intelligence](#upgrade-intelligence)
- [Waiting & upgrade queues](#waiting--upgrade-queues)
- [Missing-media detection](#missing-media-detection)
- [Execution](#execution)
- [Decision Simulator](#decision-simulator)
- [Dashboard](#dashboard)
- [API](#api)
- [Data model](#data-model)
- [Not yet implemented](#not-yet-implemented)
- [Active indexer search (shipped)](#active-indexer-search-shipped)

## Decision pipeline

Every candidate release runs through one explainable pipeline
(`AcquisitionEvaluatorService.gather()` → the pure `decide()` function):

```
Candidate → Identify media → Matching preferences → Release score
          → Library comparison → Upgrade rules → Decision (+ explanation)
```

Each stage is recorded as a `TraceStep`, and the **Decision Simulator** renders them as a
clickable pipeline. The engine is invoked with a release name (+ optional
`downloadUrl`, `profileId`, `sizeBytes`, `seeders`) and can be driven from RSS matches,
manual/API evaluation, and the missing-media scanners; the watchlist item is what marks
content as *wanted*.

## Decisions

`decide()` is pure and deterministic and returns exactly one of:

| Decision | Meaning |
|---|---|
| `download` | Wanted, missing, above thresholds → acquire. |
| `upgrade_existing` | Owned, but this release is meaningfully better → acquire + remove the old one. |
| `replace_existing` | (Reserved) forced replacement. |
| `wait` | Acceptable but below the profile's wait cutoff → hold for a better release. |
| `hold_for_approval` | Would download, but a trigger (low score, duplicate risk, huge file, forced approval) needs a human. |
| `manual_review` | Ambiguous match across library/watchlist. |
| `skip` | Excluded term, rejected by scoring, already owned in equal/better quality, below minimum, or not wanted. |

Every decision carries a `reason`, a `confidence` (0–100), `requiresApproval`, and the
full `trace` — all persisted on the `MediaAcquisitionEvaluation`.

## Acquisition profiles

An **acquisition profile** (`MediaAcquisitionProfile`) bundles the acquisition policy.
Beyond the Smart Match / scoring preferences it references, the fields Smart Download
reads are:

- `minimumScore` — below this → `skip`.
- `approvalScore` — below this → `hold_for_approval`.
- `duplicateRules.allowUpgrades` — whether upgrades are permitted.
- `automationRules.approvalRequired` — force approval for everything.
- `qualityRules.waitForBetter` + `qualityRules.waitUntilScore` — the **wait policy**: a
  fresh release scoring ≥ minimum but < `waitUntilScore` becomes `wait` instead of
  downloading.

## Upgrade intelligence

Upgrades are **multi-dimensional**, not resolution-only (`quality-compare.ts`). A
candidate is ranked against the owned release across:

| Dimension | Order (best → worst) |
|---|---|
| Resolution | 2160p > 1080p > 720p > 480p |
| Source | Remux > BluRay > WEB-DL > WEBRip > HDTV |
| HDR | Dolby Vision > HDR10+ > HDR10 > HLG > SDR |
| Audio | Atmos / DTS:X > TrueHD / DTS-HD > DD+ > DTS/DD > AAC |
| Channels | 7.1 > 5.1 > 2.0 |

Codec (HEVC/AV1 vs AVC) is a scoring tiebreak but **never triggers an upgrade on its own**
— an x264→x265 re-encode at the same quality is not worth re-downloading. When a candidate
wins, the winning dimensions surface in the decision reason (e.g. *"owned, lower quality
(resolution 2160p > 1080p, HDR Dolby Vision > SDR)"*).

## Waiting & upgrade queues

- **Waiting queue** (`GET /waiting`) — releases held by the `wait` policy, so you can see
  what the engine is deliberately holding out on.
- **Upgrade queue** (`GET /upgrades`) — `upgrade_existing`/`replace_existing` decisions,
  each annotated `upgradeStatus: pending | completed` from its download action.
- **Rejected** (`GET /rejected`) — rejected or skipped evaluations.

## Missing-media detection

Monitored content becomes acquisition candidates by comparing the local IMDb catalogue
against the library:

- **Missing episodes** — `MissingEpisodesService` diffs `imdb_episodes` for a monitored
  `series`/`season` watchlist item against `MediaItem` (see [MISSING_EPISODES.md](MISSING_EPISODES.md)).
- **Missing seasons** — a per-season rollup of the episode gaps (`listSeasons`).
- **Missing movies** — `MissingMoviesService` checks a monitored `movie` watchlist item
  (with an IMDb id) against the library via the IMDb external-id link or a title+year
  match, producing `WantedMovie` rows classified `owned`/`missing`/`unaired`/`ignored`.

## Execution

Decisions actually acquire. `SmartDownloadExecutorService` turns a `download_torrent`
action into a real download via the engine (`addMagnet`/`addTorrentURL`), and on an
upgrade removes the superseded torrent + data (`removeTorrentAndData`). It is idempotent
per action. Auto (non-approval) decisions execute inline during `evaluate()`;
`hold_for_approval` decisions execute when `approve()`/`override()` is called. A decision
with no `downloadUrl` (e.g. a detected gap with no available release) stays advisory.

## Decision Simulator

`POST /simulate` runs the full pipeline for a release and returns the decision plus a
stage-by-stage explanation — **with no side effects** (no evaluation persisted, no action,
no download). The **Decision Simulator** page renders it as a clickable visual pipeline,
so you can see exactly why any release would be chosen or rejected.

## Dashboard

The **Smart Download** page shows a widget grid (Approved · Pending approval · Waiting ·
Pending upgrades · Rejected · Missing episodes · Missing movies · Watchlist), recent
decisions, and the Waiting / Upgrades / Rejected queues.

## API

All under `/api/media-acquisition` (see [API.md](API.md) for the full list):

| Method + path | Purpose |
|---|---|
| `POST /evaluate` | Evaluate a release (persists + can execute). `media_acquisition.evaluate` |
| `POST /simulate` | Dry-run decision + pipeline explanation. `media_acquisition.view` |
| `GET /waiting` · `/upgrades` · `/rejected` | Queue views. `media_acquisition.view` |
| `GET /overview` | Dashboard metrics. `media_acquisition.view` |
| `GET/POST /missing-movies*`, `/missing-movies/:id/ignore\|unignore` | Missing movies. |
| `GET /missing-episodes/:id/seasons` | Missing-season rollup. |

## Data model

New tables added by Smart Download (all additive migrations):

- `WantedEpisode` / `WantedMovie` — computed missing-media status per monitored item.
- (existing) `MediaAcquisitionEvaluation` / `MediaAcquisitionAction` carry the decision,
  trace, approval status, and the execution result (`torrentHash`, `removedHash`).

## Not yet implemented

Smart Download is built in phases; these remain:

- **Automation triggers** — firing workflow triggers (Smart Download Approved/Rejected/
  Upgrade…) into the Automation engine.
- **User notifications** — per-user notifications on decision events.
- **`replace_existing`** generation — the decision type exists but `decide()` does not yet
  emit it.

## Active indexer search (shipped)

Gaps are **not** only filled when a release happens to appear via RSS. `MissingEpisodeSearchService`
searches your indexers for a wanted episode (`indexers.searchAll`), filters the results to the exact
`SxxEyy`, and hands the candidates to the evaluator, which applies your acquisition profile — so a
missing episode can be found and grabbed proactively.

Two ways in:

- **On demand** — **Search now** on a missing episode, or **Search all** on a series. Always available.
- **Scheduled sweep** — `sweep()` walks the wanted list on an interval. It is **opt-in**
  (`settings.autoSearchMissing`, default **OFF**), so nothing searches behind your back until you
  turn it on.

Still episode-only: missing *movies* are detected (`WantedMovie`) but nothing sweeps them yet.

See [MISSING_EPISODES.md](MISSING_EPISODES.md) and [INDEXERS.md](INDEXERS.md).
