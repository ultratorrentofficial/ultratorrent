import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { EdgeDetector } from '../domain-events/edge-detector';
import { EngineRegistryService } from './engine-registry.service';

/**
 * Watches torrent engines and publishes when one goes offline or comes back.
 *
 * Edge-fired through the shared {@link EdgeDetector}: an engine that is down
 * stays down, and re-announcing it every minute produces a channel people mute.
 * The very first observation is deliberately silent, so a restart does not
 * announce every engine that was already offline as if it had just failed.
 *
 * Only enabled engines are watched. A disabled one is offline on purpose, and
 * saying so would be noise about a decision the operator already made.
 */
@Injectable()
export class ProviderWatchService {
  private readonly logger = new Logger(ProviderWatchService.name);
  private readonly offline = new EdgeDetector();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly bus: DomainEventBus,
  ) {}

  @Interval('provider_watch', 60_000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.check();
    } catch (err) {
      this.logger.warn(`Provider check failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Check every enabled engine. Exposed for tests. */
  async check(): Promise<void> {
    const engines = await this.prisma.torrentEngine.findMany({
      where: { isEnabled: true },
      select: { id: true, name: true, kind: true },
    });
    // A removed or disabled engine should not keep state; its reappearance is new.
    this.offline.retainOnly(engines.map((e) => e.id));

    for (const engine of engines) {
      let online: boolean;
      let error: string | null = null;
      try {
        const health = await this.registry.resolve(engine.id).then((p) => p.healthCheck());
        online = health.online;
        error = health.error ?? null;
      } catch (err) {
        // An unreachable engine throws rather than returning `online: false`,
        // and both mean the same thing to an operator.
        online = false;
        error = (err as Error).message;
      }

      const edge = this.offline.observe(engine.id, !online);
      if (edge === 'rising') {
        this.bus.publish({
          eventKey: DOMAIN_EVENTS.PROVIDER_OFFLINE,
          resourceType: 'torrent_engine',
          resourceId: engine.id,
          payload: { providerName: engine.name, kind: engine.kind, reason: error },
        });
      } else if (edge === 'falling') {
        this.bus.publish({
          eventKey: DOMAIN_EVENTS.PROVIDER_RECOVERED,
          resourceType: 'torrent_engine',
          resourceId: engine.id,
          payload: { providerName: engine.name, kind: engine.kind },
        });
      }
    }
  }
}
