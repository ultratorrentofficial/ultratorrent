---
"ultratorrent": minor
---

Add Notification Center — the centralized, provider-driven messaging platform (core module). Modules publish events onto a new in-process event bus; configurable rules decide if/when/how/to-whom notifications are delivered across Email, SMS, Telegram and WhatsApp (provider abstraction allows unlimited future providers). Includes rich media cards (with SMS plain-text fallback), templates, recipients + groups, an async delivery queue with retries/quiet-hours/rate-limiting/dedup, delivery history, provider health, RBAC, audit, WebSocket updates, and a seeded editable default rule catalog. Supersedes the legacy notifications module. Media Server Analytics now publishes its watch/newsletter events.
