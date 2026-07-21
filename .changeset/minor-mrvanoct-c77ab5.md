---
"ultratorrent": minor
---

Workflow Builder Phase 5 — simulation / dry-run. A no-side-effect executor walks the validated, acyclic graph in topological order: conditions and branches are evaluated with the SAME operator semantics as the Automation Engine (a shared constrained evaluator — eq/neq strict, numeric comparators coerce, contains=includes, matches=case-insensitive regex; never eval/Function), variables are set, and action inputs are rendered ({{path}} templating) — but no provider is ever called. Actions/delays/waits/approvals are recorded as 'would happen' (approvals auto-approved with a warning; joins wait for all inputs). New POST /api/workflows/:id/simulate (workflows.run, audited, accepts a graph/trigger/vars override). Editor gains a Simulate button + trace panel showing the ordered per-node decisions, rendered action inputs, and which actions would run. 11 new backend tests; full green gate.
