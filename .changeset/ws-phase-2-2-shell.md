---
'@ultratorrent/frontend': minor
---

nav(Workspace Phase 2.2): the workspace shell. A fixed global `WorkspaceRail`
lists only the nine workspaces; selecting one (click or Ctrl+1–9, with
last-workspace persistence) replaces the sidebar with that workspace's own
contextual nav. `resolveActiveWorkspaceId` resolves the active workspace from the
route (falling back to the last-selected for workspace-less routes like /account);
`workspaceLanding` sends each workspace to its primary page. The always-present
rail supersedes the old collapse-to-icon sidebar; a hide-sidebar toggle reclaims
content width. Account stays reachable via the existing top-bar user menu. Mobile
keeps the bottom workspace switcher + drawer (now scoped to the active workspace).
Nothing removed or hidden.
