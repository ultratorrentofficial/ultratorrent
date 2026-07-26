---
"ultratorrent": patch
---

Fix React #426 when opening the notification pages: lazy routes had no Suspense boundary; AppShell's Outlet is now guarded, covering every lazy page
