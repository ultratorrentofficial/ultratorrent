# Context-Aware Management Actions (CAMA)

How UltraTorrent decides what a user can do with what they have selected.

CAMA replaces `object → find action` with `selection + context → relevant actions`.
Modules **declare** what they offer; every action surface is a projection of that one
registry — the same relationship the sidebar, breadcrumbs, command palette and mobile
switcher already have to `NAV_GROUPS` ([UX_GUIDELINES.md](UX_GUIDELINES.md), principle 2).

> **Status: foundation shipped, migration in progress.** The contract, the registry,
> the resolver and the API exist and are tested. **7** actions are declared (Media
> Manager). An audit found **120** distinct action surfaces across the app; they are
> being migrated workspace by workspace. Until that finishes, static toolbars and CAMA
> coexist, and this document describes the target as well as the present.

## Why

Three problems the audit measured, which no toolbar redesign fixes:

1. **Permission gating is missing from ~45% of action surfaces.** Analytics, Jobs,
   Duplicates, RSS rows, Automation and Users rows do no in-component permission check
   at all; they rely on route-level nav gating, so a directly-navigated route renders
   live buttons a user cannot use.
2. **Only one surface checks module state.** `usePaletteProviders` gates on both
   permission and module; everything else checks RBAC alone, so a disabled module still
   renders working buttons.
3. **State-dependent actions are hand-written per surface.** `rowActions(job)`, the
   cleanup policy row and the workflow editor each derive buttons from status
   privately — and each gates on status while forgetting to gate on permission.

Resolving centrally closes all three at once, and closes them for surfaces not yet
written.

## The model

An **action** is declared once, with its preconditions:

```ts
{
  id: 'media.metadata.refresh',   // dot-namespaced; i18n stem, analytics key, audit verb
  group: 'metadata',              // one of eleven platform-wide groups
  entityTypes: ['media_item'],    // what it can act on
  arity: 'any',                   // none | single | multi | any
  permissions: [P.MEDIA_MANAGER_EDIT_METADATA],
  module: 'media_manager',
  maxSelection: MAX_BULK_IDS,
  async: true,
}
```

An **entity** advertises what it currently supports:

```ts
{ type: 'job', id: 'abc', capabilities: ['cancellable', 'retryable'] }
```

Type and permission decide what is possible *in general*; advertised capabilities decide
what is possible *right now, for this row*. That is what turns three hand-written status
branches into one declaration (`requiresEntityCapability: 'cancellable'`).

## Where resolution happens, and why it is split

Two kinds of fact decide whether an action is offered, and they change at completely
different rates.

| | Facts | Resolved | Why there |
|---|---|---|---|
| **Slow** | permissions, module state, feature flags, provider availability | **Server**, once per session → `GET /api/context-actions/catalog` | Security-relevant, lives only on the server, changes rarely |
| **Fast** | what is selected, how many, of what type, Operations Mode | **Client**, on every selection change | A round trip per click is the opposite of "effortless" |

Resolving the fast facts on the server would put a network hop in front of every click.
Resolving the slow facts on the client would mean shipping the permission model to the
browser and trusting it. So the envelope is fetched once and re-filtered locally.

**Preconditions are stripped before sending.** A client that passed them does not need
them; one that failed them never receives the action. Shipping a permission list to a
caller who failed it would hand over a map of what they cannot do.

### CAMA is not a security boundary

Every endpoint keeps its own `@RequirePermissions` guard. CAMA decides what is worth
*offering*, never what is allowed to *run*. Withholding an action the server would refuse
is honesty, not enforcement — and Operations Mode is disclosure, not authorisation: an
action the server withheld never reached the client, so no client-side mode can restore it.

## Applicability vs availability

Two different failures, deliberately kept apart:

- **Inapplicable** — wrong entity type, wrong selection size, or operations-only in
  Browse Mode. The action is *irrelevant here*; showing it greyed out is clutter. Always
  hidden, whatever it asked for.
- **Blocked** — applies, but cannot run right now: over `maxSelection`, or some selected
  entity does not advertise the required capability. The user *expected* this action, so
  its silent absence reads as a missing feature.

A blocked action chooses its own treatment via `whenUnavailable`:

- `hide` (default) — an irrelevant action is clutter.
- `disable` — when absence would read as a bug. The Media Manager already does this
  deliberately for a locked item: the disabled button "has to be what tells them why it
  won't run".

A capability requirement must hold for **every** selected entity. Running on the subset
that qualifies would act on less than the selection without saying so.

## Action groups

Fixed and platform-wide, in this order:

`media · playback · metadata · artwork · subtitles · versions · collections · analytics · maintenance · export · administration`

Someone who learns that artwork work lives under **Artwork** in the Library Browser must
find it in the same place in the Duplicate Center. Groups are presentation, never
permission. Empty groups are omitted — a heading with nothing under it advertises a
category the user cannot use here.

## Entity types: what can actually be selected

This is the constraint that most shapes what CAMA can offer, and it is easy to get wrong.

**Real rows with stable ids** — `library`, `media_item`, `torrent`, `collection`,
`cleanup_candidate`, `duplicate_group`, `subtitle`, `artwork`, `file`, `trash_item`,
`job`, `notification`, `user`, `automation_rule`, `rss_feed`, `rss_rule`, `indexer`.

**Projections with no id of their own:**

- `tv_show` and `season` — the Library Browser groups flat `MediaItem` rows at query
  time. An action targeting one resolves to the item ids underneath it. Two further
  traps: a `MediaShow` row *does* exist but is keyed to a show **folder** and used only
  by the acquisition watchlist — it is not the browser's show; and the series key is
  derived from the **path**, so it changes when a folder is renamed. Carry it through a
  request, never store it as durable.

**Declared but not representable** — `media_version` (no `MediaVersion` model exists at
all), `playlist`, and music/photo entities (`MediaItem.mediaType` admits only video
types, so such libraries scan as `other_video`).

Registering an action against an entity that cannot be identified is how a menu ends up
offering work the platform cannot do. Prefer leaving it out.

## Adding an action

1. Declare it in your module's actions file (see `media-actions.ts`).
2. Register it from the module's `onModuleInit` via `CapabilityRegistry.registerAll()`.
3. Add the i18n key `action.<id>` to **both** locales.

No UI changes. The registry rejects duplicate ids (two modules claiming one id is a
wiring bug, and last-write-wins would make the winner depend on module load order) and
rejects an entity action that names no entity type (it would apply to every selection of
every kind — the opposite of context-aware).

**Do not declare an action whose endpoint does not exist.** CAMA makes actions easy to
add, which makes that mistake easy too; the result is a button in front of a 404.

## Provider capabilities

`CapabilityRegistry.setProviderCapability(key, available)` is a **snapshot, not a probe**.
Resolution runs on every catalogue fetch and must not perform I/O — asking six providers
whether they are reachable, in line, would make the toolbar wait on the slowest. Modules
push state when it changes (after a health check, on config save); resolution reads it in
O(1).

The codebase currently implements "capabilities" five separate times with no shared
abstraction (media servers, subtitle providers, TV-show-status providers, IMDb, indexers,
plus job capabilities and workflow node definitions). This registry is the seam those can
converge on; none have been migrated yet.

## Feature flags

`ModuleManifest.features` has been carried through the registry and out of the API since
it was introduced and **read by nothing**. CAMA is its first consumer, defining a feature
as on when an *enabled* module declares it — so a module that is turned off takes its
features with it, without anyone maintaining a second list.

## Diagnostics

The catalogue reports why it is what it is:

```json
{ "total": 7, "withheld": { "permission": 1, "module": 0, "feature": 0, "provider": 0 } }
```

Not consumed by the UI. It exists so "why can't I see Download Subtitles?" is answered by
the API rather than by a maintainer reading resolution code. Each withheld action is
attributed to the **first** reason that ruled it out, so the counts sum to the total.

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — where CAMA sits among the core principles
- [UX_GUIDELINES.md](UX_GUIDELINES.md) — shell conventions this mirrors
- [LIBRARY_BROWSER.md](LIBRARY_BROWSER.md) — the projection-not-hierarchy decision
- [JOB_ARCHITECTURE.md](JOB_ARCHITECTURE.md) — `async` actions dispatch as platform jobs
