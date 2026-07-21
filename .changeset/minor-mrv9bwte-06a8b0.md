---
"ultratorrent": minor
---

Workflow Builder Phase 3 — node registry & strict graph validation. Trigger/Action node definitions are generated from the Automation catalog (AUTOMATION_TRIGGERS/ACTIONS) so visual nodes always reference real registered triggers/actions; built-in control nodes (condition/branch/delay/wait/parallel/join/transform/variable/approval/subworkflow/end + manual/scheduled/webhook triggers) are declared in the registry. A strict, side-effect-free validator enforces schema version, node/edge limits, unique ids, known types, exactly-one-trigger-family, trigger/end port rules, valid edge endpoints/ports, acyclicity, reachability, bounded delays, wait/approval timeout handling, destructive-node safeguards, scheduled-trigger identity, and (when context supplied) permission + module gating and subworkflow self-recursion. 39 domain tests.
