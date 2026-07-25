---
"ultratorrent": minor
---

Remove the notification engine entirely, ahead of a rebuild from scratch. BREAKING: both the legacy Notification Center and the personal engine are gone, along with the domain-event bus they consumed - which also removes automation and workflow domain-event triggering, since both subscribed to that same bus. 23 database tables are dropped, destroying the encrypted SMTP transport and Telegram bot token; both hosts were backed up first to notification-teardown-backups/.
