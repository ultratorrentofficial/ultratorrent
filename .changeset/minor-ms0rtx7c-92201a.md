---
"ultratorrent": minor
---

Rebuild the platform domain-event bus (notifications rebuild, Phase 1). Restores shared pub/sub as DomainEventBus on the domain.event channel - named for what it is, not for one subscriber. Adds guarantees the previous bus never had: a catalogue that refuses unregistered keys, payload validation at the producer, idempotency by event id and by fact within a dedupe window, best-effort publishing that never throws, and per-subscriber failure isolation. Restores workflow event-waits (which silently expired) and generic automation fan-in.
