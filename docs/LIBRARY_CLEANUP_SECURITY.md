# Library Cleanup — threat model

The Library Cleanup Center is the only subsystem in UltraTorrent whose *purpose* is
to remove a user's media. Everything else here follows from that: the interesting
failures are not "an attacker gains access", they are "the system deletes something
it should not have, and nobody can say why".

This document enumerates what could go wrong and what specifically prevents it.
Each entry names the control, not an intention.

**Scope note.** Controls below are *code-level*. They assume the platform's existing
authentication, RBAC guard and audit log are sound; those are covered by
[SECURITY.md](SECURITY.md) and [JOB_SECURITY.md](JOB_SECURITY.md).

---

## A. Arbitrary removal

### T1 — A request names a file the policy never matched
**Control.** No cleanup endpoint accepts a path, a media file id, or a glob. Plans
are built from **candidate ids belonging to a specific run**; the server resolves
every path from its own snapshot. A candidate id that is not in the named run is
refused, and so is one whose status is not `candidate`.

### T2 — Path traversal into system directories
**Control.** Every filesystem operation resolves through `FilePathService` and is
confined to the **ops hard roots** (`FILE_MANAGER_ROOTS`), never the DB-configured
browse root. `assertDeletable` additionally refuses the filesystem root, any
configured storage root, and known system directories. Re-checked at execution
rather than trusted from the row.

### T3 — A path that was valid at scan time is not at execution time
**Control.** Confinement is re-derived from the recorded path immediately before the
filesystem call. A path that no longer resolves inside the roots is skipped as
`outside_roots`.

### T4 — Escalation to permanent deletion
**Control.** `permanent_delete` is not a valid policy destination — the validator
refuses it, `resolveDestination` cannot produce it, and the executor throws if a row
somehow carries it. Permanent removal exists only as a manual purge of an
already-quarantined item, behind `library_cleanup.permanent_delete`, which is in
`NEVER_INHERITED_PERMISSIONS`.

### T5 — A request escalates a plan's destination
**Control.** `ACTION_SEVERITY` allows a plan to be *softened* (trash → quarantine)
and never escalated. The reviewed policy document is the ceiling.

---

## B. Executable content

### T6 — Code injection through a policy
**Control.** A policy is a **JSON document**, evaluated by the platform's existing
constrained evaluator with eight fixed operators. There is no `eval`, no `Function`,
no template compilation, no shell, and no user-supplied executable of any kind
anywhere in the subsystem. An unknown condition id evaluates to `unmeasured`, not to
a lookup.

### T7 — Regex denial of service
**Control.** The `matches` operator runs against short, bounded fact values (paths,
codec names, labels), and documents are bounded by `POLICY_LIMITS` on condition
count, nesting depth, group width and total size — validated before publication.

---

## C. Authorization

### T8 — A user approves a removal they may not perform
**Control.** Approval requires `library_cleanup.approve` **and** the permission
matching the plan's destination (`ACTION_PERMISSION`). Checked in the service, not
only at the route guard, because scheduled and workflow paths reach the service
without traversing the controller. A refusal is audited.

### T9 — Blanket admin inheritance hands out the dangerous permissions
**Control.** `NEVER_INHERITED_PERMISSIONS` removes `permanent_delete` and
`protection.legal_hold` from `ADMINISTRATOR`'s otherwise-complete grant. They must be
assigned deliberately.

### T10 — An ordinary operator lifts a legal hold
**Control.** `library_cleanup.protection.legal_hold` is required to *place or revoke*
a hold, enforced inside `ProtectionService` as well as at the guard. A held item is
skipped by the executor with `legal_hold` recorded distinctly from ordinary
protection, and cannot be purged from quarantine.

### T11 — Self-approval as a rubber stamp
**Accepted, with a control.** Self-approval is permitted, because most installs have
one operator and an unusable approval flow is worse than an honest one. It is
recorded under its own audit action (`library_cleanup.plan.self_approved`) so a
reviewer can find every instance.

---

## D. Time-of-check / time-of-use

### T12 — A protection is placed while a plan awaits approval
**Control.** Protection is re-checked three times — at evaluation, at plan creation,
and **immediately before the filesystem step**. The third is the one that closes this
race, and it is mandatory.

### T13 — The file changes between approval and execution
**Control.** The candidate fingerprint is recomputed immediately before the
filesystem call and compared with the one approved. Any difference skips the file as
`fingerprint_drift`. The recomputation calls the *same code* that produced the pinned
hash, so the two cannot diverge as the codebase changes.

### T14 — The fingerprint cannot be recomputed
**Control.** Fails **closed**: an unrecomputable fingerprint is treated as drift, not
as "unchanged".

### T15 — An item is locked, played or made busy after approval
**Control.** Lock state, active Jobs Center work and playback are all re-checked
per file at execution.

### T16 — A plan is approved, then sits for a month
**Control.** Plans expire, **including approved ones**, because the evidence decays.
Expiry is checked inline at approval and again at execution, not only by the sweep.

---

## E. Double action and idempotency

### T17 — Two plans both remove the same file
**Control.** A candidate may belong to at most one non-terminal plan; creation
refuses a candidate already held by an open plan.

### T18 — A plan is executed twice
**Control.** The plan state machine allows `executing` only from `approved`, and only
`pending` actions are considered. A completed plan cannot re-enter execution.

### T19 — The Jobs Center retries a plan execution
**Control.** `library_cleanup.execution` is registered as **neither retryable nor
resumable**. A generic retry would remove files under an approval granted for a
different moment.

---

## F. Silent or misleading outcomes

### T20 — A truncated scan reads as a complete one
**Control.** A run stopped by its evaluation cap finishes as `partial` with
`evaluation_cap_reached:<n>`, never `completed`.

### T21 — "We could not tell" is read as "it qualifies"
**Control.** The evaluator's third outcome, `unmeasured`. Absent facts stay
`undefined` through fact assembly rather than becoming substituted defaults — an item
with no playback aggregate reports *no* playback facts, not zero plays.

### T22 — A partial execution reads as a clean success
**Control.** Any skip or failure finalises the plan as `partial`, and per-file
outcomes are recorded with their reasons.

### T23 — A crash leaves no evidence of what was in flight
**Control.** Every action row is journalled `running` before the filesystem call, and
a quarantine row is written before its move. A scan that throws finalises the run as
`failed` rather than stranding it in `running` forever.

### T24 — Reclaimed-space figures are inflated
**Control.** Reclaimed bytes are summed only from actions that actually completed.
(The historical Trash leak that made this figure a lie — a payload never unlinked
while its row was deleted — is fixed and regression-tested.)

---

## G. Availability and blast radius

### T25 — A misconfigured automatic policy empties a library overnight
**Controls, layered.** An automatic policy must be scoped, must be capped, must have
a grace period, and may not act on inferred technical data — enforced at validation.
Publishing does not enable. Storage-pressure runs stop at a recovery target and at
hard caps. A circuit breaker pauses the automatic path after three consecutive
failures. And every removal still lands in Trash or Quarantine, both recoverable.

### T26 — A cleanup starves the box or thrashes the database
**Control.** Scans page with narrow selects (500 rows) and cancel cooperatively at
page boundaries. Simulations are capped. Documents are size-bounded.

### T27 — A full-disk reading triggers a cleanup on a filesystem we cannot see
**Control.** A free-space reading is only usable if internally coherent; a zero-byte
total (what an unmounted path can `statfs` to) means **do not fire**. `bavail` is used
rather than `bfree`, so the trigger is not systematically late.

---

## H. Audit

### T28 — A removal cannot be traced afterwards
**Control.** Audited: policy create/publish/enable/archive/delete, run start and
outcome, plan create/approve/self-approve/refuse/reject/cancel/expire/execute,
quarantine add/restore/purge/purge-refused, protection create/revoke and legal-hold
operations. Candidate snapshots reference media by **plain id, not foreign key**, so
the record outlives the media row.

---

## Deliberately accepted

| # | Accepted | Why |
|---|---|---|
| A1 | Self-approval | See T11 |
| A2 | The Jobs Center mirror can silently fail | It is observability; the cleanup rows are authoritative, and a mirror that could abort a scan would be strictly worse |
| A3 | The circuit breaker is in-memory | A restart is a legitimate reset, and persisting it would let one bad night pause cleanup indefinitely with no obvious cause |
| A4 | Quarantine and Trash consume space until purged | That is the point; recoverability costs bytes |

## Known limitation

Several context facts assembled during **discovery** are conservative placeholders
(`onWatchlist`, `activePlayback`, `incompleteDownload`, `inFlightOperation`,
`pendingDuplicateResolution`, `isLastSurvivingCopy`, `hasVerifiedReplacement`). Each
defaults to the safe direction, so the cost is a candidate that should have been
offered rather than a file that should not have been touched. The executor re-checks
protection, lock state and active jobs for real. Wiring the remainder to live sources
is tracked work.
