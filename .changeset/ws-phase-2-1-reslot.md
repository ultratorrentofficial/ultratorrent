---
'@ultratorrent/frontend': minor
---

nav(Workspace Phase 2.1): re-slot the navigation registry into the approved 9
Workspaces — Dashboard, Downloads, Media, Automation, Analytics, Files,
Infrastructure, Administration, System. Engines/Indexers/Prowlarr move to
Infrastructure (D-1); Monitoring becomes Analytics; Administration splits into
Administration (Users, Audit) and System (Modules, Settings); Account leaves the
rail for the top-bar user menu (D-4). Pure data change over the existing
composeNavGroups registry — no routes removed, all URLs unchanged. The user menu
that hosts Account arrives in Phase 2.2.
