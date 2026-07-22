# Workflow Builder — Threat Model & Security

The Visual Workflow Builder lets users author automations that perform real, sometimes
destructive, actions against the library and torrent engines. This document enumerates the
threats and the controls that mitigate them. It complements [SECURITY.md](SECURITY.md).

## Trust boundaries

- **Authoring** (draft/validate/publish): a user with `workflows.*` builds a graph. Graphs are
  data, never code.
- **Execution**: a durable run dispatches actions as an **execution identity** (the initiating
  user for manual/event runs; an explicit service identity for scheduled runs).
- **Reuse**: actions run through the existing Automation action executors — the workflow engine
  adds no new action capability, so an action can do nothing a rule couldn't already do.

## Threats & controls

| # | Threat | Control |
|---|---|---|
| T1 | **Arbitrary code execution** via graph content (expressions, templates). | No `eval` / `Function` / template-literal execution / shell — ever. Conditions use a fixed 8-operator evaluator over resolved field paths; the only interpolation is `{{path}}` substitution. Node `type`s are validated against the registry. |
| T2 | **Privilege escalation** — author a workflow that runs actions the runner isn't allowed to. | Two gates: (a) **publish-time** validation checks the publisher holds every action's permission; (b) **runtime** least-privilege re-check — the execution identity must still hold each action's `ACTION_PERMISSION` at dispatch, snapshotted per run (SUPER_ADMIN short-circuit mirrors the auth guard). Identity unresolved → fail **closed**. |
| T3 | **Destructive actions** (delete/move/rename data) fired accidentally or maliciously. | Destructive node types are flagged in the registry and **rejected at validation** unless the node carries an explicit `acknowledgeDestructive: true` safeguard. High-risk steps can be gated behind an **approval** node. |
| T4 | **Tampering with a running automation** — change a workflow mid-run to alter behavior. | Published versions are **immutable**; a running execution is **pinned** to the exact `WorkflowVersion` (and checksum) it started on. Editing forks a new draft; it never mutates the running version. |
| T5 | **Denial of service / runaway graphs** — huge graphs, infinite loops, unbounded delays, deep recursion, fan-out storms. | Strict limits at validate time (max nodes/edges, max parallel branches, max delay/wait seconds); graphs must be **acyclic**; the executor bounds iterations; sub-workflows are **depth-guarded** and cannot invoke themselves; a 512 KB graph-size ceiling on save. |
| T6 | **SSRF / outbound abuse** via webhook actions. | Webhook actions are dispatched through the **existing** Automation Engine, which already SSRF-guards outbound URLs (blocks internal/metadata addresses). No new outbound path is introduced. |
| T7 | **Secret leakage** in stored graphs, execution state, or job mirrors. | Workflow variables mark secrets (`valueType: secret`, encrypted). Input/output summaries persisted on executions and the Jobs Center mirror are small and sanitized; no secrets or large blobs. |
| T8 | **Stuck / orphaned executions** consuming resources or hiding failures. | Durable resume is idempotent; a boot reconcile fails interrupted nodes rather than double-dispatching; waits carry `expiresAt` timeouts; approvals expire; the Jobs Center parks waiting jobs out of the RUNNING states so boot-reconcile won't mislabel them; terminal executions are pruned by retention. |
| T9 | **Unauthorized approvals.** | Approval endpoints require `workflows.approve`; if a gate declares a specific `requiredPermission`, the responder must also hold it (defense in depth). Decisions are audited. |
| T10 | **Audit gaps.** | Every state-changing operation (create/update/save/publish/enable/disable/archive/delete, execution start/cancel/terminal, approval decisions) writes an `AuditLog` entry with the actor. |

## Data handled

Graphs (automation logic — not secrets), execution state (relational, sanitized summaries),
workflow variables (secrets encrypted at rest), and approval records. No credentials are stored in
graphs.

## Residual risks / future hardening

- **Runtime permission enforcement requires an execution identity.** Event/system-triggered runs
  without a resolvable identity currently rely on publish-time validation; binding an explicit
  least-privilege service identity to every scheduled/event workflow is a follow-up.
- **Per-node output size** is summarized but not hard-capped beyond the graph ceiling; large action
  results are truncated in summaries, not rejected.
