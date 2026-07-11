---
"ultratorrent": patch
---

The IMDb search indexes are now built in the background while the app runs, instead of during database migration. Building them on a fully imported catalogue takes minutes, and doing that inside a migration blocked startup — worse, if the build was interrupted the app would refuse to boot at all. They now build concurrently and idempotently after startup, with no downtime, and a build interrupted by a restart is detected and retried.
