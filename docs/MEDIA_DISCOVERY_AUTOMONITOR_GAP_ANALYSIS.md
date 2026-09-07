# Media Discovery auto-monitor — root cause and gap analysis

Phase 1 output. **No code has been changed.** Every claim below is cited to the
file and line it was read from.

---

## 1. Why "The Terminal List" and "The Terminal List (2022)" both exist

Four independent defects. **Any one of them alone is sufficient** to produce the
duplicate, which is why it happens reliably.

### 1a. Three different title normalizers, none of which strips a year suffix

| Used by | Implementation | `The Terminal List (2022)` becomes |
|---|---|---|
| Discovery merge + `DiscoveredMedia.normalizedTitle` | `media/imdb/imdb-match.ts:11` | `the terminal list 2022` |
| TV show status / missing episodes | `rss/tv-show-status/tv-show-status-provider.ts:98` | `the terminal list 2022` |
| Watchlist `normalizedTitle` column | inline `title.toLowerCase().trim()` — `media-acquisition/watchlist.service.ts:178` | `the terminal list (2022)` |

None of the three treats a trailing `(YYYY)` as presentation metadata. So the
same work, formatted two ways by two providers, produces two different
normalized identities in every table.

### 1b. The discovery merge itself will not join them

`discovery-identity.ts:212` builds the title+year join key as:

```
`${mediaType}|${normalizeTitle(raw.title)}|${raw.year ?? ''}`
```

`tv|the terminal list|2022` and `tv|the terminal list 2022|2022` are different
keys, so the merge never considers them the same work — two `DiscoveredMedia`
rows survive, and each independently proceeds to create monitoring.

This is only reached when no external id joins them first, which is the normal
case for TVmaze-only shows (`externals` is frequently all-null).

### 1c. The watchlist lookup compares a raw title to a normalized column

`discovery-watchlist.service.ts` `findExisting()`:

- External ids are tried first — correct, and it is the documented intent.
- The fallback compares `media.title.toLowerCase().trim()` against the stored
  `normalizedTitle`.

A **hand-added** watchlist entry usually carries **no external ids at all**, so
the id lookup returns nothing and the fallback decides. `the terminal list
(2022)` ≠ `the terminal list`, so no match, so a second entry is created.

The existing comment there anticipates a normalization mismatch and fixes only
the punctuation half of it. The year half is untreated.

### 1d. Rule generation keys on the row id and collides on display name

`discovery-rule.service.ts`:

- Idempotency check is `where: { generatedByDiscovery: true, discoveredMediaId: media.id }`
  — keyed on the **`DiscoveredMedia` row id**, not on canonical identity. Two
  rows for one show (1b) means two rules, and neither sees the other.
- Collision check is on the **exact rule name**, `ruleName()` = `Title (Year)`.
  An existing manual rule named `Tulsa King` does not collide with a generated
  `Tulsa King (2022)`, so the "never adopt a person's rule" protection never
  fires and a second rule is created instead.

### 1e. No database-level protection anywhere

`RssRule` has no unique on `name` or `discoveredMediaId`;
`MediaAcquisitionWatchlistItem` has only non-unique indexes on `status`,
`normalizedTitle`, `libraryShowId`. Every duplicate check in this feature is
check-then-insert with nothing behind it.

---

## 2. Identity helpers that can be reused

| Helper | Location | Verdict |
|---|---|---|
| `normalizeTitle()` | `media/imdb/imdb-match.ts:11` | Reuse as the base; needs a year-suffix rule added |
| `titleSimilarity`, `scoreTitleMatch`, `titlesAreSequelVariants` | same file | Reuse for alias/fuzzy matching |
| `mergeDiscoveries()` union-find, `ID_PRIORITY` | `discovery-identity.ts` | Reuse — the id-is-proof / title-is-a-hint rules are already correct |
| `MediaExternalId (provider, externalId)` | schema, indexed | Reuse — the only proof-grade library link, already used by `DiscoveryRemovalService` |
| `DiscoveryRemovalService.libraryItems()` | `discovery-removal.service.ts` | Reuse the external-id-only matching pattern |
| `AcquisitionWatchlistService` | `media-acquisition/watchlist.service.ts` | Reuse; do not fork |

**No new identity engine is required.** What is missing is one canonical
resolver that consults all of them in priority order.

---

## 3. Where canonical identity resolution must be inserted

Today the only gate is inside each writer, separately. It must move **in front
of the writers**, in `DiscoveryEvaluationService.act()` — before
`watchlist.linkOrCreate()`, `rules.generate()` and `intake.provision()`, all
three of which are called from there.

The resolver returns the existing identity (watchlist item, rule, library show)
or nothing; only "nothing" may create a new monitored show.

---

## 4. How existing watchlist and RSS rules will be detected and reused

Lookup order, external ids always first:

1. `MediaExternalId` → `MediaItem` → library show identity
2. `MediaAcquisitionWatchlistItem.externalIds` (`ID_PRIORITY`)
3. `RssRule.discoveredMediaId` / `acquisitionTemplateId` provenance
4. Canonical `normalizedTitle` + `year` — **after** the year suffix is lifted out
   of the title on both sides
5. Alias/alternate titles

Reuse means: link the watchlist entry to the existing rule, contribute missing
external ids, and stop. It never means adopting or rewriting a rule a person
made — that protection already exists and works, it is simply not reached today
because the name comparison misses.

---

## 5. Why past-premiere shows currently pass auto-monitor

**The evaluator cannot see a premiere date.** `PolicyMedia`
(`discovery-policy.ts:44-59`) carries `releaseDates[]` and nothing else about
time. `DiscoveredMedia.premiereDate` and `seriesStatus` **are** populated —
`tvmaze-discovery.provider.ts:185`, `tmdb-discovery.provider.ts:269`, stored at
`discovery-store.service.ts:187-188` — and are simply never passed to the policy.

The only date test is `qualifyingRelease()` (`discovery-policy.ts:286`), which
asks: *is there any release date of a wanted type between today and
today+windowDays?*

TVmaze emits `series_premiere`, `season_premiere` **and** `episode_air`
(`tvmaze-discovery.provider.ts:81-90`). A series that premiered in 2022 and is
airing episodes this week therefore has qualifying dates inside the window. With
the default `releaseTypes: []` meaning "all types" (`discovery-policy.ts:296`),
it passes the window gate, and the category policy then auto-monitors it.

**"New" is never tested anywhere in the current implementation.**

---

## 6. Where the NEW/UPCOMING gate belongs

In `evaluateDiscovery()`, as a hard eligibility test, in this order:

```
normalize → canonical identity → existing state → PREMIERE ELIGIBILITY
  → category policy → language/region/type → thresholds → limits → decision
```

Today categories are evaluated before anything date-related can demote the
result (`discovery-policy.ts:233` — "everything below can only DEMOTE"), which
is exactly the inversion the brief calls out. The gate must produce
`REVIEW_PAST_RELEASE` / `NEEDS_REVIEW` and be unreachable-past, not a score.

Requires adding `premiereDate`, `seriesStatus` and a per-provider date evidence
set to `PolicyMedia`, plus `gracePeriodDays`, `pastReleaseBehavior` and
`returningSeriesBehavior` to `PolicyTemplate`.

---

## 7. Returning series vs new series

They are different questions and the current code asks neither.

| Case | Premiere | In UltraTorrent | Default |
|---|---|---|---|
| New series | future | — | `AUTO_MONITOR` (subject to the rest) |
| Returning, owned | past | yes | Reuse the existing identity; the upcoming season continues under it. **Never create a second show.** |
| Returning, not owned | past | no | `REVIEW_PAST_RELEASE` — do not import an older series wholesale |

`DiscoveredMedia.seriesStatus` already carries `continuing | returning | planned
| …` in the *same vocabulary* as `TvShowStatus.normalizedStatus`, deliberately —
so the returning-series test can read it directly without translation.

---

## 8. How templates store acquisition settings today

`DiscoveryTemplate.acquisitionTemplateId` → `AcquisitionRuleTemplate` +
`AcquisitionRuleTemplateCandidate`, which already mirror `RssRuleMatchCandidate`
field for field. **This is the reusable Match Preference Profile the brief asks
for; it exists and needs no replacement.**

The defect is that it is **optional**: `assertEnableable()`
(`discovery-template.service.ts:270-305`) requires an RSS feed and a storage
profile, and validates the acquisition template *only if one is set*.

---

## 9. How existing match preferences are reused

`AcquisitionTemplateService.toRuleCandidates()` already clones a ladder into
`RssRuleMatchCandidate` rows, and `discovery-rule.service.ts:99` already calls
it. The mapping is correct and complete. Nothing new is needed here — only that
it always has something to map.

---

## 10. What must change so a generated rule is operational — the worst finding

**A generated rule created without an acquisition template matches nothing, for
ever.**

- `discovery-rule.service.ts:99` creates `matchCandidates` only when
  `input.acquisition` is set.
- The generator never sets `includeRegex` or `excludeRegex`.
- `rss.module.ts:1371` picks candidates *or* `legacyEvaluation()`.
- `legacyEvaluation()` (`rss.module.ts:2211-2228`) returns **`matched: false`**
  when a rule has neither candidates nor regex — deliberately, so a filterless
  rule cannot grab an entire feed.

So the rule is `isEnabled: true`, `autoDownload: true`, and permanently inert.
This is worse than "needs a second configuration step": there is no indication
anything is wrong.

> **Correction to existing documentation.** `docs/MEDIA_DISCOVERY.md` and the
> published site say a generated rule without an acquisition template "falls back
> to your auto-download profiles and then the global defaults". That is true only
> of `AcquisitionMatchPreferenceService.resolveCandidates()`
> (`acquisition-match-preference.service.ts:202`), which serves the
> watchlist/missing-episode search path. **RSS feed matching has no such
> fallback.** Both documents must be corrected.

The fix: require an acquisition template for any auto-monitoring template, and
refuse to auto-monitor into a rule that would carry no candidates.

---

## 11. Schema changes required

| Change | Why |
|---|---|
| Canonical identity columns on `DiscoveredMedia` (`canonicalTitle`, year-free `normalizedTitle`) | 1a/1b — the join key must stop varying with presentation |
| `DiscoveryTemplate`: `gracePeriodDays` (default 0), `pastReleaseBehavior` (default `review`), `returningSeriesBehavior` (default `existing_only`), `requireUpcoming` | Fix 2, all defaulting to the safe behaviour |
| `DiscoveryTemplate.acquisitionTemplateId` becomes **required for auto-monitor** (validation, not necessarily NOT NULL) | Fix 3 |
| **Partial** unique indexes for concurrency | See 12 |

PostgreSQL treats NULLs as distinct in unique constraints, so a plain composite
unique over nullable external ids will not prevent anything. These must be
partial: `CREATE UNIQUE INDEX … ON t (mediaType, tmdbId) WHERE "tmdbId" IS NOT NULL`,
one per id namespace. Title+year uniqueness must **not** be added — legitimate
collisions exist and are exactly what the ambiguity state is for.

---

## 12. Concurrency and idempotency

Currently: `DiscoveryEvaluationService` has an in-process `running` flag, and
nothing else. Every duplicate check is check-then-insert. Two providers
discovering the same title in one pass, or a manual `POST /evaluate` racing the
hourly tick, can both create.

Plan: partial unique indexes as above, `upsert` on the canonical key rather than
find-then-create, and the write wrapped so a unique violation is *caught and
resolved to the existing row* rather than surfaced as an error. The DB constraint
is the guarantee; the resolver is the fast path.

---

## 13. Reconciling existing duplicates

A read-only reconciliation report, grouping existing watchlist entries and rules
by canonical identity, with strongest-external-id evidence, and a recommended
merge that a person approves. Reusing the plan-then-confirm shape of
`DiscoveryRemovalService`.

It must never automatically delete media, torrents, or anything manually
authored — merge means retaining one canonical identity, preserving the
strongest ids, preferring manual match preferences over generated ones, and
keeping acquisition history.

---

## 14. Regression tests that will prove the fix

- `The Terminal List` + `The Terminal List (2022)` → one identity, no second
  watchlist entry, no second rule
- `Tulsa King (2022)` existing + `Tulsa King` discovered → same identity
- Same external id, two provider title formats → one identity
- Two providers, one pass → one watchlist item, one rule
- Same sync run 1×/10×/100× → identical row counts
- Premiere tomorrow → eligible; today → eligible; yesterday, grace 0 →
  `REVIEW_PAST_RELEASE`; yesterday, grace 3 → eligible; a year ago →
  `REVIEW_PAST_RELEASE`; unknown → `NEEDS_REVIEW`; providers disagreeing →
  `NEEDS_REVIEW`
- Owned series + future season → reuse identity, no new show
- Unowned old series + future season → review only
- Auto-monitored title → rule enabled **and carrying candidates**, ladder order
  preserved, terms and size limits propagated
- Template with no acquisition profile → not ready; candidate → `NEEDS_REVIEW`
- Titles with `../`, quotes, unicode, four-digit numbers, shell metacharacters →
  contained path, no incorrect year stripping (`Blade Runner 2049`, `2012`,
  `Fahrenheit 451` must keep their numbers)

`Date` must be injected in all date tests — a fixture pinned to an absolute date
already rotted once in this repository.
