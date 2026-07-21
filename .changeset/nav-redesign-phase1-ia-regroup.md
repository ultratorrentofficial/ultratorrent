---
"ultratorrent": minor
---

Navigation redesign — Phase 1: information-architecture re-group.

The sidebar had grown to **10 top-level groups** (57 routes), with Media fragmented across four of them (Media Management, Subtitle Intelligence, Media Server Analytics, and media bits inside "RSS & Acquisition"), a 12-item "Automation" group dominated by the Notification Center, and no home for several surfaces. Full analysis in `docs/NAVIGATION_REDESIGN.md`.

This consolidates the IA into **8 domains** on the way to the approved 7-domain target:

- **Dashboard** (was Overview) · **Downloads** (now also RSS, Indexers, Prowlarr, Release Scoring, Acquisition Intelligence, Engines) · **Media** (Media Manager + **Subtitles** nested) · **Automation** (Automation Rules + **Notifications** nested) · **Files** · **Monitoring** (**Media Server Analytics** nested) · **Administration** · **Account**.

Nothing is removed or hidden — every one of the 57 routes keeps a home. Sub-modules with many pages (Subtitles, Notifications, Media Server Analytics) nest under a parent whose own route is that module's dashboard, so the collapsed rail is dramatically shorter while every page stays one expand away. RBAC + module pruning, persistence, breadcrumbs and the Ctrl/Cmd-K palette are unchanged and continue to work over the new structure.

Data-only change to `navigation.ts` plus updated `navigation.test.ts`, `Breadcrumbs.test.ts`, en-US/es-PR `nav.json`, and `NAVIGATION.md`. 113 frontend tests green, typecheck + build clean.

Later phases (registry-driven rail, pinned/favorites/recent, entity command palette, badges, module landing hubs, contextual nav, mobile redesign) are tracked in `docs/NAVIGATION_REDESIGN.md`.
