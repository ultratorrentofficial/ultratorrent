---
'@ultratorrent/frontend': minor
---

nav(Phase 7): contextual sub-nav + entity-aware breadcrumbs. A domain-aware
secondary nav bar (`ContextualSubNav`) renders the sibling pages of the active
domain as a horizontal strip so users can move laterally without returning to the
sidebar (and can navigate when the sidebar is hidden on mobile); a nested branch
surfaces its sub-pages as a second row. It reuses the same RBAC/module-filtered
nav data — no new links. Breadcrumbs gain an entity context (`BreadcrumbProvider`
/`useBreadcrumbEntity`) so a detail page can name what it's showing: the media
item detail trail now ends with the item's title instead of a generic "Details".
