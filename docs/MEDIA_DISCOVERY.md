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
