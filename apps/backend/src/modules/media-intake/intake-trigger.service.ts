import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DOMAIN_EVENTS, LEGACY_RSS_IMPORT_MODE } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { MediaIntakeService } from './media-intake.service';
import { IntakePipelineService } from './intake-pipeline.service';
import { StorageProfileService } from './storage-profile.service';

/**
 * What starts an intake.
 *
 * Subscribes to `torrent.completed`, which the torrent sync loop already
 * edge-fires exactly once when progress crosses 100%. Reusing that edge rather
 * than adding a second poller matters: two independent observers of the same
 * condition drift, and the one that drifts is the one that imports twice.
 *
 * **This is the gate that keeps existing installs untouched.** A completed
 * torrent is only taken up if it can be traced back to an RSS rule whose
 * `importMode` is `managed_intake`. Every rule that existed before this feature
 * reads `legacy_direct`, so on an upgraded install this handler looks up one
 * row, finds nothing managed, and returns — for every torrent, forever, until
 * somebody deliberately opts a rule in.
 *
 * A torrent added by hand is not traceable to a rule at all and is therefore
 * never intercepted, which is the correct answer: the operator chose where it
 * should go when they added it.
 */
@Injectable()
export class IntakeTriggerService implements OnModuleInit {
  private readonly logger = new Logger(IntakeTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly intake: MediaIntakeService,
    private readonly profiles: StorageProfileService,
    private readonly pipeline: IntakePipelineService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(DOMAIN_EVENTS.TORRENT_COMPLETED, (event) => {
      // Fire and forget: the sync loop must not wait on an import, and a
      // failure here must never stall torrent bookkeeping.
      void this.onCompleted(event as { resourceId?: string; payload?: Record<string, unknown> })
        .catch((err) => this.logger.warn(`Intake trigger failed: ${(err as Error).message}`));
    });
  }

  private async onCompleted(event: { resourceId?: string; payload?: Record<string, unknown> }): Promise<void> {
    const hash = event.resourceId ?? (event.payload?.hash as string | undefined);
    if (!hash) return;

    const rule = await this.ruleFor(hash);
    // The whole backward-compatibility guarantee, in one condition.
    if (!rule || rule.importMode === LEGACY_RSS_IMPORT_MODE) return;

    const profile = rule.storageProfileId
      ? await this.profiles.get(rule.storageProfileId).catch(() => null)
      : await this.profiles.defaultProfile();
    if (!profile) {
      // Managed but unconfigured. Say so once per torrent rather than silently
      // doing nothing — a rule marked managed that never imports is exactly the
      // "enabled but inert" failure this project has already been bitten by.
      this.logger.warn(
        `Rule "${rule.name}" is set to managed intake but no storage profile is configured; `
          + `torrent ${hash} was left alone.`,
      );
      return;
    }

    const sourcePath = (event.payload?.savePath as string | undefined)
      ?? (event.payload?.contentPath as string | undefined);
    if (!sourcePath) {
      this.logger.warn(`Torrent ${hash} completed with no path in the event; cannot stage it.`);
      return;
    }

    const job = await this.intake.enqueue({
      profileId: profile.id,
      sourcePath,
      torrentHash: hash,
      engineId: (event.payload?.engineId as string | undefined) ?? null,
    });
    this.logger.log(`Queued ${hash} for managed intake via profile "${profile.name}".`);

    /*
     * Enqueueing is not the same as running. Without this the engine sat
     * complete and idle — every intake stuck at `queued` with nothing to move
     * it, which looks exactly like a broken pipeline and was in fact a missing
     * call. Detached, because the sync loop that published this event must not
     * wait on a file copy.
     */
    void this.pipeline
      .advance(job.id)
      .catch((err) => this.logger.warn(`Pipeline failed for ${job.id}: ${(err as Error).message}`));
  }

  /**
   * The rule that produced this torrent, if any.
   *
   * Traced through `rss_acquisitions`, which already records hash → rule for
   * every grab. A torrent with no acquisition row was not produced by a rule —
   * a manual add, or one from before the feed existed — and is left alone.
   */
  private async ruleFor(hash: string) {
    const acquisition = await this.prisma.rssAcquisition.findFirst({
      where: { torrentHash: hash },
      orderBy: { createdAt: 'desc' },
      select: { rssRuleId: true },
    });
    if (!acquisition?.rssRuleId) return null;
    return this.prisma.rssRule.findUnique({
      where: { id: acquisition.rssRuleId },
      select: { id: true, name: true, importMode: true, storageProfileId: true },
    });
  }
}
