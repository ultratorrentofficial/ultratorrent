---
"ultratorrent": minor
---

Notification Center Phase 2: wire the event bus into Downloads, RSS, Media Manager, System and Auth so the seeded rules actually fire; add an Automation 'send_notification' action that dispatches through the Notification Center; and add the remaining UI pages (Templates with live preview, Recipient Groups, Queue Monitor, Provider Health, Preferences, Settings) with routes, nav and en-US/es-PR i18n. Adds an edge-fired system resource monitor (disk/cpu/memory). Also fixes a pre-existing media-processing test mock.
