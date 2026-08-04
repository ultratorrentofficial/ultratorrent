# Torrent Activity Scheduler — security

What the scheduler can do to a queue, what stops it doing more, and what remains
unverified. Written from an audit of the shipped code, so where something is
*not* protected this says so rather than describing an intention.

The scheduler's power is narrow and specific: it can **pause and resume
torrents** and **set an engine's global rate ceiling**. It cannot delete a
torrent, cannot delete data, and never touches a filesystem path.

---

## Authority and consent

| Control | Where |
|---|---|
| Every mutation requires a permission | `@RequirePermissions` on all routes |
| Enforcement cannot be switched on by setting a mode | `SchedulerModeService.setMode` refuses `managed` |
| Enforcement requires a preview and an explicit confirmation | `SchedulerActivationService.activate` |
| Every mode change, override and activation is audited | `AuditService.record` at each site |

Four permissions, each guarding something real: `torrent_scheduler.view`,
`.manage_engine_mode`, `.manage_policies`, `.override`. They were added one phase
at a time, as the thing they guard came into existence — a permission that
guards nothing teaches operators that grants are decorative.

**Activation is a two-step consent.** A request without `confirm: true` is
refused *and told what it would have done* ("would pause 34 and resume 2"), so
enforcement can only be reached by asking twice, the second time knowing the
number.

---

## What the scheduler will not do, structurally

These are properties of the code, not rules someone must remember:

- **A user's pause is never undone.** Classification separates `user_paused`,
  `scheduler_paused` and `provider_paused`, and only the scheduler's own pauses
  are resumable. A pause nobody here claims is treated as somebody else's.
- **It cannot recognise a pause it did not make.** `TorrentSchedulerState` is
  written only *after* a pause verifies. A row claiming a pause that failed would
  let a later sweep resume a torrent a person had stopped.
- **It never deletes.** The two post-seed actions that would remove a torrent are
  refused by the planner regardless of policy, because removing a payload has to
  pass Media Intake's ownership and path-safety checks, which the scheduler does
  not own.
- **It leaves parked torrents alone.** `TorrentParkingService` pauses torrents
  for its own reasons; the two coexist rather than contend.
- **An observing engine is never touched.** Reconciliation runs only for
  `managed`, and a `native` engine is skipped before any query runs.

---

## Verification, not trust

A provider call that returns without throwing has not necessarily done anything.
Every action is verified by re-reading state:

- a pause that leaves the torrent downloading counts as **unverified**, not
  applied;
- a resume the engine **queues** — its own limits refusing us — is reported as a
  `native_queue_conflict` rather than a success, because claiming otherwise would
  tell the operator we control a queue that is in fact controlling us;
- a torrent that vanished mid-plan counts as done, since the desired end state of
  a pause is "not occupying a slot".

---

## Secrets

**Provider error messages are redacted before entering an event payload**
(`domain/redact.ts`). This matters because a scheduler event reaches the
automation engine and from there a webhook to a third party — a path the
operator cannot un-send.

Redacted: URL credentials (`scheme://user:pass@host`), secret-looking query
parameters (`passkey`, `apikey`, `token`, `auth`, `secret`, `password`), whole
URLs, and hex runs of 32+ characters. Messages are truncated to 300 characters.

Deliberately aggressive: a message that loses a hostname is mildly less useful; a
message carrying a tracker passkey into someone else's server is a credential
leak. **The application log keeps the full message** for whoever is debugging.

---

## Input validation

- **Info-hashes** are shape-checked (40 hex or 32 hex) before storage, because
  the value eventually reaches a provider call.
- **Engine ids** are resolved against the registry; an unknown one is a 404.
- **Policy limits** must be whole numbers ≥ 1, or explicitly unlimited. Zero is
  refused: it reads like a way to stop the queue but is indistinguishable from a
  typo, and would pause every torrent on the engine.
- **Scope contradictions** are refused rather than normalised — a "global" policy
  naming a library is a contradiction the resolver would silently ignore.
- **Schedule windows** with an unrecognised timezone or zero length are inert,
  not fatal and not guessed at.

The scheduler accepts no paths, so path traversal and symlink escape do not
apply to it.

---

## Denial of service and churn

- **Actions per sweep are bounded** (`maxActionsPerSweep`), so a large library
  settles over several sweeps rather than issuing hundreds of calls at once.
- **Hysteresis** (`minimumActiveSeconds`) stops a torrent being paused seconds
  after the scheduler started it.
- **Incumbency is the first tie-break**, so two equally-ranked torrents do not
  swap places every sweep.
- **Sweeps cannot overlap**; the flag is claimed synchronously.
- **Events describe transitions.** Health publishes only on a change; repeating
  facts carry dedupe windows. Without this a minute-by-minute sweep would emit an
  alert per tick, which an operator learns to ignore.
- **Per-sweep queries are bounded by the torrent count**, including the Media
  Intake lookup, which is filtered to the hashes currently loaded rather than
  every job the engine ever had.

---

## Races

| Race | Outcome |
|---|---|
| Operator pauses while a plan is applying | The pause is not attributed to the scheduler, so it is never resumed |
| Torrent removed mid-plan | Counted as done, not failed |
| Two sweeps for one engine | Impossible; the running flag is claimed synchronously |
| Automation and the scheduler both act | Both go through the same provider; the scheduler verifies its own result |
| Clock moves backwards | Schedule evaluation is stateless — it reads the clock and remembers nothing |

---

## Known gaps

Stated plainly, because a security document that lists only what is handled is
misleading.

1. **None of this has run against a live engine.** Every property above is
   established by unit tests. The global rate-limit setters added to both
   providers, the pause/resume verification path, and classification against real
   rTorrent state have never executed outside this repository.
2. **Seed time cannot be enforced.** Neither engine reports seed duration, so
   time-based targets evaluate to `unknown` and never act. This is reported, not
   silently treated as zero.
3. **Bandwidth reserves cannot be honoured.** The engines expose one upload
   ceiling, not a download/seed split. The cap is applied and the split reported
   unsupported.
4. **Native queue settings are not captured.** Neither engine exposes them
   through the provider interface, so disabling managed mode cannot restore
   them — recorded honestly as `captured: false` rather than an empty object
   implying a backup exists.
5. **Two systems can pause torrents.** `TorrentParkingService` and the scheduler
   coexist by design. Activation warns when parking is enabled; they do not
   contend for the same torrent, but an operator should know both are running.
6. **Overrides have no rate limit of their own** beyond the platform throttler.
