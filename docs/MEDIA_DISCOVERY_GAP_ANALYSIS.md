# Media Discovery Engine — gap analysis (Phase 1)

Audit only. No code changed. Read against `docs/ARCHITECTURE.md`, the
`media-acquisition`, `rss`, `media-intake`, `media`, `notifications`,
`domain-events` and `module-registry` modules, and `schema.prisma`.

The headline: **most of what the brief describes already exists.** The ranked
preference model, the decision engine, the watchlist, the path-space
translation and the provider-chain pattern are all in place and are reused
unchanged. What is genuinely missing is a *discovery* layer in front of them —
and one structural decision (§0) has to be settled before any of it is built.

---

## 0. The blocking question: an RSS rule cannot exist without a feed

`RssRule.feedId` is **`String`, not `String?`** — required, with a foreign key to
`RssFeed`. The brief assumes a generated title-specific RSS rule is the
monitoring mechanism for an upcoming title, but a rule cannot be created without
naming a feed that already carries that content.

This matters because the repository has **two acquisition paths**, not one:

| Path | Trigger | Source | Service |
| --- | --- | --- | --- |
| **Feed-reactive** | `media_acquisition_rss_sweep` (5 min) | an `RssFeed` | `rss.module.ts` |
| **Proactive search** | `media_acquisition_watchlist_sweep` (15 min) | Torznab / Prowlarr indexers | `missing-episode-search.service.ts` |

For **unreleased** media — which is all Discovery deals with — the proactive
search path is the correct engine. Nothing is in any feed yet.

`AcquisitionMatchPreferenceService.resolveCandidates()` resolves a monitored
show's preference list in this order:

```
rssRuleId link  →  rule whose NAME matches the title  →  auto-download profiles  →  global defaults
```

So the real job of a generated rule is **to carry the ranked preferences**, and
the watchlist item alone is sufficient to be acquired. Three options:

- **A — generated rules require a feed.** `DiscoveryTemplate` names an
  `rssFeedId`; refuse to enable a template without one. Smallest change, honest,
  but couples discovery to having a suitable feed.
- **B — preferences live on the watchlist item.** Skip rule generation; extend
  `resolveCandidates()` with a new top rung reading template candidates directly.
  No schema change to `RssRule`, no feed needed, but it is a fourth preference
  source to reason about.
- **C — make `feedId` nullable.** Widest blast radius; touches every existing
  rule query and the feed-sweep join. **Not recommended.**

### DECIDED (2026-09-05): **A** — the feed is selected on the template

`DiscoveryTemplate.rssFeedId` is part of the template, alongside
`acquisitionRuleTemplateId` and the target path template. The template reads:
*when this fires, generate a rule **on this feed**, using this acquisition
template, into this path.*

Consequences to hold to:

- **A template cannot be enabled without a feed.** Validated on enable, not on
  save — a half-built template must still be saveable.
- **A disabled or deleted feed disables generation.** `RssRule.feedId` is
  `onDelete: Cascade`, so a deleted feed would take every generated rule with
  it. The template must surface that before it happens rather than silently
  losing its rules.
- **B remains the fallback path, not a second mode.** A watchlist item whose
  generated rule is missing still resolves preferences through
  `resolveCandidates()` → profiles → defaults, so acquisition degrades rather
  than stopping.
- `RssRuleMatchCandidate.feedScope` (`{ feedIds: [] }`, empty = all feeds)
  already exists, so a template candidate can narrow *within* the chosen feed
  without any new mechanism.

---

## 1. Reusable unchanged

| Component | Why it already fits |
| --- | --- |
| `RssRuleMatchCandidate` | **Is** the ranked preference model: `priorityOrder`, `matchType`, `requiredTerms`, `excludedTerms`, `qualityRules`, `sizeRules`, `feedScope`. Template candidates map 1:1. |
| `rss/match-engine.ts` | `evaluatePreferenceList`, `showTitleMatch`, `normalize`. The one matcher. |
| `AcquisitionMatchPreferenceService` | Resolution order above; generated rules slot into rung 1 with **no change**. |
| `DecisionEngine`, `smart-download-executor`, `quality-compare`, `release-scoring` | Smart Download stays authoritative. Discovery never calls them. |
| `MediaAcquisitionWatchlistItem.rssRuleId` | The watchlist→rule link the brief asks for **already exists**. |
| `WatchlistService.create/update` | Service abstraction with audit context. Never write the table directly. |
| `StorageProfile` + `PathMappingRegistryService` | Canonical-space roots plus `toSpace()` translation. Path safety is solved; do not re-solve it. |
| `MetadataProviderRegistry` | The provider-chain + capability pattern to copy. |
| `@Interval('name', ms)` | The scheduler convention. No new daemon. |
| `PERMISSIONS`, `DOMAIN_EVENTS`, `notification-catalog.ts`, `AuditService` | Existing conventions. |
| **`TvShowStatus`** | Already stores `normalizedStatus` (continuing/returning/planned/ended), `nextEpisodeAirDate`, `firstAirDate`, `totalSeasons`, with TMDB + IMDb + local providers. **This is a partial discovery source that already exists** and should be read, not duplicated. |

## 2. Must extend

- **`RssRule`** — provenance columns: `generatedByDiscovery Boolean @default(false)`,
  `discoveryTemplateId`, `acquisitionTemplateId`, `discoveredMediaId`,
  `templateVersion`, `userModifiedAt`. Follow the **`importMode` precedent**: the
  default must make every existing row behave exactly as it does today.
- **`TmdbMetadataProvider`** — has only `search`/`details`. Discovery needs
  `/discover/*`, `/movie/upcoming`, `/tv/on_the_air`, `/tv/airing_today`. Add as
  a **separate discovery provider**; do not overload the metadata provider whose
  identity gate was just hardened.
- **`DOMAIN_EVENTS`** — see §16.
- **`PERMISSIONS`** + role grants; **`MODULE_IDS`** + a manifest (`required: false`).

## 3. Proposed new entities

`DiscoveredMedia` (identity, metadata, provenance, `discoveryStatus`) ·
`DiscoveredMediaReleaseDate` (type/date/region/source/confidence — **one row per
source**, so disagreement is preserved rather than flattened) ·
`DiscoveryTemplate` · `DiscoveryEvaluation` (the decision trace) ·
`AcquisitionRuleTemplate` + `AcquisitionRuleTemplateCandidate` ·
`DiscoveryProviderState` (health, cursors, ETags).

**Do not** add a `DiscoveredMediaExternalId` table — `MediaAcquisitionWatchlistItem`
already stores `externalIds Json?` and consistency beats normalisation here.

## 4. Provider interface

`ReleaseDiscoveryProvider` mirroring `MediaMetadataProvider`: `name`,
`capabilities(): DiscoveryCapability[]`, `healthCheck()`, and only the methods it
declares. A registry resolves providers per capability, exactly as
`MetadataProviderRegistry.chain()` does per `kind`.

### DECIDED (2026-09-05): **TMDB + TVmaze**

TMDB is already keyed and configured on both hosts; TVmaze needs no key and
carries the stronger TV schedule data. Trakt deferred — its OAuth device flow is
a separate piece of work from the discovery engine.

## 5–6. Template models

`DiscoveryTemplate` per the brief. **Category policy as three explicit arrays**
(`autoMonitor`, `notifyOnly`, `ignore`) plus `blockedFromAuto` and
`categoryMatchMode: ANY|ALL|PRIMARY`, with **exclusion precedence evaluated
first**.

`AcquisitionRuleTemplateCandidate` columns mirror `RssRuleMatchCandidate` 1:1 so
generation is a straight copy.

### DECIDED (2026-09-05): a **new candidate table**

`AcquisitionRuleTemplateCandidate` mirrors `RssRuleMatchCandidate` 1:1, so
generation is a straight column copy and template edits never mutate shared
profile state.

> **Note:** `MediaAcquisitionProfile` already carries `mediaType`,
> `preferredResolution/Source/Codec/Audio/Hdr`, `requiredTerms`, `excludedTerms`,
> `minSizeBytes`/`maxSizeBytes`, `qualityRules` — and `profileToInput()` already
> converts one into a ranked `MatchCandidateInput`. A template is essentially *an
> ordered list of profiles*. Worth deciding whether templates should **compose
> existing profiles** rather than introduce a parallel candidate table.

## 7. Ranked-preference reuse

Generation copies template candidates into `RssRuleMatchCandidate` rows
preserving `priorityOrder`. Nothing else changes.

**Trap:** `rssCandidates()` falls back to *a rule whose name equals the
normalized title*. A rule named `The Example Show (2026)` will **not** match a
watchlist title of `The Example Show`. Generation must therefore **always set
`rssRuleId` explicitly** and never rely on name matching.

## 8. Destination — a Storage Profile, not a path

### DECIDED (2026-09-05): the template carries a **Storage Profile**

Not a library path, and not a configured intake root. This is the correct model
and it is already the one the codebase uses.

`RssRule` **already has** `storageProfileId` + `importMode`, and `createRule()`
defaults a NEW rule to `managed_intake`. A generated rule therefore only needs:

```
importMode:       'managed_intake'
storageProfileId: <from the discovery template>
```

and the **existing intake pipeline resolves the destination**. `savePath` can
stay null — for a managed rule it is not the mechanism.

Consequences:

- **`{library_path}` is dropped.** The library is already implied: the profile
  carries `movieLibraryId` / `tvLibraryId` / `musicLibraryId`, and intake
  *organises into* it after staging. Pre-creating a library folder inverts the
  pipeline.
- **`{intake_path}` is derived, not configured** — it is the selected profile's
  `stagingRoot`, in **canonical space**. Translate with
  `PathMappingRegistryService.toSpace()` before any container or provider sees it.
- **Two existing guards must be satisfied, not reinvented:**
  - `assertManagedSavePathIsStaging()` already refuses a managed rule whose path
    points into a destination library (library-to-library placement duplicates
    everything it imports).
  - `IntakeMigrationService.stagingPathFor(stagingRoot, savePath, ruleName)` plus
    its `nests()` library-conflict check already build and validate exactly this
    path. **Extract and share these rather than writing a second copy** — a
    private helper in `intake-migration.service.ts` today.
- The optional pre-created directory derives from the same root, so it cannot
  disagree with where intake will actually stage.

Remaining template tokens are only the *leaf* shape below the staging root:
`{title}` / `{tvshow}` / `{movie}` / `{year}` / `{season_number}`. Token
allow-list, reject `..`, absolute tokens, control characters and NUL, sanitize
per component, assert inside the profile root, idempotent creation.

## 9. Watchlist dedup

Match on stable `externalIds` first, then `normalizedTitle` (+ `year`, +
`titleAliases`). On hit: update provenance, add missing ids, **never overwrite
user settings**, reuse the existing rule.

## 10. Protecting user edits

`userModifiedAt` set by the rule update path when a generated rule is edited.
Sync applies to `generated && !userModifiedAt` only; anything else needs an
explicit "reapply template".

## 11. Scheduler

Two named intervals — `media_discovery_provider_sync` (6 h) and
`media_discovery_evaluate` (hourly) — plus near-term refresh. Bounded
concurrency, ETag/Last-Modified, backoff. **No provider call in a request path.**

## 12–15. Migrations · API · Frontend · RBAC

Additive migrations only. Routes under `/api/media-discovery/*` following
existing controller conventions. Frontend as a **Discover** tab inside Media
Acquisition. Permissions: `media_discovery.view` / `.manage` /
`.templates.manage` / `.providers.manage`, granted per existing role sets.

## 16. Events — the brief over-specifies

`domain-events.ts` states: *"A key appears here only when something really
publishes it. An event that cannot fire is worse than an absent one."* The brief
lists ~14. Ship only those with a real producer and a reason to notify:

`media_discovery.auto_monitored` · `media_discovery.review_required` ·
`media_discovery.rule_failed` · `media_discovery.provider_sync_failed`

`created/updated/evaluated/ignored/notify/sync_started/sync_completed` are
per-item or per-tick and would be pure noise.

## 17. Security

Provider content is untrusted: cap field lengths, strip control characters,
sanitize before rendering paths, `assertSafeOutboundUrl` for artwork (SSRF guard
already exists), never interpolate provider strings into a shell, and never
auto-monitor an ambiguous identity — reuse the `verifiedMovieMatches` tie concept
so two same-title/same-year candidates are reported, not guessed.

## 18. Testing & docs

Unit: normalization, merge, identity conflict, category policy incl. precedence
and ANY/ALL/PRIMARY, thresholds, limits, trace, path expansion + traversal
rejection, template→candidate mapping, generated-vs-manual behaviour.
Integration: the three decision paths, watchlist reuse, rule linkage, folder
creation, user-edit protection, provider failure, **and an explicit test that
Discovery never triggers a download.**

Docs: `MEDIA_DISCOVERY.md`, `MEDIA_DISCOVERY_TEMPLATES.md`, plus
`ARCHITECTURE.md` (section + dated Change Log row), `CHANGELOG.md` via changeset.

---

## Decisions needed before Phase 2

1. ~~**§0 — feed selection**~~ — **DECIDED: A.** The feed is chosen on the discovery template.
2. ~~**Template candidate model**~~ — **DECIDED:** a new `AcquisitionRuleTemplateCandidate` table, 1:1 with `RssRuleMatchCandidate`.
3. ~~**`{library_path}`**~~ — **DECIDED:** dropped. The template carries a **Storage Profile**; the destination follows from `managed_intake`.
4. ~~**Providers**~~ — **DECIDED:** TMDB + TVmaze. Trakt deferred.

**All Phase 1 decisions are settled. Phase 2 (domain model + migrations) is unblocked.**
