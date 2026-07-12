---
id: workflows
title: Workflows
sidebar_position: 5
description: The seven canonical end-to-end flows, as Mermaid diagrams — downloading a movie, automating a TV show, an RSS rule firing, Smart Download filling a gap, media import and rename, a notification firing, and backup/restore.
keywords:
  - workflows
  - end to end
  - diagrams
  - flow
  - download a movie
  - automate tv show
  - rss rule
  - smart download
  - missing episode
  - media import
  - rename
  - notification
  - backup
  - restore
  - automation
  - pipeline
  - sequence diagram
---

# Workflows

Seven flows. Each one is what *actually* happens, drawn end to end, with the
component that owns each step named.

Read the diagram first, then the notes underneath it. Between them they explain
almost every "why did it do that?" you will ever have.

## Overview

```mermaid
flowchart LR
  W1["1 · Download<br/>a movie"]
  W2["2 · Automate<br/>a TV show"]
  W3["3 · An RSS<br/>rule fires"]
  W4["4 · Smart Download<br/>fills a gap"]
  W5["5 · Import<br/>and rename"]
  W6["6 · A notification<br/>fires"]
  W7["7 · Backup<br/>and restore"]

  W1 --> W5
  W2 --> W3
  W3 --> W5
  W4 --> W5
  W5 --> W6
```

## Purpose

To give you a mental index. When something misbehaves, find the flow it belongs
to, walk the diagram, and the broken step will usually be obvious.

## When to use this page

- After [Core Concepts](/learn/concepts), to see the concepts in motion.
- While debugging, to isolate which step failed.
- Before building automation, to see what already happens for free.

## Prerequisites

- A working install ([Quick Start](/learn/quick-start)).
- The vocabulary from [Core Concepts](/learn/concepts).

---

## Workflow 1 — Downloading a movie

The simplest flow, and the foundation of every other one.

```mermaid
sequenceDiagram
  autonumber
  actor U as You
  participant FE as Frontend (SPA)
  participant BE as Backend API
  participant EN as Engine
  participant TR as Tracker + peers
  participant DB as PostgreSQL

  U->>FE: Torrents → Add torrent (magnet)
  FE->>BE: POST /api/torrents
  BE->>BE: validate and SSRF-guard any URL fetch
  BE->>EN: add (XML-RPC/SCGI or Web API)
  BE->>DB: persist the torrent snapshot
  EN->>TR: announce
  TR-->>EN: peer list
  loop every ~2 seconds
    BE->>EN: poll state
    EN-->>BE: normalized torrent list + stats
    BE-->>FE: WebSocket push (permission-scoped)
    FE-->>U: the row updates itself
  end
  EN-->>BE: progress = 100%
  BE->>BE: emit torrent.completed
  Note over BE: This one event starts<br/>Workflow 5 (media pipeline)<br/>and any automation rules.
```

**Notes**

- The browser **never** touches the engine. Everything is normalized server-side.
- Adding by **URL** is fetched by the backend through an SSRF guard — a private-IP
  indexer must be listed in `SSRF_ALLOW_HOSTS`.
- `torrent.completed` is **edge-triggered** (progress crosses 100% on a live tick)
  **and backfilled** (`reconcileCompleted` re-evaluates torrents already complete
  that never crossed that edge — finished while the app was down, or a rule created
  afterwards). A success ledger keeps it idempotent, so each rule runs **once per
  torrent**.

:::note Screenshot needed
The **Torrents** page (`/torrents`) mid-download, showing a live progress bar and
the aggregate rates in the top bar.
:::

![Torrents page during an active download](/img/screenshots/workflow-movie-download.png)

---

## Workflow 2 — Automating a TV show

You never want to think about a show again. Two mechanisms can do that, and they
are complementary:

| Mechanism | Fires when | Good at |
| --- | --- | --- |
| **RSS rule** | A new item shows up in a feed (polled every 60s) | *Forward* acquisition — tonight's episode, minutes after it is posted. |
| **Smart Download + Missing Episodes** | A scan finds a gap between the IMDb catalogue and your library | *Backward* acquisition — the 43 episodes you never had. |

Use both. Together they cover the whole timeline.

```mermaid
flowchart TB
  START(["You want a show, forever"]) --> A["Add the series to the WATCHLIST<br/>/media-acquisition → Watchlist<br/>(needs an IMDb ID)"]
  A --> B["Create an RSS RULE for the show<br/>/rss → rule → media type = tv"]

  B --> C{"Is the show still<br/>airing?"}
  C -->|"ended / canceled"| D["BLOCKED unless you confirm<br/>(allowInactiveShowMonitoring)<br/>— the override is audited"]
  C -->|"active"| E["Rule saved,<br/>recommendation = recommended"]
  D --> E

  E --> F["Build the Smart Match Builder<br/>preference list on the rule detail page"]
  F --> G["FORWARD: rss_poll every 60s<br/>→ new episodes grabbed<br/>→ upgraded if something better appears"]

  A --> H["BACKWARD: Missing Episodes scan<br/>diffs the IMDb episode catalogue<br/>against your library"]
  H --> I["WantedEpisode rows:<br/>owned / missing / unaired / ignored"]
  I --> J["Search now / Search all,<br/>or the OPT-IN scheduled sweep"]
  J --> K["Indexer search → Smart Download<br/>→ auto-download or approval queue"]

  G --> Z(["Every episode, past and future"])
  K --> Z
```

**Notes**

- A series is **monitored** once it is on the watchlist **with an IMDb ID**. Use the
  **Add from library** picker on the Missing Episodes page rather than typing IDs.
- Missing-episode auto-search (`autoSearchMissing`) is **opt-in and off by default**.
  Manual **Search now** / **Search all** always work.
- If the show later **ends**, the background status-refresh job tells you — and
  emits `rss.show.ended` — but it **never disables your rule**. That is your call.

Full walkthrough: [Automating TV shows](/learn/tutorials/automating-tv-shows).

:::note Screenshot needed
The **RSS** page (`/rss`) rule dialog with the Media type selector set to `tv` and
the live **ShowStatusPanel** visible (status badge, recommendation banner, provider
and confidence, next/last-episode dates, poster).
:::

![RSS rule dialog with the TV show status panel](/img/screenshots/workflow-rss-show-status.png)

---

## Workflow 3 — An RSS rule fires

This is the flow people most often misread, because of the three-level
deduplication.

```mermaid
sequenceDiagram
  autonumber
  participant J as rss_poll job (every 60s)
  participant F as RSS feed
  participant R as Rule (include/exclude + preferences)
  participant SC as Release Scoring
  participant DD as Dedup (3 levels)
  participant EN as Engine
  participant DB as PostgreSQL

  J->>F: fetch feeds whose interval elapsed
  F-->>J: items
  loop each new item, each enabled rule
    J->>R: include regex matches? exclude regex misses?
    alt does not match
      R-->>J: ignore
    else matches
      R->>SC: score the parsed release
      SC-->>R: score 0–100 + accept/reject + reasons
      R->>DD: level 1 — seen (feedId, itemGuid)?
      R->>DD: level 2 — seen this info-hash (btih)?
      R->>DD: level 3 — already hold a release for this logical title?
      alt already held, equal or better
        DD-->>J: skip
      else strictly higher priority than what we hold
        DD->>EN: grab the new release
        DD->>EN: remove the superseded torrent + its data
        DD->>DB: update the RssAcquisition
      else nothing held
        DD->>EN: grab
        DD->>DB: record the acquisition
      end
    end
  end
```

**Notes**

- **Level 3 is the one that surprises people.** A rule with a preference list holds
  exactly **one release per logical title** (`movie:<title>:<year>` or
  `ep:<title>:<season>:<episode>`). It grabs the best available, *upgrades* when
  something strictly better appears (removing the old torrent **and its data**),
  and skips anything equal or worse.
- If a release title cannot be parsed into a release identity, level 3 falls back
  to plain per-release behavior.
- All three levels are enforced in **both** live polling and backfill.
- **Auto-download off** turns the rule into a recorder: matches are logged, nothing
  is grabbed. That is also what the `convert_rule_to_backfill` automation action
  does.

Full walkthrough: [Smart RSS rules](/learn/tutorials/smart-rss-rules).

:::note Screenshot needed
The **RSS rule detail** page (`/rss/rules/:ruleId`) showing the **Smart Match
Builder** with a ranked preference list of match candidates.
:::

![Smart Match Builder with a ranked preference list](/img/screenshots/workflow-smart-match-builder.png)

---

## Workflow 4 — Smart Download acquires a missing episode

Detection and downloading are two separate halves. Indexer search is the bridge.

```mermaid
sequenceDiagram
  autonumber
  participant SC as Missing Episodes scan
  participant CAT as Local IMDb episode catalogue
  participant LIB as Your library (MediaItems)
  participant W as WantedEpisode
  participant SR as MissingEpisodeSearch
  participant IX as Indexers (all enabled, priority order)
  participant EV as Smart Download evaluator
  participant EN as Engine

  SC->>CAT: enumerate every episode of the series
  SC->>LIB: which does the library own?
  Note over SC,LIB: primary signal = MediaItem.seriesImdbId<br/>falls back to a case-insensitive title match
  SC->>W: classify: owned / missing / unaired / ignored

  Note over SR: Triggered by "Search now",<br/>"Search all", or the scheduled<br/>sweep (OPT-IN, OFF by default)
  SR->>IX: searchAll(show title, SxxEyy)
  IX-->>SR: candidates (deduped cross-indexer by info-hash)
  SR->>SR: filter to the EXACT SxxEyy
  SR->>SR: pick the best (magnet preferred, then seeders)
  SR->>EV: evaluate(releaseName, downloadUrl, profile)

  EV->>EV: identify → preferences → score →<br/>compare to library → upgrade rules
  alt decision = download
    EV->>EN: add magnet / .torrent
    EV-->>W: searchStatus = grabbed
  else decision = hold_for_approval
    EV-->>W: searchStatus = pending_approval
  else decision = skip / wait
    EV-->>W: searchStatus = no_results or stays idle
  end
```

**Notes**

- `searchStatus` walks `idle → searching → grabbed | pending_approval | no_results | failed`
  and is **preserved across rescans** (like your `ignored` overrides), so a grabbed
  episode is never re-searched. It clears once the episode is owned.
- Duplicate-grab safety is layered: `searchStatus` excludes grabbed/pending rows ·
  a `lastSearchedAt` backoff · a re-entrancy guard on the sweep · cross-indexer
  dedup by info-hash · and the evaluator's own **owned** check.
- A candidate only matches when its scene title **parses to the show name**. A show
  known by a different alias may be skipped rather than mis-grabbed.

:::caution Limits worth knowing
Automatic search is **episode-only** today — `WantedMovie` rows carry the same
grab-state columns, but there is no automatic movie search yet. Smart Download's
**automation triggers** and **per-user decision notifications** are also not wired
yet, and `replace_existing` exists as a decision type but is not emitted.
:::

:::note Screenshot needed
The **Missing Episodes** page (`/media-acquisition/missing-episodes`) showing a
series expanded into its season/episode grid, with per-episode **Search now**
buttons and `searchStatus` badges.
:::

![Missing Episodes page with the season and episode grid](/img/screenshots/workflow-missing-episodes.png)

:::note Screenshot needed
The **Decision Simulator** page (`/media-acquisition/simulator`) rendering the
decision pipeline for a pasted release name, with each trace step clickable.
:::

![Decision Simulator showing the explainable pipeline](/img/screenshots/workflow-decision-simulator.png)

---

## Workflow 5 — Media import and rename

What turns "a download" into "a library".

```mermaid
flowchart TB
  T["torrent.completed"] --> Q{"Is the save path inside an<br/>ENABLED library's root?"}
  Q -->|no| STOP["Nothing happens.<br/>Arbitrary downloads are<br/>NEVER auto-organised."]
  Q -->|yes| S["scan the save path"]
  S --> I["identify:<br/>parse the release name →<br/>type / title / year / season / episode<br/>+ confidence + matchStatus"]
  I --> M["metadata:<br/>local NFO · TMDB · IMDb"]
  M --> R["rename / move,<br/>per the library's MODE"]
  R --> A["artwork:<br/>poster · fanart · logo · …"]
  A --> SU["subtitles:<br/>sidecar discovery,<br/>missing-language detection"]
  SU --> N["NFO sidecars<br/>(Kodi-style)"]
  N --> RF["media-server refresh:<br/>Plex / Jellyfin / Emby / Kodi"]
  RF --> DONE["Library health updated"]

  S -.->|"media.detected"| AU["Automation rules"]
  I -.->|"media.matched / media.unmatched"| AU
  A -.->|"media.missing_artwork"| AU
  SU -.->|"media.missing_subtitles"| AU
  R -.->|"media.rename_completed"| AU
  RF -.->|"media.server_refresh_failed"| AU
```

**Notes**

- **Each stage is isolated.** A failure in one never aborts the rest, and the
  handler never throws (which protects the engine sync loop).
- The library's **`kind`** (`tv`/`anime`/`movie`) is **authoritative** over the
  filename for the movie/tv/anime axis. A folder like `9-1-1 (2018)` in a `tv`
  library is not mis-read as a movie. Only `general` libraries guess from filenames.
- For episodic layouts (`Show/Season NN/episode`), the **series title comes from the
  show folder**, not the filename — which is what stops a show fragmenting into one
  item per episode.
- Every dotted arrow is a real **automation trigger** you can hang your own rules on.

### There is also a periodic scan — and it behaves differently

```mermaid
flowchart LR
  TICK["5-minute tick"] --> DUE{"Any enabled library<br/>whose scan is DUE?"}
  DUE -->|"scanIntervalMinutes<br/>null or 0"| NEVER["Never auto-scanned.<br/>Manual scans only."]
  DUE -->|"due"| SCAN["scan the tree"]
  SCAN --> GAP["For items missing identity /<br/>metadata / art, fill ONLY the gap:<br/>identify → metadata → poster"]
  GAP --> NOTE["NO torrent context → fires no media.* triggers.<br/>NEVER renames or moves anything."]
```

That is deliberate: a routine scan **enriches in place**. Renaming stays the
download organiser's job. Only gaps are filled, so steady-state scans do almost no
work and never re-hammer the metadata providers.

:::note Screenshot needed
The **Media Dashboard** (`/media`) showing library health — unmatched items,
missing artwork, missing subtitles, duplicates.
:::

![Media dashboard showing library health](/img/screenshots/workflow-media-dashboard.png)

---

## Workflow 6 — A notification fires

Nothing about notifications is hardcoded. **Every** notification is a rule you own.

```mermaid
sequenceDiagram
  autonumber
  participant MOD as Any module
  participant BUS as Internal event bus
  participant NC as Notification Center
  participant RE as Rule engine
  participant RC as Recipients + groups
  participant PR as Preferences (opt-out)
  participant TE as Template engine
  participant Q as Delivery queue
  participant CH as Channel provider

  MOD->>BUS: emit an event envelope<br/>(e.g. download.torrent_completed)
  BUS->>NC: the Center is the sole subscriber
  NC->>RE: match enabled rules + conditions
  RE-->>NC: the rules that fired
  NC->>RC: resolve recipients (users, groups, the event's user)
  NC->>PR: honour per-user opt-outs
  NC->>TE: build the message + rich card per channel
  NC->>Q: enqueue (deduplicated)
  loop delivery worker
    Q->>Q: quiet hours · rate limit · retries · escalation
    Q->>CH: send
    CH-->>Q: status
  end
  Q-->>NC: history + WebSocket + audit
```

**Available channels**

| Channel | Backend | Rendering |
| --- | --- | --- |
| **Email** | SMTP | Responsive HTML card (poster, badges, buttons) + plain text |
| **Telegram** | Bot API | Photo + Markdown caption + inline-keyboard buttons |
| **SMS** | Twilio | Concise plain text |
| **WhatsApp** | Twilio | Rich text + poster media |

**Events you can build rules on** include downloads (`download.torrent_completed`,
`download.torrent_failed`, `download.stalled`, `download.ratio_reached`), RSS
(`rss.feed_failed`, `rss.rule_matched`, `rss.new_episode_available`), media
(`media.renamed`, `media.missing_subtitles`, `media.missing_episode_filled`,
`media.library_scan_completed`), media servers
(`media_server.user_started_watching`, `media_server.server_offline`), and system
(`system.disk_space_low`, `system.failed_login`, `system.new_login`,
`system.update_available`).

**The pages you will use**

| Page | Route | For |
| --- | --- | --- |
| Notification Center | `/notifications` | The dashboard. |
| Channels | `/notifications/channels` | Configure Email/Telegram/SMS/WhatsApp. Secrets encrypted at rest. |
| Rules | `/notifications/rules` | Event → conditions → channels → recipients. |
| Recipients | `/notifications/recipients` | Who gets what. |
| Delivery History | `/notifications/history` | Proof it went out (or why it did not). |

Full walkthrough: [Notifications and automation](/learn/tutorials/notifications-and-automation).

:::note Screenshot needed
The **Notification Rules** page (`/notifications/rules`) with a rule open, showing
the event selector, conditions, channels and recipients.
:::

![Notification rule editor](/img/screenshots/workflow-notification-rule.png)

---

## Workflow 7 — Backup and restore

The least exciting workflow and the only one whose absence will ruin your week.

```mermaid
flowchart TB
  subgraph WHAT["What actually matters"]
    A[("postgres_data<br/>users · roles · rules · libraries ·<br/>watchlist · audit log · settings")]
    B["'.env'<br/>especially ENCRYPTION_KEY"]
    C[("downloads<br/>re-downloadable, but slow")]
  end

  A --> R1["pg_dump → a .sql file"]
  B --> R2["copy it somewhere safe"]
  C --> R3["optional — your call"]

  R1 --> S["Store OFF the host"]
  R2 --> S
  R3 --> S

  S --> RESTORE["Restore:<br/>1. bring the stack up<br/>2. restore the dump<br/>3. put back the SAME .env"]
  RESTORE --> V["Verify: log in ·<br/>engines connect ·<br/>indexer keys still work"]
```

### Back up

```bash
# The database — this is the one that matters.
docker compose exec -T postgres \
  pg_dump -U ultratorrent ultratorrent > backup-$(date +%F).sql

# The secrets. Without ENCRYPTION_KEY the dump's encrypted columns are unreadable.
cp .env env-backup-$(date +%F)
```

:::danger `ENCRYPTION_KEY` and the database are one unit
`ENCRYPTION_KEY` is what decrypts the encrypted columns in that dump — 2FA/TOTP
secrets, indexer API keys, media-server tokens, notification credentials.
**A database restored without its matching key has a lot of unreadable secrets in
it.** Back them up together, restore them together, and store them somewhere that
is not the host you are backing up.
:::

### Restore

1. Bring up a stack with the **same `.env`** (same `ENCRYPTION_KEY`, same
   `POSTGRES_PASSWORD`).
2. Restore the dump into the fresh database.
3. Start the backend. It runs `prisma migrate deploy` on boot.
4. Verify, in this order: **log in** → **engines connect** → **an indexer Test still
   passes** (that proves the encrypted keys decrypted correctly).

:::warning Migrations are forward-only
If an upgrade goes wrong, you restore the **pre-upgrade** backup — you do not roll
a migration back. Take the backup *before* you upgrade, every time. See
[Upgrading](/install/upgrading).
:::

Full procedure, including scheduling and retention: [Backup &amp; restore](/operate/backup).

:::tip Watch this tutorial
_Video coming soon._
:::

---

## Examples

### Which workflow owns my problem?

| Symptom | Workflow | Start looking at |
| --- | --- | --- |
| Torrent stuck at 0% | 1 | Engine, tracker, peers |
| New episodes never grabbed | 2, 3 | Rule regex, feed interval, show status |
| The same episode grabbed twice | 3 | Release identity parsing (level-3 dedup) |
| An old episode never fills in | 4 | Watchlist IMDb ID, indexer results, `autoSearchMissing` |
| Files downloaded but never renamed | 5 | Library root vs. save path; library enabled? |
| I never hear about anything | 6 | Notification rules, channels, recipients |
| I lost everything | 7 | You did take a backup, right? |

---

## Troubleshooting

| Symptom | Likely workflow step | Fix |
| --- | --- | --- |
| Rule matches but never grabs | Workflow 3, dedup level 3 | You already hold an equal-or-better release for that logical title. Check the rule's acquisitions. |
| Rule grabs then immediately removes | Workflow 3 | That is an **upgrade** — a strictly higher-priority release appeared and superseded the old one. Working as designed. |
| Missing episode search finds nothing | Workflow 4 | The show's scene title does not parse to your watchlist title (an alias), or no indexer carries it. |
| Everything is `pending_approval` | Workflow 4 | Your acquisition profile has `approvalRequired`, or the score is below `approvalScore`. |
| Media stays `unmatched` | Workflow 5 | Poor release name. Fix on `/media/unmatched`, or improve the source naming. |
| Notification rule never fires | Workflow 6 | Wrong event name, an unmet condition, no recipient resolved, or the user opted out. Check **Delivery History**. |
| Restored DB, but indexers all fail | Workflow 7 | Wrong `ENCRYPTION_KEY`. The encrypted keys cannot be decrypted. |

---

## Tips

:::tip Read the trace, do not guess
Every Smart Download decision persists its **full trace**. The **Decision
Simulator** (`/media-acquisition/simulator`) replays the whole pipeline for any
release name with **zero side effects**. It will tell you exactly why something was
chosen or rejected in less time than it takes to form a theory.
:::

:::tip Delivery History is the notification equivalent
`/notifications/history` shows whether a message was queued, sent, retried or
failed — and why. Check it before assuming a rule did not fire.
:::

:::info Everything mutating is audited
Actor, IP, user agent and result, on **Administration → Audit Log** (`/audit`).
Including the show-status override on an ended series.
:::

---

## FAQ

**Do RSS rules and Smart Download fight each other?**
No — they share the same brains. Smart Download **consumes** the RSS module's
Smart Match preference lists and the Release Scoring engine as the source of truth.
It orchestrates; it does not re-implement quality preferences.

**Why did an RSS upgrade delete my torrent?**
Because it superseded it. Level-3 dedup holds one release per logical title: when a
strictly higher-priority release appears, it grabs the new one and removes the
old torrent **and its data**. If you do not want that, do not rank the better
release above the one you have.

**Can I run the media pipeline on files I did not download?**
Yes — that is what the **periodic library scan** is for. It enriches externally
dropped folders in place. But note it **never renames or moves**, and fires no
`media.*` triggers.

**What is the smallest useful backup?**
`pg_dump` + your `.env`. Everything else is re-downloadable.

---

## Checklist

- [ ] I can name the event that starts the media pipeline (`torrent.completed`).
- [ ] I can name the three levels of RSS deduplication.
- [ ] I know that missing-episode auto-search is **opt-in and off by default**.
- [ ] I know that the periodic library scan **never renames**.
- [ ] I know that notifications are **entirely rule-driven** — nothing is hardcoded.
- [ ] I have taken a `pg_dump` **and** backed up `.env` with `ENCRYPTION_KEY`.
- [ ] I have restored that backup at least once, somewhere disposable, and verified an indexer **Test** still passes.

### Expected results

| Verification | Expected |
| --- | --- |
| Add a torrent inside a library root, wait | It is renamed and appears in the media server. |
| Paste a release name into the Decision Simulator | A full, clickable trace with a decision and a reason. |
| Trigger a notification rule | A row in **Delivery History** with a `sent` status. |
| Restore your backup on a clean stack | You can log in, and an indexer **Test** passes. |

### Next steps

Pick the flow you want to own and go deep:

1. [Building a movie library](/learn/tutorials/building-a-movie-library) → Workflow 5
2. [Automating TV shows](/learn/tutorials/automating-tv-shows) → Workflows 2 + 4
3. [Smart RSS rules](/learn/tutorials/smart-rss-rules) → Workflow 3
4. [Notifications and automation](/learn/tutorials/notifications-and-automation) → Workflow 6

---

## See also

- [Torrents](/modules/torrents) · [RSS](/modules/rss) · [Smart Download](/modules/smart-download)
- [Missing Episodes](/modules/missing-episodes) · [Indexers](/modules/indexers)
- [Media Manager](/modules/media-manager) · [Automation](/modules/automation)
- [Notification Center](/modules/notification-center) · [Audit](/modules/audit)
- [Backup &amp; restore](/operate/backup) · [Upgrading](/install/upgrading)
- [Troubleshooting](/operate/troubleshooting) · [Glossary](/help/glossary)
