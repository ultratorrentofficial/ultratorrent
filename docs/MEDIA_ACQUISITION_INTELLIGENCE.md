# Media Acquisition Intelligence

A **core** module (id `media_acquisition_intelligence`) that decides **what
UltraTorrent should acquire**. It does not match RSS titles in isolation — it
**orchestrates** the existing modules into an explainable acquisition decision.
RBAC `media_acquisition.*`.

> **This module is now the foundation of [Smart Download](SMART_DOWNLOAD.md)**, which
> adds execution (decisions now actually download), a multi-dimensional upgrade
> comparison, missing movie/season/episode detection, waiting/upgrade queues, a decision
> simulator, and a dashboard. The "No file operations" boundary below describes the
> original design; execution is now performed by `SmartDownloadExecutorService` (see
> SMART_DOWNLOAD.md → Execution).

- [What it decides](#what-it-decides)
- [Boundary — it orchestrates, never replaces](#boundary--it-orchestrates-never-replaces)
- [Watchlist](#watchlist)
- [Acquisition profiles](#acquisition-profiles)
- [The evaluation engine](#the-evaluation-engine)
- [Decision rules](#decision-rules)
- [Explainable trace](#explainable-trace)
- [Approval queue](#approval-queue)
- [No file operations](#no-file-operations)
- [API](#api)
- [Permissions](#permissions)
- [Database](#database)
- [Integration: RSS, Automation, Visual Rule Builder](#integration-rss-automation-visual-rule-builder)

---

## What it decides

For every candidate release it answers: *Should this be downloaded? Why? How
important? Where should it go? Should it replace/upgrade an existing file? Hold
for approval? Skip?* — as one of:

```
download · skip · wait · hold_for_approval · upgrade_existing · replace_existing · manual_review
```

(`wait` — added by [Smart Download](SMART_DOWNLOAD.md#waiting--upgrade-queues) — holds an
acceptable-but-mediocre release for a better one. `replace_existing` is defined but
`decide()` never emits it yet.)

## Boundary — it orchestrates, never replaces

| Module | Responsibility |
|--------|----------------|
| RSS Automation | detects candidate releases |
| Release Scoring | scores release quality/desirability |
| Library state (snapshots) | what exists / what's missing |
| Media Manager | organises completed files |
| **Media Acquisition Intelligence** | **decides whether acquisition is valuable** |

It **reuses** Core's `parseTorrentName` and the Release Scoring engine
(`scoreRelease`) — no duplicated logic — and never replaces RSS Automation,
Release Scoring, or the Media Manager.

## Watchlist

Users declare what they want acquired (`MediaAcquisitionWatchlistItem`). Types:
`series`, `season`, `episode`, `movie`, `movie_collection`, `anime`,
`manual_query`. Items carry a priority, an optional acquisition profile, a
target library, and a status (`active`/`paused`/`completed`/`archived`).

A release is only treated as a **needed gap** when it is *wanted* (matches an
active watchlist item) **and** missing from the library — a random release that
simply isn't owned is **not** a gap.

## Acquisition profiles

`MediaAcquisitionProfile` defines preferences + constraints: `minimumScore`,
`approvalScore`, preferred resolution/codec/source/audio/HDR, required/excluded
terms, preferred groups, and `qualityRules`/`duplicateRules`/`storageRules`/
`automationRules` (JSON). Example: *TV 1080p HEVC — min score 85, approval below
90, prefer x265 WEB-DL, exclude CAM/TS*.

## The evaluation engine

`AcquisitionEvaluatorService.evaluate()` gathers signals → runs the **pure**
`decide()` function → persists an explainable `MediaAcquisitionEvaluation` →
emits events → routes to the approval queue (or, for an auto decision carrying a
`downloadUrl`, straight to the executor):

1. parse the release (`parseTorrentName`)
2. match the watchlist
3. library state (owned? at what quality?) → derive *needed* = wanted & missing
4. release score (`scoreRelease`)
5. duplicate risk
6. quality-upgrade opportunity
7. apply the acquisition profile (terms, score thresholds)
8. storage check (scaffold)
9. final decision + confidence + approval routing
10. store the trace + emit a WebSocket event
11. record a `download_torrent` action for a download-intent decision — executed
    immediately when no approval is required and a `downloadUrl` is present

`POST /simulate` runs steps 1–9 only and returns the same decision + a
stage-by-stage explanation with **no** persistence, action, or download.

## Decision rules

- **skip** — excluded term present; below `minimumScore`; not wanted (no
  watchlist match, no gap); already owned in equal/better quality; storage
  blocks it; missing a required term.
- **download** — wanted & missing, score ≥ `minimumScore`, low duplicate risk,
  storage OK, no approval trigger.
- **upgrade_existing** — owned but the new release is meaningfully better and the
  profile allows upgrades.
- **hold_for_approval** — score below `approvalScore`; low confidence; medium/
  high duplicate risk; unusually large file; storage near threshold; profile
  requires approval.
- **manual_review** — ambiguous (multiple library/watchlist matches).

## Explainable trace

Every evaluation stores a step-by-step trace (`trace.steps[]`), e.g.:

```json
{ "steps": [
  { "step": "release_scoring", "status": "success", "score": 92, "reason": "release score 92" },
  { "step": "watchlist_match", "status": "success", "reason": "matched an active watchlist item" },
  { "step": "library_need", "status": "success", "reason": "content is missing from the library" },
  { "step": "final_decision", "decision": "download", "reason": "Missing/wanted content above thresholds" }
] }
```

## Approval queue

Held evaluations (`approvalStatus = pending`) await an operator. **Approve**
(executes the pending download action through the Smart Download executor),
**Reject** (with a reason), or **Override** (force any decision — requires the
stronger `override` permission; a download/upgrade override also executes).

## No file operations

> **Superseded — kept for the design rationale.** This was the original boundary;
> `SmartDownloadExecutorService` now executes download actions (see
> [SMART_DOWNLOAD.md → Execution](SMART_DOWNLOAD.md#execution)).

A `download`/`upgrade` decision (or an approval/override) records a
`MediaAcquisitionAction`. Historically that action was purely a *recommendation*
left for permission-gated automation to carry out. Today an auto (non-approval)
decision with a `downloadUrl` executes inline during `evaluate()`, and a held one
executes on approve/override — adding the release to the engine and, on an
upgrade, removing the superseded torrent + data. What the module still **never**
does directly is rename/move/organise library files; that remains the Media
Manager's job.

## API

All under `/api/media-acquisition`, module-gated + RBAC. See [API.md](API.md).

| Group | Endpoints | Permission |
|-------|-----------|------------|
| Overview | `GET /overview` | `media_acquisition.view` |
| Watchlist | `GET /watchlist`, `GET /watchlist/:id` | `…view`; `POST/PATCH/DELETE` → `…manage_watchlist` |
| Profiles | `GET /profiles[/:id]` | `…view`; mutate → `…manage_profiles` |
| Evaluate | `POST /evaluate` | `…evaluate` |
| Evaluations | `GET /evaluations[/:id]` | `…view` |
| Approval | `GET /approval-queue`; `POST /evaluations/:id/approve|reject|override` | `…view` / `…approve` / `…reject` / `…override` |
| History | `GET /history` | `…history` |
| Recommendations | `GET /recommendations` | `…view` |
| Settings | `GET/PATCH /settings` | `…settings` |
| Export | `POST /export` | `…export` |

## Permissions

`media_acquisition.{view, manage_watchlist, manage_profiles, evaluate, approve,
reject, override, history, export, settings}`.

## Database

`MediaAcquisitionWatchlistItem`, `MediaAcquisitionProfile`,
`MediaAcquisitionEvaluation`, `MediaAcquisitionAction`,
`MediaAcquisitionHistory`.

## Integration: RSS, Automation, Visual Rule Builder

- **RSS**: an RSS item can be passed to `POST /evaluate` with
  `sourceType: "rss"`; the existing RSS rules are unchanged and keep working.
  The evaluation is optional and module-gated. The RSS module's
  [TV show airing-status awareness](RSS.md#tv-show-airing-status-awareness) is
  complementary: it steers rule creation away from ended/canceled shows (prefer
  backfill/upgrade), reinforcing the same "acquire only what's worth acquiring"
  goal at rule-authoring time.
- **Automation**: the module broadcasts its decisions as WebSocket events —
  `media_acquisition.evaluation.created`, `…approval.required`,
  `…download.recommended`, `…waiting`, `…download.skipped`, plus
  `…evaluation.approved` / `…evaluation.rejected` — all scoped to
  `media_acquisition.view` by the realtime gateway. Wiring these into the Core
  automation engine (as triggers/actions) is **not done yet**: the engine's
  trigger catalogue carries no acquisition entries.
- **Visual Rule Builder**: *not implemented.* Acquisition nodes (Evaluate
  Acquisition, Check Watchlist Match, Check Library Need, Check Duplicate Risk,
  Check Upgrade Opportunity, Require/Approve/Reject Acquisition) are a **design
  sketch only** — no such nodes exist in the automation surface today.

See also: [MODULES.md](MODULES.md), [MEDIA_MANAGER.md](MEDIA_MANAGER.md),
[SECURITY.md](SECURITY.md).
