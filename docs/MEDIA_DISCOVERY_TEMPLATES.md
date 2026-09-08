# Discovery templates

A template is a **standing instruction**. While one is enabled, titles matching
it get a watchlist entry and an acquisition rule without being asked. That is the
whole point, and it is also why the safety rails below exist.

Two kinds:

- A **discovery template** decides *what* to monitor.
- An **acquisition rule template** decides *what release characteristics* are
  preferred once something is monitored.

They are separate because the questions are separate — "is this show worth
following" and "which of these six releases do I want" have different answers and
different audiences.

- [The category policy](#the-category-policy)
- [Match modes](#match-modes)
- [Scope](#scope)
- [Thresholds and identity](#thresholds-and-identity)
- [Destination](#destination)
- [Limits](#limits)
- [Preview](#preview)
- [Acquisition rule templates](#acquisition-rule-templates)
- [What protects your edits](#what-protects-your-edits)

---

## The category policy

Four lists, not one allow-list. A single list can only say what qualifies; it
cannot express *"tell me about Drama but never add it on its own"*, which is what
most people actually want.

| List | Verb | Effect |
| --- | --- | --- |
| **Monitor automatically** | monitor | Watchlist entry + acquisition rule, unasked |
| **Tell me only** | tell me | Appears in the inbox. Nothing is created. |
| **Hide** | hide | Filed away so the same unwanted title stops reappearing |
| **Never automatically** | never | **Beats every list above** |

The fourth is the one worth understanding. It is evaluated **first** and
overrides everything, so:

```
Monitor automatically:  Sci-Fi, Action, Crime
Never automatically:    Documentary
```

A title tagged *Sci-Fi + Documentary* is **not** auto-monitored, however well
Sci-Fi qualifies — but it is still shown to you, so you can add it by hand. A
category may legitimately appear in **both** lists; that is exactly how "Sci-Fi
qualifies, but never when it is also a Documentary" is written down.

**Monitor and Hide may not overlap.** Those are opposite verdicts and there is no
defensible reading — the form flags it while you type, and the server refuses the
save.

**A category in none of the lists is neutral**, and a title matching nothing is
ignored. A template says what it is looking for; surfacing everything it did not
ask about would bury the titles it did.

**A title with no categories at all never matches, under any mode.** Much of the
TVmaze schedule is untagged daily news and talk, and "every category qualifies"
is vacuously true of an empty list — a vacuous truth there would auto-monitor all
of it.

## Match modes

| Mode | A title qualifies when |
| --- | --- |
| `ANY` | at least one of its categories is in the list |
| `ALL` | every category it carries is in the list |
| `PRIMARY` | only its first category is considered |

`ANY` is the sensible default. `ALL` is strict enough to be surprising — a
Sci-Fi/Drama/Thriller show fails an `ALL` list that names only Sci-Fi.

**The "never automatically" list always uses ANY semantics**, whatever the mode.
A blocking list means "if this appears at all", and reading it under `ALL` would
make a block that almost never fires.

## Scope

| Field | Notes |
| --- | --- |
| **Media type** | `any`, `tv` or `movie`. A TV template simply has no opinion about films — they are not "ignored", they are out of scope. |
| **Look ahead** | 1–365 days. Beyond a year a provider's dates are announcements, not schedule. |
| **Languages** | Matched against the provider's original language. |
| **Regions** | ISO-3166 codes. Also scopes *which* release dates count — see below. |
| **Release types** | Which dates qualify. Empty means all of them. |

Release types matter more than they look. "Films once they reach streaming" is a
different query from "films in cinemas", and the digital date is often a year
after the theatrical one. Scoping by region matters for the same reason: release
dates are per-country, and without a region a single foreign TV airing can
qualify a five-year-old film.

## Thresholds and identity

**Minimum popularity / rating / vote count** hold back titles that qualify on
category but are below the bar you set for acting without being asked. A title
below a threshold is **demoted to notify**, not ignored — it is the right kind of
title, just not one to add automatically.

**An unknown value fails a threshold.** If a provider gives no popularity and you
require 50, the title does not pass. Treating unknown as satisfied would let
every title with thin metadata through the one gate set to hold things back.

**Minimum identity confidence** (default `0.8`) is how sure the engine must be
about *what a title is*. Confidence measures identity, not metadata richness: a
record with a full synopsis, a poster and 5,000 votes but no external id scores
0.1, because it is still unidentified.

You can lower the floor. You **cannot** configure past an *ambiguous* identity —
two works genuinely sharing a title and year are held for review no matter what,
because a wrong external id propagates into duplicate detection and every
downstream lookup.

## Destination

These fields appear **only when the template auto-monitors something**. For a
notify-only template they are not optional but irrelevant.

| Field | Why |
| --- | --- |
| **RSS feed** | A generated rule must belong to a feed — `RssRule.feedId` is required. A template cannot be *enabled* without one. |
| **Storage profile** | Decides where media is staged and filed. Generated rules are `managed_intake`, so the intake pipeline resolves the destination from this. |
| **Match preferences** | **Required.** A template cannot be enabled for auto-monitoring without one, and it must have at least one enabled rung. |
| **Folder below the staging root** | The *leaf* only. Tokens: `{tvshow}` `{movie}` `{year}` `{season_number}` `{title}` `{season}`. Rendered onto the storage profile's staging root and recorded as the generated rule's save path. |

There is deliberately **no `{library_path}` or `{intake_path}` token.** The root
is the storage profile's to choose, not the template's — intake stages first and
organises into the library afterwards, so a template that spelled either root
would be inverting the pipeline it feeds.

**Creating the folder and recording the path are separate.** *Create intake
directory* decides whether the folder is made up front; the rule records its
target path either way. (These were once conflated, which made the path template
do nothing at all unless directory creation happened to be on.)

Path rendering sanitises every value: a `/` inside a title becomes a space rather
than a directory level, traversal and control characters are stripped, and the
result is asserted to sit inside the profile's staging root and outside every
destination library.

## Limits

| Field | Default |
| --- | --- |
| Max automatic adds per day | 10 |
| Max automatic adds per week | 30 |

Rolling windows, not calendar days. Excess titles go to **Needs review** and stay
in the inbox — the limit paces acquisition, it does not filter it.

A weekly cap below the daily cap is refused: the daily allowance would be
exhausted first every time, making the weekly figure a number that never does
anything.

## Preview

Preview runs the **real evaluator** — not a copy of the rules, which would drift
from them invisibly — over the catalogue you already have, and writes nothing.
It takes the form as it stands, unsaved, so adjust-and-look-again costs nothing.

```
If this template ran now, over 870 discovered titles:
   50 would be automatically monitored
   24 would generate notifications
  233 would be ignored
   13 would need review
  550 are outside this template

20 of these would be held for review — your weekly limit is 30.
```

That last line is the reason to preview before enabling rather than after.

Limits are **projected, not applied**, in a preview: folding the budget into the
evaluation would make every title past the tenth read as "needs review" and hide
the shape of the policy you are actually tuning.

## Acquisition rule templates

An ordered ladder of release preferences, best first:

```
1.  2160p · WEB-DL · x265 · requires "DV"
2.  2160p · WEB-DL · x265
3.  1080p · WEB-DL · x265
4.  1080p · WEB-DL · x264
excluded everywhere: CAM, TS, TC, SCR
```

The ladder is copied verbatim onto each generated rule as
`RssRuleMatchCandidate` rows — the same model a hand-made RSS rule uses. There is
**one** match engine and this is not a second one.

**Template-wide terms apply to every rung.** `excludedTerms: ['CAM']` is a
constraint, not a preference of the top rung — a fallback rung that dropped it
would accept exactly what the template forbids.

**HDR and audio are expressed as required terms, not quality rules.** The match
engine reads exactly `quality`, `source`, `codec` and `resolution`; it has no
`hdr` or `audio` field. Offering them as quality rules would be a setting that
looks configured and silently does nothing, so they are refused with a message
pointing at `requiredTerms: ["DV"]` / `["Atmos"]`.

Ladders are authored at **Discover → Match preferences**. A discovery template
then selects one; it can no longer be left unset for an auto-monitoring template.

Two things the editor deliberately does not offer:

- **A priority number.** Position is priority — the ladder reads top to bottom,
  and a number field beside an ordered list is two sources of truth that can
  disagree. Rungs are renumbered from zero on save, which also closes gaps an
  older template left behind.
- **HDR and audio fields.** The match engine reads `quality`, `source`, `codec`
  and `resolution` and nothing else, so an HDR select would look configured and
  silently do nothing. Dolby Vision and Atmos go in **required terms**, and the
  editor says so rather than leaving you to discover it from a server error.

Sizes are entered in **GB** and stored as bytes. An empty box means *no limit* —
not zero, which as a maximum would reject everything.

Editing the ladder bumps the profile's `version`; reordering counts, renaming the
profile does not.

:::danger A rule with no match preferences matches nothing
This used to be optional, on the belief that a generated rule without a ladder
would fall back to your auto-download profiles and then the global defaults.

That is true of the **watchlist and missing-episode search** path. It is **not**
true of RSS feed matching, which is what a generated rule is for: a rule is
filtered by its match candidates if it has any and by its include/exclude regex
otherwise, and a rule with **neither** is treated as matching nothing —
deliberately, so a filterless rule cannot grab an entire feed. Discovery never
sets a regex.

So a template with no match preferences produced a rule that was enabled,
auto-downloading, and permanently inert, with nothing indicating a fault. Match
preferences are now required, validated when the template is enabled and again
when the rule is written, and a template that cannot build a working rule holds
its titles for review rather than creating half-configured monitoring.
:::

Editing a ladder bumps the template's `version`, so a later change can tell which
generated rules are behind. A description-only edit does not.

## What protects your edits

**A rule you edit becomes yours.** The first time a person edits a
discovery-generated rule, `userModifiedAt` is stamped and never cleared.
Template re-application only touches generated rules where it is null. Past that
line your edit is the more specific intent, and reverting it on the next sync
would be the worst kind of automation — invisible, and correct-looking.

**Name collisions are never resolved by adoption.** If a generated rule's name
would collide with one you made, discovery skips generation, links the watchlist
entry to *your* rule, and reports why. Taking it over would replace your
preferences with a template's and leave no trace.

**Rules a person has taken over are listed, not hidden**, so a template change
can tell you what it deliberately did not touch.
