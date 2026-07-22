# Library Cleanup Center

Policy-driven, explainable, reversible reclamation of library storage.

Module `library_cleanup` · API `/api/media/cleanup` · Media workspace · Core (RBAC-gated)

---

## 1. What this feature is allowed to decide

Cleanup **proposes**. People **decide**. The system then does exactly what was
decided, or nothing.

Every removal in this subsystem travels the same road:

```
policy (immutable version)
   └─ run          → candidates          (nothing is removed)
        └─ plan    → pinned fingerprints (nothing is removed)
             └─ approval                 (nothing is removed)
                  └─ execution           ← the only filesystem call
                       └─ Trash / Quarantine  (both reversible)
```

There is no shortcut through that road. In particular:

- **No endpoint accepts a path.** Plans are built from candidate ids produced by a
  run; the server resolves every path itself from its own snapshot. A request body
  cannot name a file the policy never matched.
- **Nothing is deleted outright.** The only destinations a policy may target are
  Trash and Quarantine, both recoverable. Permanent removal is a separate,
  separately-permissioned, manual act on an already-quarantined item.
- **Matching is not permission.** A file that matches a policy is a *candidate*.
  It becomes an action only after the mandatory exclusion pass, a plan, and an
  approval — and even then only if nothing has changed in the meantime.

## 2. Policies

A policy is a mutable **draft** plus frozen **published versions**, mirroring the
Workflow Builder. Publishing freezes the draft; it does **not** enable the policy,
because arming something destructive is a separate decision from writing it down.
A run pins the version it started on, so editing a policy can never change what an
in-flight cleanup is doing.

Conditions are a **declarative document**, evaluated by the platform's existing
constrained evaluator — the same eight operators the Automation Engine and Workflow
Builder use. There is no expression language, no `eval`, no compiled JavaScript,
and nothing in a policy is executable.

### The third outcome

An ordinary rule engine answers *true* or *false*. This one answers **matched**,
**not matched**, or **unmeasured**.

`unmeasured` exists because "we could not tell" must never read as "it qualifies".
A resolution condition on a file whose dimensions were guessed from its *filename*
is unmeasured, not false; the candidate is excluded with that reason recorded,
rather than silently matching or silently vanishing.

### Modes

| Mode | Meaning |
|---|---|
| `report_only` | Produces findings. Cannot produce a plan at all. |
| `approval_required` | Produces plans a human must approve. |
| `auto_quarantine` / `auto_trash` | Held to a materially higher validation bar (see below). |

An **automatic** policy must be scoped to at least one library, kind or path; must
cap items or bytes per run; must set a grace period; and may not act on
filename-inferred technical data. An unscoped, uncapped automatic policy addresses
every library at once with no ceiling, which the validator refuses outright.

## 3. Protections

A protection says "automatic cleanup may not touch this", across twelve scopes:
file, item, show, season, episode, library, path prefix, tag, collection, watchlist,
torrent, and external identity.

- Matching is by **stable database identity**, never by a path snapshot — a moved
  file is still the same file, and matching on its old path would both miss it and
  protect whatever now occupies that path.
- Path-prefix matching respects segment boundaries, so `/media/Movies` cannot
  protect `/media/Movies2`.
- **Conditional protections fail closed.** An unknown fact or an unrecognised
  condition keeps the target protected. Uncertainty must never become deletion.
- A **legal hold** is surfaced distinctly and cannot be lifted by an ordinary
  operator. It is not granted by blanket role inheritance (see RBAC).
- Removing a protection is a **revocation**, not a delete, so the history survives.

Protection is re-checked **three times**: at evaluation, at plan creation, and
immediately before the filesystem step. The third is mandatory and exists to close
the race — a protection placed while a plan sat awaiting approval must save the file.

## 4. Runs and candidates

A run walks the policy's scope with a paged, narrow select and records what the
policy says about each file:

- **Fingerprint** — a hash over the policy-relevant facts (id, path, size, identity
  keys, policy version, the facts this version reads, protection state, replacement
  state). Only relevant facts, so unrelated churn does not invalidate every plan
  until "changed" stops meaning anything.
- **Reason snapshot** — what matched, what was unmeasured, what excluded it, and the
  facts behind each. An operator reviews a statement of fact, not a verdict.
- **Rank** — for storage-pressure runs, a fixed set of weighted, *named* factors,
  each contributing a stated number of points with a human-readable reason. There is
  deliberately no learned or opaque score: an operator must be able to read "why this
  file and not that one" and disagree. Rank is a preference **order**, never permission.

Cancellation is cooperative and lands at a page boundary, never mid-write. A run
capped by its evaluation limit finishes as **`partial`**, never `completed` — a
partial sweep must not read as "the library holds nothing else".

### Mandatory exclusions

Enforced server-side regardless of the policy document or what any UI displayed:

legal hold · protection · locked item · outside the storage roots · system path ·
library root · file missing · active playback · incomplete download · in-flight
operation · active job · pending duplicate resolution · inside the grace period ·
ambiguous identity · unmeasured technical data · untrustworthy playback aggregate ·
substantial watch progress (opt-in) · the last surviving copy · a required but
unverified replacement.

An unreadable exclusions block is read as the **strictest** policy, not the loosest.

## 5. Plans and approvals

A plan pins the policy version, the candidate set and each candidate's fingerprint.
There is no update endpoint: after creation a plan changes only through a decision.

| Guard | Why |
|---|---|
| A simulation cannot be planned from | It would turn "what would happen" into "what will" |
| A candidate may be in at most one open plan | Two plans would each believe they may remove it |
| The policy's caps bind the plan | A 200-file cap is not satisfiable by hand-picking 5000 |
| The destination may be softened, never escalated | A request body must not out-destroy the reviewed document |

**Approval is two gates.** `library_cleanup.approve` lets you decide; you must
*also* hold the permission matching the destination. A role that can wave through a
quarantine cannot thereby wave through an irreversible delete. Refusals are audited.

**Plans expire**, including approved ones, because their fingerprints decay while
they wait. Approval is not a licence that outlives the evidence it was granted on.
Expiry is checked inline at approval as well as by a sweep, so a plan is never
approvable in the gap between expiring and being swept.

Self-approval is permitted — most installs have one operator, and a workflow nobody
can complete is worse than one recorded honestly — but it is audited under its own
action so a reviewer can find it.

## 6. Execution

The executor is the only code in the subsystem that touches the filesystem. Per
file, immediately before touching it:

1. the plan is still approved and not expired
2. the path is inside the ops hard roots and is not a system path
3. **nothing protects it now**
4. the item is not locked and has no in-flight job
5. **the fingerprint still matches the one approved**

A failed check **skips** that file with a stated reason. It never guesses, never
"fixes" a mismatch, and never proceeds on a file it cannot vouch for.

Drift detection deliberately calls the *discovery* service, so the hash compared is
produced by the same code that produced the pinned one. Two independent
implementations would drift apart and fail silently in the worst direction.

Every action row is journalled `running` **before** the filesystem call, so a crash
leaves evidence of what was in flight. Removal goes through the platform's own
path-safe seam in `storage` scope; cleanup never unlinks anything itself.

## 7. Quarantine, Trash, restore

**Quarantine** is a move, never a copy or a delete: into a reserved
`.ultratorrent-quarantine` directory inside the file's own storage root, so it never
crosses a filesystem. UUID-prefixed against basename collisions. The row is written
before the move and dropped if the move fails, so nothing ever records a quarantine
that did not happen.

**Restore** puts a file back at its recorded original path, resolved against the
item's own recorded storage root. It refuses to overwrite whatever now occupies that
path unless told to — very often that is the replacement which justified the cleanup
in the first place.

**Trash** is the platform's existing soft-delete, with its own retention sweep.

**Purge** is the one genuinely irreversible step, is separately permissioned, and
re-checks protection immediately beforehand.

A quarantine deadline elapsing marks the item `expired`. It **deletes nothing** — a
deadline means "no longer promised", not "destroy now".

## 8. Scheduling and storage pressure

Due work is selected on a tick rather than held in timers, so a restart replays no
backlog. A policy enabled at noon does not immediately run its nightly schedule.

Storage pressure reads free space through the **storage** boundary and from
`statfs.bavail` — not `bfree`, whose root-reserved blocks are not space anything can
use, and counting them makes a trigger fire late. A policy spanning several
filesystems takes the **tightest** reading.

Everything a schedule fires is a **discovery run**. A stop target that is not above
the trigger can never be reached and is refused. A reading that cannot be taken means
**do not fire**: not knowing is never a reason to start deleting.

A per-policy **circuit breaker** opens after three consecutive failures and pauses
the automatic path. Manual runs are never blocked.

## 9. RBAC

19 permissions under `library_cleanup.*`. Two are **never granted by blanket role
inheritance** and must be assigned deliberately:

- `library_cleanup.permanent_delete`
- `library_cleanup.protection.legal_hold`

`ADMINISTRATOR` receives everything *except* those. `POWER_USER` receives view,
simulate and protection-view only.

## 10. Integration

- **Jobs Center** — runs and executions are mirrored as `library_cleanup.run` and
  `library_cleanup.execution` jobs. The mirror is best-effort observability; a Jobs
  Center problem can never affect what cleanup did. A plan execution is registered as
  **neither retryable nor resumable**: a generic retry would remove files under an
  approval granted for a different moment.
- **Notifications** — four routable `library_cleanup.plan.*` events.
- **Event bus / scheduler / RBAC / Trash / path safety** — all the platform's
  existing machinery. This module introduces no second scheduler, queue, event bus,
  rule evaluator, permission system, job system or file-deletion path.

## 11. API

| Method | Path | Permission |
|---|---|---|
| GET | `/catalog`, `/templates` | `view` |
| POST | `/validate` | `view` |
| GET/POST/PATCH/DELETE | `/policies…` | `policy.*` |
| POST | `/policies/:id/publish` \| `/enable` \| `/disable` | `policy.publish` / `policy.enable` |
| POST | `/policies/:id/simulate` | `simulate` |
| POST | `/policies/:id/run` | `run` |
| GET | `/runs`, `/runs/:id`, `/runs/:id/candidates` | `view` |
| POST | `/runs/:id/cancel` | `cancel` |
| POST | `/runs/:runId/plans` | `run` |
| GET | `/plans`, `/plans/:id`, `/plans/:id/actions` | `view` |
| POST | `/plans/:id/approve` \| `/reject` | `approve` **+ destination permission** |
| POST | `/plans/:id/cancel` | `cancel` |
| POST | `/plans/:id/execute` | `trash` |
| GET | `/quarantine`, `/quarantine/:id` | `view` |
| POST | `/quarantine/:id/restore` | `restore` |
| POST | `/quarantine/:id/purge` | `permanent_delete` |
| GET/POST | `/protections…` | `protection.*` |

## 12. See also

- [LIBRARY_CLEANUP_SECURITY.md](LIBRARY_CLEANUP_SECURITY.md) — threat model
- [LIBRARY_CLEANUP_ARCHITECTURE_REVIEW.md](LIBRARY_CLEANUP_ARCHITECTURE_REVIEW.md) — design review and gap analysis
- [DUPLICATE_CLEANUP_SAFETY.md](DUPLICATE_CLEANUP_SAFETY.md) — the sibling safety model
- [FILE_MANAGER.md](FILE_MANAGER.md) — path boundaries and Trash
