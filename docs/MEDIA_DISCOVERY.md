# Media Discovery

Discovery answers one question: **what should UltraTorrent be monitoring?**

It finds upcoming films, new and returning series from metadata providers,
decides which of them are worth watching for, and turns the qualifying ones into
a watchlist entry plus an acquisition rule. Everything after that belongs to
systems that already existed — the acquisition sweeps monitor the watchlist, and
Smart Download decides whether any particular release is worth taking.

**Discovery never downloads anything.** It does not score releases, does not talk
to an indexer, and has no opinion about whether a given file is good enough. If
it ever appears to need one, the answer is to call the acquisition engine rather
than grow a second one.

- [What it does, end to end](#what-it-does-end-to-end)
- [Nothing happens until you say so](#nothing-happens-until-you-say-so)
- [Setting it up](#setting-it-up)
- [The inbox](#the-inbox)
- [Providers](#providers)
- [Limits](#limits)
- [What it will not do](#what-it-will-not-do)
- [Troubleshooting](#troubleshooting)
- [Permissions](#permissions)
- [API](#api)

---

## What it does, end to end

```
providers ─► merge ─► store ─► evaluate ─┬─► ignore
 TMDB                                    ├─► notify        (inbox only)
 TVmaze                                  ├─► needs review  (waiting on you)
                                         └─► auto-monitor
                                                │
                                    watchlist entry + generated RSS rule
                                                │
                                    existing acquisition sweeps
                                                │
                                        Smart Download decides
```

Two schedules drive it, both using the platform's existing scheduler:

| Job | Interval | What it does |
| --- | --- | --- |
| `media_discovery_provider_sync` | hourly tick, refreshes a provider every 6 h | Pulls catalogues, merges, stores. **Decides nothing.** |
| `media_discovery_evaluate` | hourly | Runs enabled templates over stored titles and acts on the results. |

A catalogue refresh writes rows and updates counters. It cannot, by itself, cause
an acquisition — that separation is why a sync can run on a schedule without
anyone worrying about what it might start.

## Nothing happens until you say so

There are **three doors** between a fresh install and an automatic download, and
all three are shut:

1. **The module is disabled.** Media Discovery is the only optional module that
   ships `enabledByDefault: false`. Enabling it is you saying the system may
   acquire media on its own, and a module that arrived switched on would make
   that an accident rather than a decision.
2. **Providers are silent.** No third-party call is made until you enable a
   provider. A fresh install contacts nobody.
3. **Templates are disabled.** A template is saved off and must be explicitly
   enabled, after you have previewed what it would do.

## Setting it up

**1. Enable the module** — System → Modules → Media Discovery.

**2. Enable a provider** — Media Acquisition → Discover → Providers.

- **TVmaze** needs no credentials and covers television.
- **TMDB** covers films and television and reuses the API key from Media Manager
  settings. If it shows *Not configured*, the card tells you where to set one.

Then **Refresh catalogues**. The first sync takes a few seconds and populates the
inbox. Nothing is monitored yet.

**3. Create a template** — Discover → Templates → New template.

Fill in what to look at (media type, how far ahead, languages, regions, which
release types count), then the category policy, then — only if the template
auto-monitors anything — the feed, storage profile and acquisition template. See
[MEDIA_DISCOVERY_TEMPLATES.md](MEDIA_DISCOVERY_TEMPLATES.md) for what each field
means.

**4. Preview before you enable.** Preview runs the real evaluator over the
catalogue you already have and reports exactly what would happen, without writing
anything. It also tells you how many titles your weekly limit would hold back —
which is worth knowing before enabling rather than from a full inbox.

**5. Save and enable.**

## The inbox

Every card carries the reason it is there. A discovery engine that silently
monitors things is one you can neither trust nor correct, so the decision and its
reason sit on the card rather than behind a detail view.

| State | Meaning |
| --- | --- |
| **Monitored** | A watchlist entry and an acquisition rule exist. Acquisition is now the existing engine's job. |
| **Notify** | Surfaced for you. Nothing was created. |
| **Needs review** | The engine *would* have acted and could not safely — an unresolved identity, or the automatic-add limit already spent. |
| **Ignored** | Not what the template is looking for. Filed so it stops reappearing. |

**Needs review is not notify.** One says "you might want this"; the other says
"we nearly did something and stopped." They are triaged differently, which is why
they are separate.

A title with an **ambiguous identity** is called out in amber. That means two
different works share a title and year — TMDB carries three separate 2026 films
called *The Odyssey* — and the engine refused to guess. No template setting can
override this: a wrong external id propagates into duplicate detection and every
downstream lookup, while an unmonitored title merely waits for you.

## Managing the catalogue

### When a title airs

A card shows the soonest dated release **in your own timezone**, with a relative
time beside it — "Sat, 15 Nov 2026, 09:00 PM (in 3 days)".

Two kinds of date arrive from providers, and only one of them may be converted:

| Field | What it is | How it is shown |
| --- | --- | --- |
| `airsAt` | A real instant the provider stated — TVmaze publishes an `airstamp` with an offset | Local date **and clock time** |
| `date` | The network's **local calendar date** | The day it says, with no time |

**A calendar date is never converted.** `2026-11-15` read as an instant is
midnight UTC, which renders as **14 November** for every viewer west of UTC —
quietly, so a show simply appears to air a day early. TVmaze also schedules by
the network's local airtime, so a late-night episode already carries the previous
calendar date; converting it again would compound the error rather than fix it.

### Removing titles in bulk

Tick the checkbox on any card, or **Select page**, and remove them together at the
same three scopes as a single title. The count sits beside the button, because a
selection you have forgotten about is the thing that makes a bulk action
dangerous.

The bulk dialog deliberately shows **no per-title plan**. Forty plans is not
something anybody reads, and rendering them would imply a review that is not
happening — so it states the rules that hold for every title instead. To see what
a specific removal costs, remove that title on its own, where the plan is shown.

**One failure does not abandon the rest**, and partial success is reported as
partial: a bulk action reporting "removed 40" while four failed is worse than one
that failed outright, because nothing prompts anybody to look.

### Removing a title

Every card carries a **Remove** action, and it asks what you mean, because
"remove this show" means three different things:

| Scope | Removes |
| --- | --- |
| **From the catalogue only** | The discovered title and its evaluations. Monitoring keeps running. |
| **…and stop monitoring it** | Also the generated RSS rule, and archives the watchlist entry. |
| **…and delete the library media** | Also the media items, their artwork, subtitles and NFO sidecars — optionally the torrent and its data. |

The dialog shows **what each scope would actually take** before you confirm —
counts from the server's own plan, not a guess. The least destructive scope is
the default; escalating is a deliberate second click.

**Library media is matched by external id only.** Title-and-year is good enough
to group a listing and nowhere near good enough to delete by: two films
genuinely share a title and year. A title carrying no external id reports that
it cannot be identified and its files are left alone.

**Files go to Trash**, through the same path-safe service the File Manager uses —
`MediaBulkService.deleteFiles`, which already handles sidecars, artwork and the
source torrent, and runs as an audited background job. There is no second
deletion path here.

**A removed title does not come back.** Its identity is recorded as a
*suppression*, checked on every sync — otherwise the next catalogue refresh
re-creates the row within six hours and the deletion reads as a bug. Suppressions
are listed at `GET /suppressions` and cleared with `DELETE /suppressions/:key`.

### Editing a template re-decides the catalogue

A template edit that changes **policy** — categories, thresholds, scope, or the
destination a rule is built from — bumps its `policyVersion` and **clears that
template's decisions**, so every stored title is judged again under the new
policy. Renaming a template, or merely enabling and disabling it, does not.

Pressing **Refresh catalogues** fetches from the providers *and* re-evaluates
everything, then reports what changed. That is the button people press after an
edit, and it used to answer a different question — returning only newly-fetched
titles while every already-decided title kept its old verdict, which looked
exactly like the edit had done nothing.

### Titles that stop matching

When a re-evaluation finds a title this system had auto-monitored no longer
qualifies, the monitoring is **withdrawn**: the generated rule is deleted, the
watchlist entry archived, and — if the title is now out of scope entirely or
explicitly ignored — it leaves the catalogue. Every retraction publishes a
notification, because it undoes something done on your behalf.

Three things retraction never does:

- **It never deletes media or torrents.** Retraction runs from a background
  sweep that fired because somebody edited a genre list. A sweep that deleted
  40 GB of episodes as a side effect of that edit would be unrecoverable and
  invisible. Deleting media stays explicit, scoped and previewed.
- **It never touches a rule you edited.** Past that first edit the rule is
  yours; the delete is filtered on `userModifiedAt: null` rather than branching
  on it.
- **It never overrules a watchlist entry you paused, archived or completed.**

## Reviewing instead of automating

A template can be told **not** to act on its own: turn off *Monitor matching
titles automatically*. Everything it would have monitored is then held for review
with the reason "Qualified, but this template does not monitor automatically",
and waits for you.

This is a switch rather than "clear the auto-monitor categories". The categories
record what you are **looking for**; emptying them to stop automation throws that
away too.

### Deciding on a held title

Every held card carries **Import** and **Decline** beside its reason, because the
decision belongs where the explanation is.

- **Import** runs the *same* creation path an automatic monitor takes — watchlist
  entry, generated rule with its ladder and target path, and the intake directory
  if the template asks for one. An imported title is configured identically to one
  the engine acted on itself, because it is the same code. A second creation path
  would be a second set of bugs.
- **Decline** files it as ignored, so it stops reappearing without losing the
  record that it was seen and declined. Removing it from the catalogue entirely is
  the separate, explicit delete.

Two things Import does differently from automation, both deliberate:

- **The automatic-add limit does not apply.** That limit paces the *engine*; a
  person clicking Import has already made the decision it exists to defer to.
- **The identity gate still applies.** Importing something already monitored links
  to what exists rather than creating a duplicate — which is exactly when somebody
  might approve a show they already have.

An unready template still refuses: importing into a template with no usable match
preferences would produce the half-configured monitoring the readiness check
exists to prevent, just reached by hand.

### Being told there is something to review

Discovery publishes **"Discoveries need review"** whenever a run holds titles back,
summarised per run rather than one per title.

To get it by **email**: **Account → Notifications**, find *Discoveries need
review*, and enable the email channel. It is off by default — and so is every
other external channel for every event — because a channel you have not connected
cannot deliver, so turning it on for you would produce silent failures rather than
mail. Email also needs SMTP configured under **Settings → Email settings**.

## The identity gate: nothing is created for a show you already have

Before a watchlist entry, an acquisition rule or an intake directory is created,
discovery asks one question: **does this work already exist here?**

Lookup order — **external ids are proof, titles are a hint**:

1. A watchlist entry carrying the same TMDB / IMDb / TVDB / TVmaze id
2. A watchlist entry whose **canonical** title and year are the same
3. An acquisition rule for the same work — matched canonically, not by display name
4. Library media carrying the same external id

The outcome replaces the auto-monitor:

| Found | Decision | What happens |
| --- | --- | --- |
| Watchlist **and** rule | `already_monitored` | Nothing is created or overwritten |
| One but not the other | `exists_monitoring_incomplete` | Surfaced so the missing half can be completed |
| Library only | `exists_not_monitored` | Surfaced; monitoring is not started unasked |
| Nothing | `auto_monitor` | The only case that may create a new monitored show |

**A presentation year is not an identity.** `The Terminal List`, `The Terminal
List (2022)`, `THE TERMINAL LIST` and `The.Terminal.List.2022` are one work. The
year is lifted out of the title and compared as a year, so it can no longer fork
a show into two monitored copies — which is exactly what it used to do.

The stripping is deliberately narrow. `Blade Runner 2049`, `2012`, `1923`,
`Fahrenheit 451` and `Apollo 13` keep their numbers: only a **trailing**
parenthesised year, or a trailing year behind a release-name separator
(`The.Terminal.List.2022`), is treated as presentation.

**A different year is a different work.** `The Odyssey (1997)` and
`The Odyssey (2026)` never merge. A *missing* year on either side is missing
information rather than a mismatch, because hand-added entries rarely have one.

**Idempotent, and safe under concurrency.** The catalogue row is linked to
whatever already exists, so repeating a sync changes nothing. A partial unique
index allows at most one generated rule per discovered title, so two providers
reaching the same show at once end with one rule — the loser of the race resolves
to the winner's row rather than failing.

## New and upcoming only

Auto-monitoring is limited to series that **have not premiered yet**. This is a
hard eligibility rule, not a scoring preference: no category, threshold or score
can carry a title past it.

It closes a real defect. The only date test used to ask whether a title had *any*
release date of a wanted type in the forward window — and TVmaze reports
`episode_air` and `season_premiere` for shows that started years ago. So a 2022
series airing an episode this week qualified, and an auto-monitor category then
monitored it. The evaluator could not see a premiere date at all; the field was
stored and populated, and simply never passed along.

| Premiere | Decision |
| --- | --- |
| Tomorrow, or today | `auto_monitor` (subject to everything else) |
| Yesterday, grace 0 | `review_past_release` |
| Yesterday, grace 3 | `auto_monitor` |
| A year ago | `review_past_release` |
| Unknown | `needs_review` |
| Providers disagree | `needs_review`, with both dates kept |

**Unknown and conflicting dates refuse to automate.** Treating an unknown date as
acceptable is exactly the case this gate exists to prevent, and it would be
silent.

**A grace period never appears on its own.** The default is 0 — the premiere must
be today or later. It is capped at 14 days, because past a fortnight it stops
being a grace period and becomes back-catalogue import wearing its name.

**Past releases are reviewed, not acted on.** The choices are *Show for review*
(the default) and *File away*. There is deliberately no automatic option.

### Returning series are a different question

A series that premiered in 2022 and has a new season coming is not a new series.

- **Already here?** It keeps being monitored under its existing identity. Nothing
  new is created, and it is not reported as a past-release review item — that
  would be noise about something working correctly.
- **Not here?** `review_past_release`. The older series is never imported
  wholesale on the system's own initiative; a person may still add it.

### Films are not gated on their premiere

Deliberately. "Monitor films once they reach **streaming**" is a legitimate
configuration, and a film's digital date is routinely a year after its theatrical
one — gating on a past premiere would break it. For films, the release-type and
window rules already define what "upcoming" means.

## Match preferences are required for auto-monitoring

A discovery template that auto-monitors anything **must** reference a match
preference profile with at least one enabled rung. The generated rule then
carries the whole ladder — every rung in order, the template-wide required and
excluded terms merged into each, quality and size rules intact — and is enabled
and staged through managed intake, ready to acquire the moment an acceptable
release appears. There is no second configuration step.

:::danger Why this is required rather than optional
A rule is filtered by its match candidates if it has any and by its
include/exclude regex otherwise. A rule with **neither** matches nothing —
deliberately, so a filterless rule cannot grab an entire feed. Discovery never
sets a regex.

So a template without match preferences used to produce a rule that was enabled,
`autoDownload: true`, and permanently inert, with nothing anywhere indicating a
fault. (The fallback to auto-download profiles and global defaults is real, but
it serves the watchlist and missing-episode search — not RSS feed matching.)

It is validated twice: when the template is enabled, and again when the rule is
written. A template that cannot build a working rule holds its titles for
`needs_review` with the reason, rather than creating monitoring that looks
complete and does nothing.
:::

## Reconciling duplicates that already exist

The identity gate stops **new** duplicates. It cannot help with the ones created
before it existed — two watchlist entries, two rules, possibly two intake folders.
**Discover → Duplicates** finds them and proposes a merge.

Groups are formed two ways, and the card says which:

| Evidence | Meaning |
| --- | --- |
| **Same external id** | Proof. Two entries naming the same TMDB / IMDb / TVDB / TVmaze id are one work. |
| **Same title and year** | A proposal. Canonical, so `Tulsa King` and `Tulsa King (2022)` group — but only when no id contradicts it. |

**Contradicting ids beat agreeing titles.** Two entries that both carry an IMDb id
and carry different ones are never grouped, whatever their titles say. That is
what keeps a remake out of its original's group.

### Nothing is merged without you

The tool recommends which entry to keep, ordered by **what is hardest to
recreate** — a hand-made rule first, then one that was edited, then acquisition
history, then external ids, with the oldest entry breaking a tie. You can choose
differently; the plan updates to show what that choice would cost.

### A loser is archived, never deleted

Four tables hang off a watchlist entry, and `WantedEpisode` is unique on
`(watchlistItemId, season, episode)`. Reparenting that history onto the keeper
would collide on every episode both entries know about, and resolving those
collisions means discarding rows. Archiving keeps every row exactly where it is,
keeps the history readable, and is reversible by setting a status back.

A merge does exactly four things:

1. **Archives** the duplicate entries.
2. **Adds** external ids the kept entry was missing — never overwriting one it
   already has. A differing id is reported as a warning, because silently
   overwriting an identity is how the wrong show gets acquired afterwards.
3. **Deletes** generated rules nobody has edited.
4. **Keeps** every rule that was made by hand or edited by hand, and says so.

**Media, torrents and hand-authored settings are never touched.** A duplicate is
a bookkeeping problem; the files were never duplicated.

## Providers

Three states, and only one is a fault:

| State | What it means | What to do |
| --- | --- | --- |
| **Not configured** | No credential on this installation | Follow the hint on the card |
| **Configured but off** | Silent by choice — the normal fresh-install state | Nothing |
| **On and unhealthy** | The catalogue refresh failed | Read the failure reason on the card |

Health comes from what the last sync recorded, not from probing when you open the
page — a page load must never wait on a third party, and a transient blip is not
a provider's condition.

**Refresh catalogues only contacts enabled providers.** Naming a disabled one
explicitly is refused rather than obeyed — the endpoint is not a way around the
switch — and the response says which were skipped.

Disabling a provider does **not** remove titles it already contributed. That is
deliberate: a provider going quiet is not a provider retracting what it found. If
you want those titles gone, remove them from the catalogue — selecting several at
once is one action.

**A failed refresh keeps the previous catalogue.** "We could not ask" and
"nothing is coming out" are very different claims, and emptying a catalogue
because a network call failed would say the second when the first is true.

## Limits

`autoAddLimitPerDay` and `autoAddLimitPerWeek` pace acquisition. They use
**rolling windows**, not calendar days: "10 per day" means no more than ten in any
24 hours, because a calendar boundary lets twenty land across midnight — the
exact burst the limit exists to prevent.

**An over-budget title is held for review, never dropped.** The limit paces
acquisition; losing the title would be a different and worse feature.

Only additions that actually happened count. A decision whose rule generation
then failed produced no monitoring, so it does not spend budget — otherwise a run
of failures would silently exhaust the allowance and hold back the titles that
could have succeeded.

A limit of **0 means none**, not unlimited.

## What it will not do

- **Download anything.** Ever. It creates the monitoring; the acquisition engine
  does the rest.
- **Auto-monitor an ambiguous identity**, whatever the template says.
- **Take over a rule you made.** If a generated rule's name would collide with
  one of yours, discovery skips it, links the watchlist entry to your rule, and
  says so.
- **Revert your edits.** Once you edit a generated rule it is yours;
  template re-application leaves it alone.
- **Reactivate something you paused.** A `paused`, `archived` or `completed`
  watchlist entry is a decision you made, and a background sweep that undid it
  would be indistinguishable from a bug.

## Troubleshooting

**"Nothing appears in the inbox."** No provider is enabled, or no sync has run
yet. The Providers tab shows both.

**"TMDB says Not configured."** Discovery reuses the Media Manager TMDB key.
Set one there and the provider registers on the next backend start.

**"Everything is in Needs review."** Usually one of two things. Either the
identities are weak — TVmaze-only shows often carry no IMDb or TVDB id, which
caps confidence below the default 0.8 floor — or the automatic-add limit is
spent. The reason on each card says which.

**"A show I know matches says *Outside this template*."** Read the reason on the
card — it names the gate that rejected it. The commonest causes are the template's
**languages**, **regions** and **release types**, which are scope filters: a
template listing `series_premiere` only will pass over a returning series that has
an episode airing, because that is not a series premiere.

:::note Languages are matched canonically
Providers disagree about what a language is called — TMDB stores `en`, TVmaze
stores `English` — and both end up in one catalogue. They are compared through a
canonical form, so a template naming either matches a title stored as the other.
A language nothing recognises still matches itself.
:::

**"A title says *Not evaluated*."** It no longer should: a title a template judged
and found out of scope reads **Outside this template** with the reason. If it
genuinely says *Not evaluated*, no template has reached it yet — a sweep examines
up to 500 titles per run.

**"My template monitors nothing."** Check the category policy against the genres
your providers actually emit. TMDB says `Science Fiction`; TVmaze says `Science
Fiction` too, but plenty of shows carry no genres at all — and a title with **no**
categories never matches, under any match mode.

**"A title I wanted was ignored."** A template only monitors what it names.
A title matching none of the configured categories is ignored, because surfacing
everything a template did *not* ask about would bury the titles it did.

**"It found a film I already have."** Discovery does not check your library —
it reports what is being released. The watchlist and Smart Download handle
whether you already own it.

## Permissions

| Permission | Grants |
| --- | --- |
| `media_discovery.view` | Read the inbox, templates and provider status |
| `media_discovery.manage` | Act on the inbox; run an evaluation |
| `media_discovery.templates.manage` | Author templates; run previews |
| `media_discovery.providers.manage` | Enable providers; request a sync |

Read-only and ordinary users get `view`. Power users add `manage`.
Administrators get all four. Seeing what was discovered and deciding that the
system may acquire media on its own are deliberately different privileges.

## API

Base path `/api/media-discovery`. No endpoint calls a provider — a sync is queued
against the background service and the inbox reads the database, so a page load
never waits on TMDB.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/providers` | `view` |
| `POST` | `/providers/:name/enable` | `providers.manage` |
| `GET` | `/inbox` | `view` |
| `GET` | `/items/:id` | `view` |
| `GET` `POST` `PATCH` `DELETE` | `/templates` | `view` / `templates.manage` |
| `GET` `POST` `PATCH` `DELETE` | `/acquisition-templates` | `view` / `templates.manage` |
| `GET` | `/template-options` | `templates.manage` |
| `POST` | `/preview` | `templates.manage` |
| `POST` | `/sync` | `providers.manage` |
| `POST` | `/evaluate` | `manage` |

## Further reading

[MEDIA_DISCOVERY_TEMPLATES.md](MEDIA_DISCOVERY_TEMPLATES.md) ·
[SMART_DOWNLOAD.md](SMART_DOWNLOAD.md) ·
[MEDIA_INTAKE.md](MEDIA_INTAKE.md) ·
[ARCHITECTURE.md](ARCHITECTURE.md#media-discovery-engine)
