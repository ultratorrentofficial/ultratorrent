import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import {
  DOMAIN_EVENT_CHANNEL,
  domainEventDedupeKey,
  validateDomainEvent,
  type DomainEventEnvelope,
} from '@ultratorrent/shared';
import { getDomainEventDefinition } from './domain-event-catalog';

/** What a publisher supplies; the bus fills in `id` and `occurredAt`. */
export type PublishInput<TPayload = unknown> = Omit<
  DomainEventEnvelope<TPayload>,
  'id' | 'occurredAt'
> & { id?: string; occurredAt?: string };

/** Outcome of a publish, so callers and tests can tell *why* nothing happened. */
export interface PublishResult {
  published: boolean;
  eventId?: string;
  /** `unregistered` · `invalid_payload` · `duplicate` */
  reason?: string;
  problems?: string[];
}

/** How long a delivered event id is remembered for idempotency. */
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
/** Hard cap so a busy install cannot grow the set without bound. */
const SEEN_MAX = 10_000;

/**
 * The platform's domain-event bus.
 *
 * A thin, opinionated layer over the `EventEmitter2` instance the app already
 * registers. The transport was never the hard part; the guarantees are:
 *
 * - **Catalogued.** An unregistered key is refused, so the vocabulary cannot
 *   drift into ad-hoc strings nothing can subscribe to.
 * - **Validated.** A payload missing a field consumers need is refused at the
 *   producer, not discovered later as a blank line in someone's inbox.
 * - **Idempotent.** The same event id, or the same fact inside a dedupe window,
 *   publishes once. Pollers reconcile the same state every tick and would
 *   otherwise republish forever.
 * - **Best-effort.** Publishing never throws at the caller. A torrent finished
 *   whether or not anything was told.
 * - **Isolated.** One subscriber throwing must not stop the next from running —
 *   see `subscribe()`.
 *
 * Deliberately in-process. A queue-backed bus is a different system with
 * different failure modes, and nothing here needs one yet.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);

  /** event id → expiry. Idempotency across redelivery. */
  private readonly seenIds = new Map<string, number>();
  /** dedupe identity → expiry. Suppresses a repeated *fact*, not a repeated id. */
  private readonly seenFacts = new Map<string, number>();

  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Publish one domain event.
   *
   * Returns a result rather than throwing. Producers call this from inside the
   * operation that caused the event, and an unpublishable event must never fail
   * that operation.
   */
  publish<TPayload>(input: PublishInput<TPayload>): PublishResult {
    const envelope: DomainEventEnvelope<TPayload> = {
      ...input,
      id: input.id ?? randomUUID(),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };

    const definition = getDomainEventDefinition(envelope.eventKey);
    const problems = validateDomainEvent(envelope as DomainEventEnvelope, definition);
    if (problems.length) {
      // Warn, never throw: a malformed event is a bug worth seeing in the log,
      // not a reason to fail a download.
      this.logger.warn(`Refused "${envelope.eventKey}": ${problems.join('; ')}`);
      return {
        published: false,
        reason: definition ? 'invalid_payload' : 'unregistered',
        problems,
      };
    }

    const now = Date.now();
    this.prune(now);

    if (this.seenIds.has(envelope.id)) {
      return { published: false, eventId: envelope.id, reason: 'duplicate' };
    }

    const windowSec = definition!.deduplicationWindowSeconds ?? 0;
    let factKey: string | null = null;
    if (windowSec > 0) {
      factKey = domainEventDedupeKey(envelope.eventKey, envelope.resourceType, envelope.resourceId);
      if (this.seenFacts.has(factKey)) {
        return { published: false, eventId: envelope.id, reason: 'duplicate' };
      }
    }

    this.seenIds.set(envelope.id, now + SEEN_TTL_MS);
    if (factKey) this.seenFacts.set(factKey, now + windowSec * 1000);

    // Emitted synchronously; `subscribe()` wraps each handler so a slow or
    // throwing subscriber cannot reach back into this call.
    this.emitter.emit(DOMAIN_EVENT_CHANNEL, envelope);
    return { published: true, eventId: envelope.id };
  }

  /**
   * Subscribe to every domain event.
   *
   * The handler is wrapped so a rejection or throw is logged and contained: with
   * three independent readers (notifications, automation, workflow waits), one
   * failing must not silence the others. Returns an unsubscribe function.
   */
  subscribe(
    name: string,
    handler: (envelope: DomainEventEnvelope) => void | Promise<void>,
  ): () => void {
    const wrapped = (envelope: DomainEventEnvelope) => {
      try {
        const result = handler(envelope);
        if (result instanceof Promise) {
          result.catch((err) =>
            this.logger.error(`Subscriber "${name}" failed on ${envelope.eventKey}: ${(err as Error).message}`),
          );
        }
      } catch (err) {
        this.logger.error(`Subscriber "${name}" threw on ${envelope.eventKey}: ${(err as Error).message}`);
      }
    };
    this.emitter.on(DOMAIN_EVENT_CHANNEL, wrapped);
    return () => this.emitter.off(DOMAIN_EVENT_CHANNEL, wrapped);
  }

  /** Drop expired idempotency entries, and trim if a burst outran the TTL. */
  private prune(now: number): void {
    for (const [key, expiry] of this.seenIds) {
      if (expiry <= now) this.seenIds.delete(key);
    }
    for (const [key, expiry] of this.seenFacts) {
      if (expiry <= now) this.seenFacts.delete(key);
    }
    if (this.seenIds.size > SEEN_MAX) {
      // Insertion-ordered, so this drops the oldest.
      const excess = this.seenIds.size - SEEN_MAX;
      let dropped = 0;
      for (const key of this.seenIds.keys()) {
        this.seenIds.delete(key);
        if (++dropped >= excess) break;
      }
    }
  }
}
