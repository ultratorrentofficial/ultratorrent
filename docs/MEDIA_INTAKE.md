# Media Intake Engine

A staging-based import pipeline. A completed download is verified, identified,
quality-scored and placed into a library by the cheapest method the storage
actually supports — normally a hardlink, so the torrent keeps seeding — then
enriched with metadata, artwork and subtitles before the media server is told.

**It is opt-in and off by default.** Nothing changes on an existing install
until you create a storage profile *and* deliberately switch a rule to Managed
Intake.

---

## Contents

- [Is it doing anything on my install?](#is-it-doing-anything-on-my-install)
- [Setting it up](#setting-it-up)
- [The lifecycle](#the-lifecycle)
- [Import strategies](#import-strategies)
- [Storage profiles](#storage-profiles)
- [Path mapping](#path-mapping)
- [Migrating an existing rule](#migrating-an-existing-rule)
- [When something goes wrong](#when-something-goes-wrong)
- [API](#api)
- [Extending it](#extending-it)

---

## Is it doing anything on my install?

Almost certainly not, and that is deliberate. Three things must all be true
before a single byte moves:

1. A **storage profile** exists.
2. An **RSS rule** has `importMode = managed_intake`.
3. A torrent **produced by that rule** finishes downloading.

Every rule that existed before this feature reads `legacy_direct` — the column
defaults to it, so the migration changed no behaviour — and the trigger returns
immediately for anything that does not trace back to a managed rule. A torrent
you added by hand has no rule behind it and is never intercepted, which is
correct: you already chose where it should go.

To confirm on a live install:

```sql
SELECT "importMode", count(*) FROM rss_rules GROUP BY "importMode";
SELECT count(*) FROM storage_profiles;
```

Zero profiles, or no `managed_intake` rows, means the engine cannot run.

---

## Setting it up

### 1. Choose a staging layout

Staging must not sit **inside** a destination library, and a library must not
sit inside staging. A scanner pointed at a library that contains staging will
index half-written files, and a partially copied episode that gets matched,
renamed and filed is very hard to unpick. The profile screen refuses either
arrangement by name.

A layout that works — libraries and staging as siblings under a parent nothing
scans:

```
/mnt/plexmedia/
    Staging/          ← intake stages here
    Movies/           ← library
    TV Shows/         ← library
```

**Your media server must not scan the parent.** Point it at `Movies/` and
`TV Shows/` individually.

### 2. Create a storage profile

**Media → Media Intake** (under Media settings). A profile needs a name and a
staging root; libraries are *referenced*, not re-specified, so pick them from
the list. Set the strategy to **Automatic** unless you have a reason not to.

### 3. Test the storage

Press **Test storage** on the profile. This creates and deletes tiny scratch
files under the destination to measure what is genuinely supported:

| Result | What it means |
| --- | --- |
| `Same device: yes`, `Hard link: yes` | Imports are instant and use no extra space. Ideal. |
| `Same device: no` | Staging and the library are on different mounts. Imports will **copy** — full size, full time. |
| `Reflink: yes` | Copy-on-write filesystem (btrfs, XFS, ZFS, APFS). Also instant. |

If you expected a hardlink and got `Same device: no`, move staging onto the same
filesystem as the library. That single fact is the difference between an
instant import and a 40 GB copy.

### 4. Point one rule at it

In the RSS rule dialog, set **Import mode** to *Managed Intake* and pick the
profile. Do one rule first and watch it before converting more.

### 5. Watch it

**Media → Intake Queue** shows the queue by state. Expanding a row shows the
full timeline: where the file came from, where it went, which strategy ran and
why, and every stage with its message.

---

## The lifecycle

```
completed → verified → identified → quality_scored → ready_to_import
          → importing → imported
          → metadata_ready → artwork_ready → subtitle_ready → seeding → archived
```

Everything up to `imported` works on a **path in staging**. Everything after
works on a **`MediaItem`**, which cannot exist until a library scan has found
the file — so enrichment necessarily follows the import rather than preceding
it. `identified` before the import is a *filename parse* that picks the
destination, using the same functions the rename engine uses; it is not the
creation of an item.

Quality scoring sits before the import decision on purpose: the score is what
decides upgrade over replace, and it is read from the file with `ffprobe`
rather than from a release name that merely claims 1080p.

Three states sit outside the line:

| State | Meaning | What to do |
| --- | --- | --- |
| `failed` | A stage errored. | **Retry** — it resumes at the stage that failed, not from the start. |
| `quarantined` | Something needs a human. | Look at it, fix the cause, then release it. |
| `cancelled` | You stopped it. | Nothing. |

`failed` and `quarantined` are deliberately different. A failure is "this did
not work, try again"; a quarantine is "a person must decide". Only verification
and identification can quarantine, because only they can form that opinion.

`seeding` is **not** counted as active work — it is indefinite and healthy, and
counting it would leave the queue permanently non-empty.

---

## Import strategies

Chosen automatically from measured capabilities, in this order:

| Strategy | Cost | Keeps seeding | Requires |
| --- | --- | --- | --- |
| **Hard link** | Instant, no extra space | Yes | Same filesystem |
| **Reflink** | Instant, no extra space | Yes | Copy-on-write filesystem |
| **Provider relocation** | Client moves the data | Yes | A client that genuinely relocates |
| **Copy** | Full size and time | Yes | Always works |
| **Move** | Instant | **No** | Never chosen automatically |

**`move` is never inferred.** It destroys the source, and an engine that
selected it because a filesystem lacked a feature would stop a torrent seeding
for a reason nobody asked for. Set it explicitly if you want it; the profile
screen says what it costs.

**Provider relocation is engine-specific and declared, not probed.**
qBittorrent's `setLocation` moves the payload. rTorrent's `d.directory.set`
only updates where rTorrent *believes* the data is and moves nothing — so it is
never offered there, because using it would leave the client seeding from an
empty path. Establishing this empirically would mean relocating a real torrent
to find out, so each provider declares it via `relocationMovesData()`.

An administrator override is always honoured, even when detection disagrees:
detection can be wrong about an exotic mount, and the audit records that the
choice was forced.

---

## Storage profiles

A profile owns the roots intake needs and **references** existing libraries
rather than restating their paths. A library already knows where it lives, how
it names files and which mode it uses; a second row holding a copy of that path
is a second thing to keep in sync, and the day they disagree an import goes
somewhere nobody expects.

| Field | Notes |
| --- | --- |
| Staging root | Required. Must be absolute, and isolated from the libraries. |
| Movie / TV / Music library | Optional each. A kind with no library **quarantines** rather than guessing. |
| Default strategy | `auto` unless you have a reason. |

A profile that rules still reference cannot be deleted — the foreign key would
`SET NULL` and silently strand those rules on a default naming different
libraries.

---

## Path mapping

The same bytes are `/mnt/plexmedia/x` to the host, `/downloads/x` inside the
backend container, and possibly a third thing to the download client and a
fourth to Plex. The registry translates a **canonical** path into whichever
spelling a component uses, so no module hard-codes one view of the filesystem.

Rules are prefix rewrites, matched **segment-wise** — `/media-backup` is not
inside `/media`, which a plain string prefix would get wrong and rewrite an
import into an unrelated tree.

You only need mappings when components disagree about paths. On a single-host
install where everything sees the same paths, no rule is needed and none is
created.

Diagnose one with:

```
GET /api/media/intake/path-mappings/resolve?path=/mnt/plexmedia/x&space=container
```

---

## Migrating an existing rule

There is no bulk wizard yet. Convert rules one at a time in the RSS rule
dialog; the change is **reversible** — switch back to Legacy Direct Import and
the rule behaves exactly as before.

What does *not* happen automatically, by design:

- No existing rule is ever converted for you.
- Editing a rule's name, regex or any other field **never** changes its import
  mode. Only sending the mode explicitly changes it.
- No existing torrent is moved, and no save path is rewritten.

Converting a rule affects **future** downloads from that rule only. Anything
already on disk stays where it is.

---

## When something goes wrong

**Nothing appears in the queue.** The gate refused it. Check the rule is
`managed_intake`, that a profile exists, and that the torrent traces back to
that rule (a hand-added torrent never will). The backend logs a warning when a
managed rule has no profile configured.

**Everything imports as a copy.** Staging and the library are on different
filesystems. Run **Test storage**; if `Same device: no`, that is the cause.

**An intake is quarantined.** Open it — the timeline says why. The common ones:
the payload is missing or zero bytes; the profile has no library for the kind
that was parsed; or the file was placed but the library scan would not take it,
which usually means an extension outside the library's filter or a permission
problem.

**An intake failed.** Retry resumes at the stage that failed, so metadata and
artwork already fetched are not fetched again.

**Metadata or artwork is missing but the file imported.** That is intended.
Enrichment never fails an import — the file is already in the library and
playable, and a provider outage is not a reason to hold media back. The
timeline records what was unavailable.

---

## API

All routes are under `/api/media/intake` and require the intake permissions:
`media_intake.view`, `.manage` (configuration), `.operate` (retry, cancel,
release) and `.migrate`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/summary` | Counts per state, and the active total. |
| `GET` | `/jobs?state=&active=` | The queue. |
| `GET` | `/jobs/:id` | One intake with its full event timeline. |
| `POST` | `/jobs` | Stage something by hand (`profileId`, `sourcePath`). |
| `POST` | `/jobs/:id/advance` | Run the pipeline from where it sits. |
| `POST` | `/jobs/:id/retry` | Resume a failed intake at its failing stage. |
| `POST` | `/jobs/:id/cancel` | Stop it. |
| `POST` | `/jobs/:id/release` | Release a quarantine back into the pipeline. |
| `GET`/`POST` | `/profiles` | List / create storage profiles. |
| `GET`/`PATCH`/`DELETE` | `/profiles/:id` | Read / edit / remove one. |
| `POST` | `/profiles/:id/probe` | Measure storage capabilities. **Writes scratch files.** |
| `GET`/`POST` | `/path-mappings` | List / create mapping rules. |
| `GET` | `/path-mappings/resolve` | Translate a path into a space. |

The engine is not torrent-only: `POST /jobs` needs a path and a profile, and
where those came from is not its business — a watched folder or a manual grab
works the same way.

---

## Extending it

**Adding a pipeline stage.** Implement `IntakeStage` — it declares the state it
`produces` and a `run` returning a message, optional data, or a `quarantine`
reason. Register it against `IntakePipelineService`. The engine sorts stages
into lifecycle order however they were registered, so a stage contributed by
another module cannot land in the wrong place.

The engine **stops at the first state it has no stage for** rather than
skipping. That is deliberate: skipping a missing stage would import something
that was never identified. It also means a stub stage returning success is
worse than no stage at all — it advances an intake past a check that never ran.

**Adding an import strategy.** Extend `IMPORT_STRATEGIES` in
`packages/shared/src/intake.ts`, add a case to `placeFile` in
`apps/backend/src/common/file-placement.ts`, and teach `selectStrategy` where
it sits in the preference order. `placeFile` is shared with the rename engine —
there is one implementation of how a file gets moved, and it returns **what it
actually did**, which is not always what was asked for.

**Adding a provider capability.** Declare it on `TorrentEngineProvider`. The
core engine branches on declarations, never on an engine name.

---

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md) — where intake sits in the system, and the
  dated Change Log entry for every phase of its construction.
- [LIBRARY_CLEANUP.md](LIBRARY_CLEANUP.md) — the other policy-driven engine that
  moves media, and the quarantine model this one borrows from.
