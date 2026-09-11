---
id: index
title: Release Notes
sidebar_position: 1
description: What shipped in each version of UltraTorrent — new features, changes, and fixes.
keywords: [release notes, changelog, versions, what's new, upgrade]
---

# Release Notes

:::info Auto-generated
This page is generated from `CHANGELOG.md` at build time. **Do not edit it by hand** — change the changelog and rebuild.
:::

Every released version, newest first. This page shows the **25 most recent** of **213** releases; the complete history lives in [CHANGELOG.md](https://github.com/ultratorrentofficial/ultratorrent/blob/main/CHANGELOG.md).

Versions are [semantic](https://semver.org/): a **minor** bump means new capability, a **patch** means fixes only. Upgrading is covered in [Upgrading](/install/upgrading).

## 0.90.11 — 2026-09-11

_Latest release._

### Fixed

- Release a parked torrent once it finishes downloading. The revival test required a connected seed or active download throughput, and both are structurally zero for a completed torrent, so one that completed while parked was re-parked on every probe forever - and because the scheduler skips parked torrents, its seeding policy and age deadline were never evaluated again.
- Resolve the remaining CodeQL quality findings: a test double that did not match the API it stood in for, two untested probe failure paths, and a discarded close error that could report a truncated plan as written
- Media Discovery: the Monitored view is now sorted soonest release first and grouped under month headings, so upcoming premieres read chronologically

Tagged [`v0.90.11`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.11).

## 0.90.10 — 2026-09-09

### Fixed

- Media Discovery no longer adds unreleased shows to missing-episode tracking, which was searching indexers for episodes that had not aired
- Provider endpoints are validated at a shared trust boundary, redirects refused, and public unsubscribe parameters type-checked at the request boundary
- Storage capability probing refuses a root it cannot locate, so a blank storage profile path can no longer create and recursively delete a directory in the working directory
- A generated acquisition rung no longer treats a provider-supplied show title as a regular expression, and title canonicalisation is bounded against pathological input
- A hostile key in a torrent file or a provider configuration can no longer replace the prototype of the object it is copied into
- A file replaced between the safety check and the read is now refused rather than served, and artwork thumbnails stream from the same file they were measured from
- Provider HTML is reduced to text correctly: entity decoding no longer re-creates the tags that stripping removed, and a subtitle cue can no longer take quadratic time to render
- A local subtitle file is now size-bounded like a downloaded one, so an oversized file in the library cannot be read whole into memory
- CI actions are pinned to commit SHAs and the workflow token is limited to read access
- The backend image ships a patched npm, fixing CVE-2026-59873 in the tar library npm bundles
- The lint gate runs for the first time: ESLint is installed and configured, and the findings it surfaced are fixed
- Fix React hook dependencies: a nullish empty-array fallback no longer defeats every downstream memo, and four hooks now list what they close over

Tagged [`v0.90.10`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.10).

## 0.90.9 — 2026-09-08

### Fixed

- Discovery sends one consolidated notification per run instead of one per title, and each title carries its poster, synopsis, network, premiere, rating and genres

Tagged [`v0.90.9`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.9).

## 0.90.8 — 2026-09-08

### Fixed

- A monitored show leaves the Media Discovery catalogue once it grabs its first release; monitoring no longer ends because a premiere date passed; discovery-monitored series now track their missing episodes
- Unchecking a discovery template's automatic-monitoring or premiere-eligibility box now saves; five template fields were discarded on every save while still clearing the catalogue's decisions

Tagged [`v0.90.8`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.8).

## 0.90.7 — 2026-09-08

### Fixed

- re-evaluating an already-monitored title no longer competes for or spends the automatic-add budget

Tagged [`v0.90.7`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.7).

## 0.90.6 — 2026-09-08

### Fixed

- a rule's download directory is created when the rule is saved, so an acquisition cannot fail on a missing path
- a generated rule matches only its own show — a match-preference candidate with no show title matched every item in the feed
- a generated RSS rule is named for its show, without the year

Tagged [`v0.90.6`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.6).

## 0.90.5 — 2026-09-08

### Fixed

- a discovery template can be told not to monitor automatically, and a held title can be imported from review — creating everything an automatic monitor would
- refresh catalogues no longer contacts providers that are switched off
- a generated rule records its target path, so a template path template is no longer inert when intake directory creation is off
- discovery cards show the synopsis, network, rating and status, and a template can filter by network, streaming service or studio

Tagged [`v0.90.5`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.5).

## 0.90.4 — 2026-09-08

### Fixed

- discovery matches languages canonically, so a template naming English no longer rejects every TMDB title stored as en; and a title a template ruled out now says why instead of Not evaluated

Tagged [`v0.90.4`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.4).

## 0.90.3 — 2026-09-07

### Fixed

- discovery shows episode air times in your own timezone, and titles can be selected and removed in bulk

Tagged [`v0.90.3`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.3).

## 0.90.2 — 2026-09-07

### Fixed

- the docs image build includes the changelog the release notes page is generated from

Tagged [`v0.90.2`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.2).

## 0.90.1 — 2026-09-07

### Fixed

- the discovery catalogue can be managed: remove a title at a chosen scope with a preview of what goes, re-decide everything when a template changes, retract titles that stop matching, and page through the listing
- media discovery resolves canonical identity before auto-monitoring, so a show already on the watchlist, already ruled or already in the library is never monitored twice
- discovery auto-monitoring is limited to series that have not premiered yet, with unknown and conflicting dates held for review, so an old show airing this week is no longer imported automatically
- a discovery template must carry match preferences to auto-monitor, so every generated RSS rule can actually acquire — one without them matched nothing at all
- a duplicate reconciliation tool finds shows monitored more than once and proposes a safe merge — archiving rather than deleting, and never touching media, torrents or hand-authored rules
- match preference profiles can be authored from the UI — an ordered ladder editor with reordering, quality fields, size bounds and per-rung terms
- a disabled module says which of three things disabled it, instead of blaming an administrator for one that is simply off by default

Tagged [`v0.90.1`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.1).

## 0.90.0 — 2026-09-06

### New

- Media Discovery Engine foundation: a domain model for discovered media, a capability-routed provider seam, TMDB and TVmaze discovery providers, and a multi-provider identity merge that refuses to fuse two works sharing a title and year. Nothing is scheduled yet and no acquisition is triggered.
- Media Discovery can now decide what to monitor: discovery automation templates with a three-way category policy, acquisition rule templates that mirror the existing ranked match candidates, a pure policy evaluator with an explainable decision trace, a safe path renderer, and watchlist integration that never overrules an operator. Nothing is auto-monitored yet — no rule is generated and no schedule evaluates.
- Media Discovery now runs end to end: an hourly evaluation pass turns discovered titles into watchlist entries and generated RSS rules, with optional intake directory provisioning, preview mode, and rolling-window auto-add limits that hold excess titles for review rather than dropping them. Discovery automation remains off by default.
- Media Discovery gains its UI under Media Acquisition: an inbox where every title carries the reason it is there, provider management that distinguishes unconfigured from disabled from unhealthy, and a template editor with a four-way category policy and preview-before-enable. Acquisition-template ladders remain API-only for now.
- Media Discovery is documented: MEDIA_DISCOVERY.md for setup and operation, MEDIA_DISCOVERY_TEMPLATES.md for what every template field means. Security hardening closed three real defects — a non-numeric value bypassing a threshold, provider-supplied javascript: URLs reaching an img src, and Unicode direction overrides producing deceptive folder names — and the RBAC coverage test found that the role grants had never landed.

Tagged [`v0.90.0`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.0).

## 0.89.1 — 2026-09-04

### Fixed

- Movie identity is resolved through a cascade of evidence about the file — a sidecar NFO id, then the measured runtime, then the release name — so two films sharing a title and year can be told apart instead of both being rejected. A retitle rescue also matches films published under a different name than the folder uses.

Tagged [`v0.89.1`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.89.1).

## 0.89.0 — 2026-09-04

### New

- Recently Added shows posters, coloured type icons and the library each item landed in
- Modules are no longer split into core and community tiers

### Fixed

- The Jellyfin brand mark is the real logo rather than an approximation from memory
- Provider status cards show each media server's brand mark
- Destructive activity entries say what was deleted, by whom, and why
- The Plex marker in notifications is gold rather than orange
- Notification server tags use the product name alone, without a stand-in icon
- Newsletters verify every entry before sending: artwork and synopsis are required, gaps are repaired first, and what still fails is held back and carried to the next issue instead of going out as a blank card. Fixes a TMDB year filter that hid valid matches and a metadata row that named a provider which had found nothing.

Tagged [`v0.89.0`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.89.0).

## 0.88.0 — 2026-09-02

### New

- Add, edit and delete media server connections from the UI, with a test that runs before saving
- Duplicate detection can run on a schedule, configured from the Duplicates Center

### Fixed

- The Server Users nav entry shows its name instead of a raw translation key
- A successful connection test no longer renders as a failure in the add-connection dialog
- Live Activity names which media server each session is playing on
- Watch History names which media server each play came from
- Live Activity shows each media server's brand mark, so Plex and Jellyfin streams are told apart at a glance
- Media server brand marks appear on Connections, Server Users and Watch History too
- User deduplication no longer merges accounts across different media servers
- Jellyfin sessions show a real container name instead of ffprobe's demuxer alias list
- The media server chip is legible, and two icons sized with a Tailwind class that does not exist are fixed
- Playback notifications name the media server when more than one is connected

Tagged [`v0.88.0`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.88.0).

## 0.87.0 — 2026-08-31

### New

- Public URL settings, series NFO generation, and friendly names for media-server users — released as a minor for the new capability in v0.86.2

Tagged [`v0.87.0`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.87.0).

## 0.86.2 — 2026-08-31

### Fixed

- The SMTP settings test is recorded in the newsletter activity view, and a failed one reports the SMTP reason instead of a generic error
- Watch History shows completion, playback cost and device; the newsletter footer links the docs and repo
- Newsletter recipients can unsubscribe themselves through a signed link
- Settings gains a public URL, with live DNS, reachability and certificate checks
- Episode NFOs no longer carry the series id, which made scrapers merge every episode into one
- UltraTorrent writes tvshow.nfo for series, which previously had no NFO of their own
- Set a friendly name for media-server users, so account handles become readable names
- Server Users page: set a friendly name and email for users from any connected media server

Tagged [`v0.86.2`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.86.2).

## 0.86.1 — 2026-08-27

### Fixed

- Email settings gain a TLS certificate name for relays whose certificate does not carry the SMTP host, newsletter test sends are recorded in the activity view, and a failed test reports the SMTP reason instead of a generic error

Tagged [`v0.86.1`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.86.1).

## 0.86.0 — 2026-08-27

### New

- A global bandwidth ceiling in settings, which the Activity Scheduler overrides only on engines it governs
- Settings gains a global bandwidth ceiling with per-engine status, in both locales
- Job lists show when a job started and finished, including jobs that failed
- Newsletters record generation and delivery events, reviewable in the newsletter area

### Fixed

- The scheduler review table identifies torrents by name, and a removal no longer renders as a raw key labelled "would stop seeding"
- Seed conditions on size, uploaded, label and category are actually evaluated — the facts were declared and offered but never fed — and a rule reading something nothing measures now names that field instead of blaming seed duration
- The global bandwidth ceiling reaches engines added after it was saved
- The bandwidth ceiling is named and documented as per-engine, and the settings page multiplies it out — two engines at 25000 kbps is 50000 kbps, not 25000
- File manager: a second FILE_MANAGER_ROOTS entry is reachable again. Browse paths were rebased onto the first root, so a folder living only in another root 500'd with ENOENT and a name present in both silently served the first root's copy. With several roots paths are now absolute (single-root deployments are unchanged), and / lists the roots themselves. Trash and quarantine now store a path relative to the root they recorded rather than the client-facing one, so restores round-trip whatever the root count.
- Bandwidth precedence is decided from the plan, so a library-scoped policy is recognised — and the scheduler stops writing unlimited to engines no policy mentions
- Renamer: a video is no longer planned as a sidecar of itself. When the source parsed to no content type (a bare season folder rather than a release name), the sidecar pass classified against the batch kind and re-planned every video, producing a duplicate rename that failed ENOENT after the primary had already moved the file — reporting failures on a run that had actually succeeded.
- A newsletter send that reached nobody no longer records itself as successfully sent, and the newsletter activity feed is reachable instead of answering 404

Tagged [`v0.86.0`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.86.0).

## 0.85.10 — 2026-08-25

### Fixed

- Installer Phase 4: generate .env, an override only when needed, and installer state — preserving existing secrets on re-run
- Installer Phase 5: pre-seed the bundled qBittorrent's credentials so no temporary password is ever issued
- Installer Phase 6: prepare the host media directories before deploying, since a missing bind device fails the container at start with an unhelpful error
- Installer Phase 7: seed Prowlarr's API key, generate the bundled proxy's Caddyfile, and keep Prowlarr's unauthenticated Web UI off the host network by default
- Installer Phase 8 (partial): the Compose deployment executor, unit-tested and wired into nothing pending an integration test against a real daemon
- full UltraTorrent Console documentation, in en-US and es-PR, with captured screenshots
- console: realign the contract mirror, fix ANSI column maths, meter colour, and fit the screen
- console screenshots use invented names — no real title, site or path in published docs
- console: utconsole is translated — embedded en-US and es-PR catalogs, locale detection, and an L key that switches language live
- installer Phase 1: deployment audit and gap analysis
- installer Phase 2: typed InstallationPlan, validation and dry-run
- installer Phase 3: read-only host detection and the system check
- Windows installer Phase 1: audit the port before writing Windows code
- The failed-jobs alert reports today's failures instead of an all-time count that could never clear
- Windows installer Phase 2: shared installer core separated from the Linux executor, with a platform seam, a target-aware plan and Windows path rules
- utconsole is translated — embedded en-US and es-PR catalogs with locale detection, so the console speaks the same two languages as the documentation
- Installer Phase 8: install now deploys — a default command runner, a plan that records its repository, an always-explicit Compose project, and diagnosis with secrets redacted
- A failed deployment reports the reason rather than Compose's progress chatter, and shows the failing service's logs
- The installer's help documents --repo and no longer says deployment is unimplemented
- A container killed with SIGKILL is explained rather than reported as a bare exit code
- install --dry-run previews the storage layout instead of silently skipping it
- Re-running the installer over its own running stack is no longer refused as a port conflict
- Deploying seeds the first administrator and verifies that signing in actually works
- Turning on Prowlarr for an existing installation no longer fails on a missing config directory
- Deploying removes services the plan no longer includes, so a changed engine does not leave the old one running
- An external torrent engine can now be configured, and the installer says how to connect it
- The installer installs Docker when it says it will, instead of promising and failing later
- Publishing Prowlarr's Web UI now warns that it has no authentication
- Deploying skips the image build when the images already match the checkout
- The web UI keeps working after a redeployment, and the installer checks the door users actually use
- The installer connects Prowlarr and FlareSolverr automatically instead of leaving it to the operator
- The console's first-run message names the command that actually signs you in
- The installer ships the terminal console and installs it where a reboot cannot remove it
- Point the update channel, newsletter credit and HTTP user agents at the renamed repository (ultratorrentofficial/ultratorrent), and document the installer and where the software actually comes from
- On QNAP the console stays on PATH after a reboot, without disturbing an existing autorun.sh
- Scheduler activation counts the torrents it would REMOVE, not only the ones it would pause — a removal-based seed policy previously showed 0/0 on the consent screen and then deleted torrents on the first sweep

Tagged [`v0.85.10`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.85.10).

## 0.85.9 — 2026-08-22

### Fixed

- an operations snapshot reads the torrents the poller already fetched instead of asking the engines again
- UltraTorrent Console: a read-only terminal client, built and shipped as a static binary
- the console streams live events over the operations channel
- the console renders as a pane grid instead of a stacked column

Tagged [`v0.85.9`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.85.9).

## 0.85.8 — 2026-08-22

### Fixed

- Recent activity names the media it is reporting on
- A summarized activity entry expands to show the events behind it
- A superseded release loses its library copy, not just its torrent
- IMDb alternate-title import honours the preferred region and language settings, so title.akas no longer re-inflates to 42M rows on every scheduled import
- The UltraTorrent Console's operations endpoints and event bridge are wired and reachable
- The in-app documentation link points at docs.ultratorrent.co instead of the old GitHub Pages URL
- console.view is declared by a module manifest, so it exists on a deployed install

Tagged [`v0.85.8`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.85.8).

## 0.85.7 — 2026-08-22

### Fixed

- A purge that cannot verify seeding raises an alert instead of skipping silently

Tagged [`v0.85.7`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.85.7).

## 0.85.6 — 2026-08-21

### Fixed

- Degraded account revalidation is now reported and auditable, and can be made fail-closed
- A cleanup policy bounded by a library condition is no longer called unscoped, and the warning distinguishes examining from acting
- Cleanup plan approve, reject and execute use app modals instead of browser dialogs
- Every Media Purge confirmation is an app modal, and restore asks about overwriting with a checkbox instead of a second confirm
- Trash retention of zero days purges immediately instead of keeping files forever
- An expired quarantine item is purged after a grace window instead of sitting on disk forever
- The trash listing agrees with the sweep at zero retention
- Media Purge never removes media a live torrent is still seeding, and skips rather than guesses when the engine cannot be asked

Tagged [`v0.85.6`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.85.6).

## 0.85.5 — 2026-08-20

### Fixed

- Every controller is checked for parameterised routes that capture literal ones declared below them
- A file-manager write destination is checked against its real path, so a symlink inside a root cannot lead out of it
- fix(renamer): climb the whole container chain, not three levels of it

Tagged [`v0.85.5`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.85.5).

## Older releases

Releases before this point are in [CHANGELOG.md](https://github.com/ultratorrentofficial/ultratorrent/blob/main/CHANGELOG.md), which covers the full history back to the first tag.

## See also

- [Upgrading](/install/upgrading) — how to move between versions safely.
- [Modules](/modules/) — what each feature does, in depth.
- [Module reference](/reference/modules) — the generated manifest table.
- [REST API reference](/reference/api) — every endpoint that ships.
