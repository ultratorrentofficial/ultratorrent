---
"ultratorrent": minor
---

Workflow Builder Phase 4a — backend WorkflowsModule & API. Adds workflows.* permissions (view/create/edit/delete/publish/run/approve; admin auto-inherits, POWER_USER gets view+run). New WorkflowService (CRUD, single-mutable-draft versioning, publish freezes the draft into an immutable published version and forks a fresh draft on next edit, graph validation on save/publish, stateless /validate, node catalog) and RBAC-guarded WorkflowsController (/api/workflows: catalog, validate, list, create, get, update, PUT graph, publish, enable, disable, archive, delete) with DTO validation, pagination caps, audit on every mutation, and a 512KB graph-size ceiling. Registry wired into a real module; boot-verified.
