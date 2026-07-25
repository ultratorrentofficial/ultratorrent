import { Global, Module } from '@nestjs/common';
import { DomainEventBus } from './domain-event-bus.service';

/**
 * The platform's shared domain-event mechanism.
 *
 * `@Global` because publishing is a cross-cutting concern: nearly every module
 * produces events, and requiring each to import this module would add an edge to
 * the dependency graph for something that is infrastructure, not a dependency.
 * It carries no state a consumer could couple to — only `publish` and
 * `subscribe`.
 *
 * There is exactly **one** bus. The previous design had a single channel too, but
 * named it after one of its subscribers (`NOTIFICATION_BUS_CHANNEL`), which is
 * why deleting notifications also deleted automation and workflow triggering.
 * A second bus would reintroduce the same coupling in a new shape.
 */
@Global()
@Module({
  providers: [DomainEventBus],
  exports: [DomainEventBus],
})
export class DomainEventsModule {}
