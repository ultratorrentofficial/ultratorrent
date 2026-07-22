---
"ultratorrent": minor
---

Workflow Builder Phase 10 — security, performance, docs & regression (feature complete). Retention: a @Interval sweep prunes terminal executions (finished after 7 days, failed kept 30 for diagnosis; node executions + approvals cascade). Performance rests on the Phase-2 composite indexes ([status,resumeAt]/[status,expiresAt]/[heartbeatAt,status] drive the resume tick; [workflowExecutionId,nodeId] drives the planner reload) plus the graph-size ceiling and validate-time DoS limits. Docs: WORKFLOW_BUILDER.md (flagship) + WORKFLOW_SECURITY.md (10-threat model); SECURITY.md + README docs table updated. Full regression: backend 1607 tests / 149 suites green, frontend 258 tests / 30 suites green, BE+FE tsc/build clean, Nest boot verified — Automation Engine, Jobs Center, and all prior subsystems unchanged. Closes the 10-phase Visual Workflow Builder.
