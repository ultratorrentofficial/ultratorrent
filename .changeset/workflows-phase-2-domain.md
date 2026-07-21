---
'@ultratorrent/backend': minor
---

Workflow Builder Phase 2 — domain models, state machines & graph contract. Additive
migration adds 7 tables (workflows, workflow_versions with immutable graph + checksum,
version-pinned workflow_executions with durable resume/heartbeat + Jobs Center jobId
links, workflow_node_executions, workflow_approvals, workflow_variables,
workflow_templates) with the builder's indexes. Domain: three server-enforced state
machines (workflow/execution/node) with tested transition matrices, the typed graph
contract, and a stable layout-insensitive checksum. Not wired into the app yet; the
simple-rule Automation Engine is untouched.
