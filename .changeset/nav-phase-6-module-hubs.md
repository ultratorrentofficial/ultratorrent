---
'@ultratorrent/frontend': minor
---

nav(Phase 6): module landing hubs. Each navigation domain gets an at-a-glance
landing page at `/hub/:domainId`, built from the same nav data the sidebar uses
(no drift). A reusable `ModuleHub` renders one tile per navigable page — with the
page's sub-pages as chips — while pure action launchers (e.g. Search) are omitted.
Sidebar group headers and the collapsed-rail domain icons now link to the hub;
the chevron still toggles the group. Hubs are RBAC-aware (the group only contains
items the user can see) and redirect home for unknown/forbidden domains.
Breadcrumbs resolve `/hub/:domainId` to the domain crumb.
