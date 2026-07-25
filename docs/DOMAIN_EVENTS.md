# Domain Events

The platform's shared publish/subscribe mechanism. One bus, `domain.event`,
carrying facts about what happened — with no opinion about who cares.

- [Why it is named this way](#why-it-is-named-this-way)
- [The envelope](#the-envelope)
- [Guarantees](#guarantees)
- [The catalogue](#the-catalogue)
- [Subscribers](#subscribers)
- [Edge detection](#edge-detection)
- [Adding an event](#adding-an-event)

---

## Why it is named this way

Its predecessor was called `NOTIFICATION_BUS_CHANNEL`. That name made one
subscriber look like the bus's purpose, and when notifications were removed in
July 2026 the bus went with them — silently taking **automation event-triggering**
and **workflow event-waits** along. Nothing in the UI or the logs said why; a
workflow waiting on an event simply expired.

The name is not cosmetic. A domain event says *a torrent finished*. It does not
say *tell someone a torrent finished*.

---

## The envelope

```ts
interface DomainEventEnvelope<TPayload = unknown> {
  id: string;            // unique per occurrence — the idempotency key
  eventKey: string;      // `namespace.entity_verb`
  occurredAt: string;    // ISO 8601
  actorUserId?: string;  // who caused it, when a local user did
  subjectUserId?: string;// who it is ABOUT, when that differs
  resourceType?: string; // `torrent`, `workflow_execution`, `storage_root`, …
  resourceId?: string;
  payload: TPayload;
  correlationId?: string;
  causationId?: string;
}
```

The identity fields are hoisted **out** of the payload deliberately. A subscriber
routing to "the affected user" or "the owner of this resource" must not have to
know each event's payload shape to find them.

---

## Guarantees

| Property | What it means | Why |
|---|---|---|
| **Catalogued** | An unregistered key is refused | Stops the vocabulary drifting into ad-hoc strings nothing can subscribe to with confidence |
| **Validated** | A payload missing a field consumers need is refused at the producer | Otherwise it is discovered later as a blank line in someone's inbox |
| **Idempotent** | By event id, *and* by fact within a per-event dedupe window | Pollers re-observe the same state every tick; without a window they republish forever |
| **Best-effort** | `publish()` returns a typed result and never throws | A torrent finished whether or not anything was told |
| **Isolated** | Each subscriber is wrapped, sync and async | One throwing subscriber must not silence the other two |

The old bus had **none** of these. It was a raw `emit(CHANNEL, {event, payload,
at})`. This is not a restoration; it is the thing that should have been there.

### Dedupe: id versus fact

Two different problems:

- **By id** — the same envelope delivered twice (a redelivery) publishes once.
- **By fact** — `eventKey:resourceType:resourceId` inside
  `deduplicationWindowSeconds`. The torrent sync loop sees the same error state
  every 2 seconds and the session poller every 15; a polled event without a
  window is a notification every tick.

A catalogue test asserts every polled event declares a window.

---

## The catalogue

`modules/domain-events/domain-event-catalog.ts`. Each entry declares its
`requiredFields` — only what a *consumer* genuinely needs to route the event and
render a sentence about it. Listing every field a producer happens to send would
make the contract brittle for no benefit.

19 events across playback, torrents, storage, workflows, providers, security and
users. **An event appears only when a real producer publishes it.** An event that
cannot fire is worse than an absent one: it appears in every catalogue and
preference screen, and quietly never arrives.

> `torrent.stalled` is **deliberately absent**. There is no stalled state — it
> would be a heuristic (downloading, zero peers or zero B/s, for N minutes), and
> a heuristic with the wrong threshold is a notification people mute, taking the
> real ones with them. Define it before adding it.

---

## Subscribers

Three, all reading the same bus:

1. **`NotificationDispatcher`** — resolves recipients, applies personal
   preferences, creates owned in-app notifications and queues external deliveries.
2. **`AutomationEventBridge`** — the generic fan-in. Rules can react to anything
   published, without the publisher knowing automation exists. The five *direct*
   `evaluateEvent()` calls remain, because they pass richer typed context (a whole
   `NormalizedTorrent`) than an envelope carries.
3. **`WorkflowEventBridge`** — resumes executions parked in `waiting_for_event`.
   `WorkflowResumeService` still enforces the `expiresAt` deadline, and `resume()`
   is idempotent, so the two race harmlessly.

Both bridges resolve their engine lazily through `ModuleRef`. The automation one
must: bridge and module import each other, so Nest reads the constructor before
the class is defined — a **bootstrap-only** failure that `tsc` and the unit suite
both pass straight through.

---

## Edge detection

Three producers poll: the torrent sync loop (2s), the provider health check (60s)
and the storage watcher (5m). Each must publish **once, when the state changes**.

`EdgeDetector` is shared rather than reimplemented per module — the subtle part is
the same everywhere, and getting it slightly different in three places is how one
ends up notifying hourly.

**The first observation never reports an edge.** Otherwise a restart announces
every torrent already errored and every engine already down as though it had just
happened: a flood about things that failed while nobody was watching,
indistinguishable to the reader from things failing now. The bus's dedupe window
is complementary — it bounds the damage if a detector is reset.

---

## Adding an event

1. Add the key to `DOMAIN_EVENTS` in `packages/shared/src/domain-events.ts`.
2. Add a definition (with `requiredFields`, and a dedupe window **if it is
   polled**) to `domain-event-catalog.ts`.
3. Publish it from real code. `publish()` never throws, so a producer needs no
   error handling.
4. If it should reach people, add it to the notification catalogue with a
   recipient strategy and a presentation builder — see
   [NOTIFICATION_ENGINE.md](NOTIFICATION_ENGINE.md).

Do **not** add a key without a producer.
