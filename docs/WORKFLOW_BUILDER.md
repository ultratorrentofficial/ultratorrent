# Visual Workflow Builder

Durable, versioned, visual automation for UltraTorrent. The Workflow Builder lets an
operator wire triggers, conditions, and actions on a canvas into a **workflow** that runs
reliably — surviving restarts, pausing on delays/approvals, and dispatching real work through
the existing Automation Engine.

It **extends** the simple-rule Automation Engine; it does not replace it. Flat trigger→
conditions→actions rules keep working exactly as before. Workflows are the richer, graph-shaped,
durable sibling for multi-step automation.

---

## Concepts

| Concept | What it is |
|---|---|
| **Workflow** | A named automation. Has at most one **mutable draft** and, once published, one **immutable published version**. |
| **Version** (`WorkflowVersion`) | A frozen snapshot of the graph + checksum + required permissions. Publishing freezes the draft; the next edit forks a new draft. Running executions stay pinned to the version they started on. |
| **Graph** | Nodes + edges (`schemaVersion`-gated JSON). Contains **no executable code** — node `type`s reference the registry; expressions are a constrained evaluator, never `eval`. |
| **Node** | A step. Families: **trigger** (0 inputs), **action** (reused Automation actions), **control** (condition/branch/delay/wait/parallel/join/transform/variable/approval/subworkflow/end). |
| **Execution** (`WorkflowExecution`) | One run of a published version. State is **relational** (`workflow_node_executions`), so a restart resumes it from the database. |
| **Approval** (`WorkflowApproval`) | A gate that pauses an execution until a permitted user approves/rejects (or it times out). |

## The node catalog

Trigger and Action nodes are **generated from the Automation catalog**
(`AUTOMATION_TRIGGERS` / `AUTOMATION_ACTIONS`) by `WorkflowNodeRegistry`, so every visual node
references a real, registered trigger/action — the palette can never drift from what the engine
can actually do. Control nodes are built in. Each definition declares typed ports, capabilities
(retry/timeout/simulation), side-effect level, a `destructive` flag, and — for actions — the
underlying permission that is re-checked at run time.

## Lifecycle

```
draft ──validate──▶ ready ──publish──▶ published ⇄ disabled
  ▲                                        │
  └──────────── edit (forks draft) ────────┘         (any state ──▶ archived)
```

- **Validate** (strict, server-side, side-effect-free): schema version, node/edge limits, unique
  ids, exactly-one-trigger-family, port rules, valid edges, **acyclicity**, reachability, bounded
  delays, wait/approval timeout handling, **destructive-node safeguards**, scheduled-trigger
  identity, and — with caller context — permission + module gating and subworkflow self-recursion.
- **Simulate** (dry run): walks the graph with real branch/condition/variable evaluation and
  rendered action inputs, but **no provider is ever called**. A dry run and a real run branch
  identically (shared evaluator + templating).
- **Publish** freezes the draft into an immutable version and records its required permissions.
- **Enable** lets event/scheduled triggers start it.

## Durable execution

The executor (`WorkflowExecutionService`) runs a published version over relational state:

- **Version-pinned & restart-safe.** Progress lives in `workflow_node_executions`; the pure
  planner (`execution-planner.ts`) recomputes the next ready wave purely from the DB. On boot,
  interrupted executions resume (a node caught mid-run is marked `failed` — non-idempotent side
  effects are never blindly re-dispatched).
- **Actions reuse the Automation Engine** via `AutomationEngine.runWorkflowAction(...)` — the
  workflow engine never reimplements action behavior.
- **Retries / timeouts / cancellation** are honored per node; a failed action routes to a wired
  `failure` branch or fails the execution.
- **Durable waits** (single-active-wait model): delays resume on a timer; **wait-for-event**
  resumes off the shared domain bus (or times out); **approvals** pause on a gate; **sub-workflows**
  spawn a version-pinned child that resumes the parent on completion (depth-guarded). Time-based
  resume rides the platform's existing `@nestjs/schedule` (one `@Interval`); event resume rides
  the shared bus. **Resume is idempotent.**
- **Variables** survive a pause (persisted, reloaded on resume).

## Jobs Center integration

Each execution is mirrored as a **`workflow.execution` parent job**, and each long-running action
node as a **`workflow.node` child job**, so runs are visible, cancellable, and retryable through
the Unified Jobs Center. The mirror is **best-effort and non-authoritative** — the execution DB
state is the source of truth; a Jobs-Center hiccup can never break a run.

## RBAC, audit, notifications

- **Permissions:** `workflows.view / create / edit / delete / publish / run / approve`. Every API
  is guarded; every mutation is audited.
- **Runtime least-privilege:** at dispatch time the execution identity must still hold each
  action's permission (defense in depth beyond publish-time validation); identity-less runs fail
  *closed*.
- **Notifications:** `workflow.execution.failed`, `workflow.execution.completed`, and
  `workflow.approval.requested` are routable Notification Center events.
- **Search:** command-palette quick actions (Open Workflows / Approvals) + nav-derived page search.

## Retention

Terminal executions are pruned by a `@Interval` sweep — finished runs after 7 days, **failed runs
kept 30 days** for diagnosis; node executions and approvals cascade. The Jobs Center mirror rows
age out under their own retention.

## API surface (`/api/workflows`)

`catalog` · `validate` · CRUD (`GET`/`POST`/`PATCH`/`DELETE :id`) · `PUT :id/graph` ·
`:id/{publish,enable,disable,archive}` · `:id/simulate` · `:id/run` · `:id/executions` ·
`executions/:executionId` · `executions/:executionId/cancel` · `approvals/pending` ·
`approvals/:approvalId/respond`.

## Non-negotiables honored

No second event bus · no second scheduler · never `eval`/`Function`/shell · published versions are
immutable · running executions stay version-pinned · the simple-rule engine is untouched. See
[WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md) for the threat model and
[WORKFLOW_BUILDER_ARCHITECTURE_REVIEW.md](WORKFLOW_BUILDER_ARCHITECTURE_REVIEW.md) for the design
review.
