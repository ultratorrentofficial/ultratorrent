# RSS Automation

A **core** module (id `rss`, RBAC `rss.*`) that watches feeds, ranks matching
releases, and turns them into downloads. It is the entry point for most
automated acquisition: feeds → rules → ranked match candidates → grabs.

- [Feeds, rules, and match candidates](#feeds-rules-and-match-candidates)
- [TV show airing-status awareness](#tv-show-airing-status-awareness)
  - [Provider abstraction](#provider-abstraction)
  - [Normalization and recommendation](#normalization-and-recommendation)
  - [Rule save validation](#rule-save-validation)
  - [Lookup API](#lookup-api)
  - [Background refresh](#background-refresh)
  - [Automation triggers and actions](#automation-triggers-and-actions)
  - [Frontend surfaces](#frontend-surfaces)
- [Permissions](#permissions)
- [Events](#events)

## Feeds, rules, and match candidates

A **feed** (`RssFeed`) is a polled URL. A **rule** (`RssRule`) lives under a
feed and describes what to grab: include/exclude regex, category, save path, and
an ordered list of ranked **match candidates** (`RssRuleMatchCandidate`) built in
the **Smart Match Builder** and prioritised in the **Match Preferences** list.
The scheduler job `rss_poll` (`RssService.pollDue`, 60 s) fetches feeds whose
refresh interval has elapsed and evaluates enabled rules against new items.

## TV show airing-status awareness

Users can create rules for shows that have already **ended or been canceled**,
which wastes polling on a series with no future episodes. The show-status layer
makes UltraTorrent aware of a show's airing status so the rule flow can recommend
against (and require confirmation for) monitoring an inactive show, and prefer
backfill/upgrade instead. It lives in `apps/backend/src/modules/rss/tv-show-status/`
and is kept out of `RssService` so **no provider-specific status rules leak into
the RSS services**.

### Provider abstraction

`TvShowStatusProvider` (`tv-show-status-provider.ts`) is the pluggable contract —
`searchShow`, `getShowStatus`, `getShowDetails`, `getNextEpisode`,
`getLastEpisode`, `getProviderCapabilities`. Implementations, tried in
confidence order by `TvShowStatusService`:

| Provider | Source | Confidence | Notes |
| --- | --- | --- | --- |
| `TmdbTvShowStatusProvider` | TMDB `/search/tv` + `/tv/{id}` | 0.95 | Status + next/last episode + poster. Used when a TMDB key is set (`media.tmdbApiKey` setting or `TMDB_API_KEY` env). |
| `ImdbTvShowStatusProvider` | Local IMDb dataset (`IMDbTitle`) | 0.6 | `endYear` + `titleType` ⇒ ended/continuing; no next-episode granularity. |
| `LocalNfoTvShowStatusProvider` | Local library (`MediaItem`) | 0.3 | Best-effort fallback only. |

New providers (TVDB/OMDb/AniList) drop in without touching the RSS services.

### Normalization and recommendation

Each provider's answer is mapped by **pure** functions to a provider-agnostic
status and a monitoring recommendation:

- `normalizeShowStatus()` → `continuing` · `returning` · `planned` · `on_hiatus`
  · `ended` · `canceled` · `unknown`. Textual TMDB status wins; a hiatus
  heuristic (returning + no future episode + last aired > ~6 months) yields
  `on_hiatus`; otherwise `endYear` ⇒ `ended`, `assumeContinuing` ⇒ `continuing`,
  else `unknown`.
- `recommendationFor()` → `recommended` (active) · `caution` (`on_hiatus`) ·
  `not_recommended` (`ended`/`canceled`) · `unknown`.

Resolved results are cached in `tv_show_status` (keyed by
`provider` + `providerShowId`, indexed by normalized title).

### Rule save validation

Creating/editing a rule whose `mediaType ∈ {tv, anime, episode, series}`
re-resolves the status **server-side** (never trusting a client-sent status) by
`showStatusProviderId` and snapshots it onto the `RssRule`
(`showStatus`, `showStatusRecommendation`, air dates, warnings, …):

- `ended`/`canceled` **and not** `allowInactiveShowMonitoring` → `400` (confirm
  required). The override is audited (`rss.rule.created_for_inactive_show`) and
  emits a WS event + fires an automation trigger.
- `unknown` → saved with a `status_unconfirmed` warning.
- active → saved normally.

### Lookup API

- `GET /api/rss/show-status/lookup?title=&year=&provider=` — resolve one show.
- `POST /api/rss/show-status/lookup-batch` — `{ queries: [{title, year?}] }`.

Both require `rss.show_status.lookup`, are audited, and broadcast
`rss.show_status.lookup.completed` / `.failed`. The response carries the full
`ShowStatusResult` (status, recommendation, confidence, first/last/next-episode
dates, season/episode counts, overview, poster, warnings).

### Background refresh

`RssShowStatusRefreshService` (scheduler job `rss_show_status_refresh`, hourly
`@Interval`, gated on the module being enabled) re-resolves cached statuses on a
**per-status cadence** — active 24 h · `on_hiatus` 7 d · `ended`/`canceled` 30 d
· `unknown` 3 d — oldest-first and bounded per run. On a status **change** it
updates every rule snapshotting that show, broadcasts `rss.show_status.changed`
plus the specific transition, audits it, and fires the matching automation
trigger. It **never disables a rule** — surfacing the change is the user's call.

### Automation triggers and actions

The automation engine has a non-torrent **event-context** path
(`AutomationEngine.evaluateEvent`) that matches rule conditions against a plain
event object and runs only event-safe actions.

**Triggers:** `rss.rule.created_for_inactive_show`, `rss.show_status.changed`,
`rss.show.became_active`, `rss.show.ended`, `rss.show.canceled`.

**Actions:** `refresh_rss_show_status`, `disable_rss_rule`,
`convert_rule_to_backfill` (turns off `autoDownload` — keep the rule, stop
forward auto-grabbing), `notify_admin`. The RSS actions are delegated to
`RssAutomationActions` and target a rule by explicit `ruleId` or by the show
identity (`provider` + `providerShowId`) carried on the trigger context.

Wiring: RSS fires triggers via `ModuleRef` (lazy) so the DI graph stays acyclic
while `AutomationModule` imports `RssModule` behind a `forwardRef` (an ES-module
load-order cycle only).

### Frontend surfaces

- **Rule create/edit dialog** (`RssPage.tsx`): a **Media type** selector; for
  TV/anime a live `ShowStatusPanel` (badge, recommendation banner, provider +
  confidence, next/last-episode dates, poster, refresh). Saving a rule for an
  ended/canceled show opens a **confirmation modal** that sets
  `allowInactiveShowMonitoring`.
- **Rule list** (`RssPage.tsx`) and **rule detail** (`RssRulePage.tsx`, above the
  Smart Match Builder / Match Preferences tabs): a `ShowStatusBadge` from the
  rule's stored snapshot, plus a recommendation caption on the detail header.

## Permissions

| Permission | Grants |
| --- | --- |
| `rss.view` | See feeds/rules; receive `rss.*` WS events. |
| `rss.manage` | Create/edit/delete feeds and rules. |
| `rss.show_status.lookup` | Call the lookup endpoints (granted to view-capable roles). |
| `rss.show_status.refresh` | Trigger a manual status refresh. |
| `rss.show_status.override` | Save a rule for an inactive show. |

## Events

`rss.show_status.lookup.completed` · `rss.show_status.lookup.failed` ·
`rss.rule.created_for_inactive_show` · `rss.show_status.changed` ·
`rss.show.became_active` · `rss.show.ended` · `rss.show.canceled`. All are scoped
to `rss.view` by the realtime gateway.
