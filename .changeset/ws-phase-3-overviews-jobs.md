---
'@ultratorrent/backend': minor
'@ultratorrent/frontend': minor
---

nav(Workspace Phase 3): workspace Overviews, Quick Actions, and a jobs aggregator.
New backend `GET /api/jobs` (`JobsService`/`JobsController`) — a read-only,
RBAC-scoped aggregator over the five persisted job tables that normalizes each
into a uniform JobSummary (a caller only sees subsystems whose view permission
they hold; super-admin sees all). `/hub/:workspaceId` now renders a
`WorkspaceOverview`: the workspace's Quick Actions (reusing the gated palette
actions), its pages (the ModuleHub tile grid), and a live Active-Jobs widget
(`useWorkspaceJobs`, polling, scoped per workspace; System sees all). Nothing
removed.
