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

Every released version, newest first. This page shows the **25 most recent** of **223** releases; the complete history lives in [CHANGELOG.md](https://github.com/ultratorrentofficial/ultratorrent/blob/main/CHANGELOG.md).

Versions are [semantic](https://semver.org/): a **minor** bump means new capability, a **patch** means fixes only. Upgrading is covered in [Upgrading](/install/upgrading).

## 0.92.4 — 2026-09-12

_Latest release._

### Fixed

- Stream Limits: the list now holds only viewers an admin has deliberately configured (override, exemption, or link), with an Add user picker to grant one — not every viewer at the global default. Also show the ISP/organisation next to a viewer's IP address (it was resolved but never displayed)

Tagged [`v0.92.4`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.92.4).

## 0.92.3 — 2026-09-12

### Fixed

- Stream Limits: seed the per-user roster from viewers analytics already knows, so it is populated (and editable) even before anyone streams under enforcement — the page was empty on a fresh setup

Tagged [`v0.92.3`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.92.3).

## 0.92.2 — 2026-09-12

### Fixed

- Concurrent Stream Control (Phase 1): providers can now stop a playing session (Plex/Jellyfin/Emby; Kodi is monitor-only), and admins with the new sessions.terminate permission get a Terminate stream action in Live Activity
- Concurrent Stream Control (Phase 2): per-user and global concurrent-stream limits with an enforcement engine that terminates the excess (newest/oldest) after a grace period, cross-server counting within a product, a Redis-backed single-flight lock (in-process fallback), plus Stream Limits, Stream Control settings, and Enforcement History admin pages
- Concurrent Stream Control (Phase 3): admins can link a person's separate media-server accounts (e.g. Plex + Jellyfin) so their streams count together against one limit — an explicit action only, never inferred; the group's policy is the most restrictive of its members

Tagged [`v0.92.2`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.92.2).

## 0.92.1 — 2026-09-11

### Fixed

- Media Server Analytics: render country flags as bundled SVGs (they now show on Windows too) and add them to the Reports top-countries/cities charts
- Media Discovery cards now link out to IMDb, TMDB and TVmaze (whichever ids the item carries) so a reviewer can open the full record before deciding

Tagged [`v0.92.1`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.92.1).

## 0.92.0 — 2026-09-11

### New

- Media Server Analytics: add an in-app IP Geolocation admin (like the local IMDb dataset manager) — a config area for MaxMind account id and license key (encrypted), a built-in database downloader/updater with status, and scheduled auto-refresh. Replaces the compose geoipupdate sidecar; the backend downloads the GeoLite2 databases itself, verifies them, and reloads with no restart, while IP lookups stay fully offline.

Tagged [`v0.92.0`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.92.0).

## 0.91.0 — 2026-09-11

### New

- Media Server Analytics: show each play's IP address in Watch History and Live Activity, and add offline IP geolocation (MaxMind GeoLite2) with a Reports > Locations tab charting top viewing countries, cities and ISPs. Lookups run against local .mmdb files so no viewer IP leaves the host; private/LAN addresses show as Local and everything degrades gracefully when no database is present.

### Fixed

- Media Server Analytics: add an optional geoipupdate sidecar (profile 'geoip') that keeps the MaxMind GeoLite2 City/ASN databases current automatically, downloading only changed editions into the shared volume on a schedule. The backend reloads a refreshed database with no restart and still makes no outbound call itself; enable it with a MaxMind account id and license key.

Tagged [`v0.91.0`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.91.0).

## 0.90.15 — 2026-09-11

### Fixed

- Media Server Analytics: Watch History now shows the friendly name for live-monitored viewers too. Live Plex monitoring stores a login handle while the same account's Tautulli-imported record holds the real name, linked only by provider user id; the resolver now bridges a live row to that imported record by id and shows its displayName or userName.

Tagged [`v0.90.15`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.15).

## 0.90.14 — 2026-09-11

### Fixed

- Media Server Analytics: resolve friendly names for Watch History rows imported before connection tracking (no connectionId) too — the majority of a live server's history. The first pass keyed strictly on a non-null connection, leaving that bulk showing raw handles; null-connection rows now share one legacy bucket matched among themselves and never conflated with a real connection.

Tagged [`v0.90.14`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.14).

## 0.90.13 — 2026-09-11

### Fixed

- Library browser: a bulk 'delete files' now clears the selection the moment it is dispatched, not when the background job settles. When that settle callback did not run, the next delete dialog inherited the previous selection's count, so a fresh smaller selection still prompted for the earlier larger number and the type-the-count safeguard stopped describing what would be deleted.
- Media Server Analytics: the Watch History table now shows each viewer's operator-set friendly name instead of the raw login handle the media server reported. The friendly name (MediaServerUser.displayName) is resolved per page and matched within a connection by provider user id, falling back to the stored handle.

Tagged [`v0.90.13`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.13).

## 0.90.12 — 2026-09-11

### Fixed

- Security: update socket.io-parser (4.2.7), multer (2.3.0), nodemailer (9.1.1), sharp (0.35.4) and react-router-dom (6.30.6) to close Dependabot advisories, including a pre-authentication memory exhaustion in the realtime socket parser and a single-request crash in multipart upload parsing

Tagged [`v0.90.12`](https://github.com/ultratorrentofficial/ultratorrent/releases/tag/v0.90.12).

## 0.90.11 — 2026-09-11

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

## Older releases

Releases before this point are in [CHANGELOG.md](https://github.com/ultratorrentofficial/ultratorrent/blob/main/CHANGELOG.md), which covers the full history back to the first tag.

## See also

- [Upgrading](/install/upgrading) — how to move between versions safely.
- [Modules](/modules/) — what each feature does, in depth.
- [Module reference](/reference/modules) — the generated manifest table.
- [REST API reference](/reference/api) — every endpoint that ships.
