# r/UltraTorrent — launch kit

Copy-paste content for the subreddit. Nothing here needs editing to be usable,
though the name and links assume `r/UltraTorrent`; swap them if that name is
taken.

**Why the rules are strict from day one.** A community adjacent to torrenting
gets actioned by Reddit when it drifts into facilitating piracy — not for being
about a torrent client (qBittorrent, Transmission and Deluge all have healthy
subs) but because members will post "where do I find X", tracker invite requests,
and links to copyrighted material. Reddit acts on the *subreddit*, not only the
post, and by then the community and the name are gone. Retrofitting these rules
onto an established culture is far harder than starting with them, so they go in
before the first member arrives.

This is also honest positioning: UltraTorrent is a media acquisition and
management platform. The community should read like self-hosting, because that
is what the project is.

---

## Community description (public, keep under 500 characters)

> Self-hosted Media Acquisition & Management Platform. UltraTorrent puts a fast
> multi-user web UI in front of your own qBittorrent or rTorrent, then adds RSS
> automation, media identification, metadata, artwork, subtitles, renaming, and
> Plex/Jellyfin/Emby/Kodi integration. AGPL-3.0, Docker-native.
>
> Software support and discussion only — no piracy, no content requests, no
> tracker invites.

---

## Sidebar / About

**UltraTorrent** is a self-hosted Media Acquisition & Management Platform.

It is not a desktop BitTorrent app. It controls one or more torrent engines you
already run, then identifies, enriches, renames, files, and publishes the result
to your media servers.

- **Docs:** https://damirabal.github.io/ultratorrent-core/
- **Source:** https://github.com/damirabal/ultratorrent-core
- **License:** AGPL-3.0
- **Install:** Docker Compose — see the Install section of the docs

### What it does

- Engine-agnostic core — qBittorrent and rTorrent today, normalized behind one
  provider interface
- Media Manager — scanning, identification, metadata, artwork, NFO, template
  renaming
- Media Intake — a resumable import pipeline with per-stage state
- Subtitle Intelligence — multi-provider search, scoring, validation, audio sync
- Smart Download — picks the best acceptable release, not the first match
- Duplicate Center — tells you what a cleanup frees *before* you approve it
- Torrent Activity Scheduler, Unified Jobs Center, RSS + rules automation
- RBAC, audit logging, OpenAPI, real-time WebSocket UI, en-US + es-PR

### This community is for

Configuration, self-hosting, media organization, bug reports, feature requests,
and showing off your setup.

### It is not for

Finding content. See the rules.

---

## Rules

**1. No piracy. No content requests.**
Do not ask where to find a film, show, album, book, or game. Do not link to
copyrighted material or to sites whose purpose is distributing it. This
community is about the software.

**2. No tracker invites, invite requests, or recruitment.**
No offering, requesting, or trading invites to any tracker. No "PM me for
access". No recruiting for a private tracker.

**3. No naming specific private trackers in a sourcing context.**
Discussing indexer *configuration* is fine — "how do I add a Torznab indexer",
"Prowlarr won't authenticate". Using the sub to point people at where to get
content is not.

**4. Support posts need details.**
Include your UltraTorrent version, torrent engine, how you deployed (Docker
Compose / manual), and the actual error or log line. "It doesn't work" cannot be
answered.

**5. No piracy-adjacent workarounds.**
No DRM circumvention, no bypassing paywalls, no account sharing or credential
trading.

**6. Be civil. No spam or self-promotion.**
Sharing your own related open-source project is fine if it is relevant and you
are present in the thread. Affiliate links, referral links, and drive-by
promotion are not.

**7. Security issues go to the maintainers first.**
Do not post an unpatched vulnerability publicly. See the Operate → Security
section of the docs, or `docs/SECURITY.md` in the repository.

---

## Post flairs

| Flair | For |
|---|---|
| `Support` | Something is broken or won't configure |
| `Bug` | A reproducible defect, ideally with a GitHub issue link |
| `Feature Request` | An idea for the platform |
| `Showcase` | Your setup, dashboards, library, automation |
| `Guide` | A how-to you wrote |
| `Announcement` | Releases and project news (mod-only) |
| `Solved` | Applied by OP once a support post is resolved |

---

## AutoModerator configuration

Paste into the subreddit's AutoModerator wiki page
(`https://www.reddit.com/r/UltraTorrent/wiki/config/automoderator`).

Tune before relying on it: the first rule is the load-bearing one, and it is
written to catch obvious sourcing posts, not to be clever. Read the modqueue for
the first few weeks and adjust — a filter that silently eats legitimate posts is
worse than one that misses a few.

```yaml
---
# Content requests and sourcing. FILTERED, not removed, so a false positive is
# recoverable from the modqueue rather than invisible.
type: submission
title+body (regex, includes): [
    "where (can|do) i (find|get|download)",
    "any(one|body) (have|got) (a )?(link|copy)",
    "looking for (the )?(movie|show|series|season|episode|album|book|game)",
    "(seeking|need) (a )?(copy|rip|release) of"
]
action: filter
action_reason: "Possible content request (rule 1)"
comment: |
    This looks like a request for content, which rule 1 does not allow — this
    community is about the UltraTorrent software.

    If your post is actually about configuring or troubleshooting UltraTorrent,
    reply here and a moderator will restore it.
---
# Tracker invites. REMOVED outright: there is no legitimate version of this post.
type: any
body+title (regex, includes): [
    "invite(s)? (for|to|available|needed|wanted)",
    "(pm|dm) me (for|if you want) (an? )?invite",
    "(trading|swapping) invites?",
    "invite (thread|trade|swap)"
]
action: remove
action_reason: "Tracker invites (rule 2)"
comment: |
    Invite offers, requests and trades are not allowed here (rule 2).
---
# Support posts missing the basics. Not removed — just asks for what is needed.
type: submission
flair_text: ["Support", "Bug"]
~body (regex, includes): ["0\\.\\d+\\.\\d+", "v\\d+\\.\\d+", "version"]
comment: |
    Thanks for posting. To help you we need a few specifics:

    - **UltraTorrent version** (Settings → System, or `GET /api/system/version`)
    - **Torrent engine** — qBittorrent or rTorrent
    - **How you deployed** — Docker Compose or manual
    - **The actual error**, including the relevant log lines

    Please edit your post to add these.
comment_stickied: true
---
# New accounts, lightly. Filtered rather than removed so real newcomers get in.
type: any
author:
    account_age: "< 3 days"
    comment_karma: "< 5"
action: filter
action_reason: "Very new account — check for spam"
---
```

---

## Pinned launch post

**Title:** UltraTorrent — a self-hosted media acquisition & management platform (AGPL-3.0)

**Body:**

Hi all — I'm the developer of UltraTorrent, and this is its community.

**What it is.** A self-hosted platform that puts a fast, multi-user web UI in
front of torrent engines you already run, then takes over everything after the
download: identification, metadata, artwork, subtitles, renaming, filing, and
publishing to Plex/Jellyfin/Emby/Kodi.

**What it is not.** A desktop BitTorrent client, and not a way to find content.
It manages media you already acquire.

**Currently shipping**

- qBittorrent and rTorrent, normalized behind one provider interface
- Media Manager — scanning, identification, metadata (local NFO, TMDB, and
  compliant IMDb via user-provided datasets or a licensed API — never scraping)
- Media Intake — a resumable import pipeline where each stage is recorded, so a
  failure names the stage and a retry resumes there
- Subtitle Intelligence — multi-provider search, scoring, validation, and audio
  sync, installing sidecars without overwriting an original
- Smart Download — picks the best acceptable release rather than the first match
- Duplicate Center — tells you what a cleanup will actually free before you
  approve it, which matters when a library file is a hardlink to a seeding
  torrent and deleting one name reclaims nothing
- Torrent Activity Scheduler, Unified Jobs Center, RSS + rules automation
- RBAC, audit logging, OpenAPI, real-time UI, en-US and es-PR

**Stack.** NestJS + PostgreSQL + Redis, React + Vite, Docker-native.

**Getting started.** Full documentation — Learn, Install, Modules, Reference,
Develop, Operate — is at https://damirabal.github.io/ultratorrent-core/ and the
source is at https://github.com/damirabal/ultratorrent-core

**A note on scope.** Rules 1 and 2 are strict and will stay strict: no content
requests, no tracker invites. That is what keeps a community like this alive, and
it is a fair description of the project anyway.

Bug reports and feature requests are welcome here or as GitHub issues. Happy to
answer anything about the architecture.

---

## First-week checklist

- [ ] Create the community, set it Public and not NSFW
- [ ] Paste the description and sidebar
- [ ] Add the seven rules
- [ ] Add post flairs; make `Announcement` mod-only
- [ ] Paste the AutoModerator config and **verify it saves without a syntax error**
- [ ] Post and pin the launch post
- [ ] Add the subreddit link to the repository README and the docs site
- [ ] Recruit one more moderator before you need one
