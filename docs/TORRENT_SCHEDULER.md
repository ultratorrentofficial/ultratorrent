# Torrent Activity Scheduler

UltraTorrent decides which torrents should be downloading, seeding, queued or
paused. Each engine executes those decisions through its own provider. The
scheduler is the policy authority; it is not a page for editing an engine's
native queue settings.

**It is off by default and does nothing until you turn it on.**

---

## The three modes

| Mode | What happens |
|---|---|
| **Native engine scheduling** | The default. Your engine keeps its own queue behaviour. UltraTorrent changes nothing and plans nothing — a native engine is skipped before any query runs. |
| **Observe only** | UltraTorrent works out what it *would* do and records it. No torrent is paused, resumed or removed. |
| **UltraTorrent managed** | Enforcement. Reachable only through the activation flow. |

Every engine starts on **Native**, and an engine with no configuration row means
the same thing. An upgrade enrols nobody.

### Why Observe Only is trustworthy

The preview and the enforced plan run **the same function**. What you validate in
Observe Only is what enforcement would do — a preview computed by a different
code path would be a guess about the real one.

---

## Turning enforcement on

Not a toggle. `Managed` cannot be reached by setting the mode; it goes through
activation:

1. the engine must actually be able to pause and resume,
2. a preview is generated from your **current** queue,
3. conflicts are reported,
4. you confirm that specific outcome — a request without confirmation is refused
   *and told what it would have done*,
5. only then does the mode change.

**Turning it off** returns the engine to native and **leaves scheduler-paused
torrents paused** unless you explicitly ask for them back. Blanket-resuming would
start downloads you did not choose to start, on an engine whose own limits are
about to take over again. The count is reported so the choice is informed.

---

## Policies

Limits, resolved most-specific-first:

```
torrent → RSS rule → category → library → engine → global
```

Field by field, so an override is a patch rather than a replacement: a library
policy setting only seeds still inherits the download limit above it.

Three values, and the distinction matters:

- **empty** — inherit from the scope above
- **explicitly unlimited** — stops inheritance, so a library can *lift* a global cap
- **a number** — that limit

Zero is refused. It reads like a way to stop the queue but is indistinguishable
from a typo, and would pause every torrent on the engine. Pausing is the honest
verb for that.

### What is enforced today

| Setting | Status |
|---|---|
| Max concurrent downloads / seeds / total active | **Enforced** |
| Global download and upload rate | **Enforced** |
| Seeding target by **ratio** | **Enforced** |
| Seeding target by **time** | **Not enforceable** — no engine reports seed duration |
| Bandwidth reserve (download/seed split) | **Not enforceable** — engines expose one ceiling, not two |
| Post-target **removal** | **Not performed** — belongs to Media Intake's safety checks |

The unenforceable ones are absent from the editor rather than present and broken.

---

## Queue occupancy

Download-active, seed-active and total-active are counted **separately**, so a
seed cannot consume a download's slot unless the *total* is what ran out.

A seed with no connected peers still occupies a seed slot. Requiring upload
traffic would free slots that are not actually free.

---

## Seeding

Once a torrent meets its target it stops — evaluated *before* the slot maths,
because "has it finished its obligation" is a different question from "is there
room". A finished seed should stop even on an idle engine.

Three refusals:

- a target that cannot be **evaluated** never stops anything;
- a policy that would stop seeding **waits for the import** to be real first,
  since the usual reason to seed past completion is that the library copy is not
  yet safe;
- **removal is never performed** by the scheduler.

---

## Schedules

Recurring windows override the resolved policy by time of day, stored as **local
wall-clock time plus a timezone** — "throttle overnight" means *your* night, and
your night moves twice a year.

- A window ending before it starts **crosses midnight**, and the day-of-week test
  applies to the day it *began* on: "Friday 22:00–02:00" runs into Saturday
  morning without Saturday being ticked.
- **Daylight saving** is handled by reading your local clock: a window inside the
  hour the clocks skip never occurs; one inside the hour that repeats occurs
  twice. Both are the correct reading of what you wrote.
- **Overlaps** resolve by priority, then by id, so a tie never flaps between
  sweeps.
- **"No new downloads"** stops things starting. It does **not** pause downloads
  already running — those are different promises.

---

## Per-torrent overrides

Available from the torrent itself, not just the scheduler page.

| Instruction | Effect |
|---|---|
| Never pause | Not paused to free a slot — but still counts toward limits and can still be started |
| Never stop seeding | Seeding continues past its target |
| Ignore entirely | Outside the scheduler's authority **in both directions** |
| Force start | Runs regardless of limits, so the rest of the queue has that much less room |

"Never pause" and "Ignore" are not the same, which is why they are separate.

Overrides can expire. Expiry is applied when they are read, so no cleanup job is
load-bearing: if it never runs, nothing wrongly stays in force.

---

## What each engine can actually do

| | qBittorrent | rTorrent |
|---|---|---|
| Pause / resume | native | native |
| Reports queued torrents | native | **no** — occupancy is inferred |
| Force start | native | **approximated** (high priority, no true force flag) |
| Global rate limits | native | native |
| Ratio | native | native |
| Seed duration | **no** | **no** |

Where a capability is missing or approximated, the plan says so rather than
promising something the engine cannot deliver.

---

## Coexistence with junk-queue parking

`TorrentParkingService` also pauses torrents — dead swarms holding active slots.
The two **coexist**: the scheduler treats a parked torrent as untouchable and
leaves it to parking. Activation warns you when parking is enabled, because two
systems pausing torrents on one engine is worth knowing about before the second
one starts.

---

## Events and automation

Four triggers: seed target reached, action failed, health changed, mode changed.

They describe **transitions, not heartbeats**. The sweep reconciles the same
state every minute; health publishes only when it changes, and repeating facts
carry a dedupe window. An event per tick is noise you learn to ignore.

Four actions — exclude, protect from pausing, protect from stopping, clear.
These are *instructions*, not verbs: pause and resume already exist and mean "do
this now", while these mean "and keep meaning it".

---

## Troubleshooting

**"I enabled it and nothing happened."** With no policies every limit is
unlimited, so there is nothing to enforce. Activation warns about this.

**"A torrent I paused is still paused."** By design. The scheduler never resumes
a pause it did not make.

**"It says a resume did not work."** The engine accepted the call and queued the
torrent anyway — its own queue limits are still in force. That is reported as a
native queue conflict rather than a success.

**"Seed-time targets do nothing."** Neither engine reports seed duration, so the
target cannot be evaluated. Use a ratio target.

---

## Status

Phases 1–10 are implemented. **None of it has yet run against a live engine** —
every property is established by unit tests. Observe Only exists precisely so
that can be checked safely before enforcement is switched on.
