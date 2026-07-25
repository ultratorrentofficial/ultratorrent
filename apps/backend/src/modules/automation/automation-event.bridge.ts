import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DomainEventEnvelope } from '@ultratorrent/shared';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { AutomationEngine } from './automation.module';

/**
 * Carries domain events into the automation engine.
 *
 * This is the **generic fan-in** the teardown removed. Automation never stopped
 * working — five producers call `evaluateEvent()` directly — but a new producer
 * could not trigger a rule without someone editing it to add a call. Subscribing
 * restores the property that made the engine worth having: a rule can react to
 * anything the platform publishes, and the publisher does not know automation
 * exists.
 *
 * The direct calls are intentionally left in place. They pass richer, typed
 * context (a whole `NormalizedTorrent`, an RSS rule) that a generic envelope
 * payload does not carry, and removing them would narrow what those rules can
 * match on. Rules keyed on a direct trigger and rules keyed on an event key are
 * disjoint sets, so nothing double-fires.
 */
@Injectable()
export class AutomationEventBridge implements OnModuleInit {
  private readonly logger = new Logger(AutomationEventBridge.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly bus: DomainEventBus,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe('automation-event-bridge', (envelope) =>
      this.onDomainEvent(envelope),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /**
   * Evaluate rules registered against this event key.
   *
   * The envelope's identity fields are flattened alongside the payload so a rule
   * condition can match on `resourceId` or `actorUserId` without the author
   * needing to know each event's payload shape.
   */
  private async onDomainEvent(envelope: DomainEventEnvelope): Promise<void> {
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    const context: Record<string, unknown> = {
      ...payload,
      eventId: envelope.id,
      eventKey: envelope.eventKey,
      occurredAt: envelope.occurredAt,
      actorUserId: envelope.actorUserId ?? null,
      subjectUserId: envelope.subjectUserId ?? null,
      resourceType: envelope.resourceType ?? null,
      resourceId: envelope.resourceId ?? null,
    };

    // Best-effort: a rule failure is logged and must never reach the bus, which
    // would let one bad rule break every other subscriber.
    try {
      await this.moduleRef
        .get(AutomationEngine, { strict: false })
        .evaluateEvent(envelope.eventKey, context);
    } catch (err) {
      this.logger.warn(`Automation on ${envelope.eventKey} failed: ${(err as Error).message}`);
    }
  }
}
