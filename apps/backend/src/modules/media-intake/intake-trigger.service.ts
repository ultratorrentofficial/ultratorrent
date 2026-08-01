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

    /*
     * `contentPath` FIRST, and this order is the whole point.
     *
     * `savePath` is the directory a torrent was saved INTO, and it is shared:
     * ten episodes of one show report the same one, and a movie feed's entire
     * catalogue reports the directory holding 3,000 other films. Importing from
     * it means importing everything in it, not the release that just finished.
     * `contentPath` is the torrent's own file or folder.
     *
     * Falling back to `savePath` keeps an engine that cannot report the item
     * working exactly as before rather than refusing outright.
     */
    const sourcePath = (event.payload?.contentPath as string | undefined)
      || (event.payload?.savePath as string | undefined);
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
   * The rule that asked for this torrent, by either route it can have arrived by.
   *
   * An RSS feed grab is traced through `rss_acquisitions`. A **missing-episode**
   * grab writes no such row — it goes out through MissingEpisodeSearchService, an
   * entirely separate path — so it carries its own trace on the wanted episode:
   * the hash it was handed, and the rule that decided where it was sent.
   *
   * `intakeRuleId` is read rather than re-derived. The resolver already answered
   * "which rule governs this show" when it chose the download directory; asking
   * again here could produce a different answer (a rule renamed in between, a link
   * added since), and a file staged on one answer but refused on the other is
   * stranded with nothing to import it. A null means the grab went straight to the
   * library, which is the legacy path and correctly ignored.
   */
  private async ruleFor(hash: string) {
    const acquisition = await this.prisma.rssAcquisition.findFirst({
      where: { torrentHash: hash },
      orderBy: { createdAt: 'desc' },
      select: { rssRuleId: true },
    });
    const ruleId = acquisition?.rssRuleId ?? (await this.missingEpisodeRuleId(hash));
    if (!ruleId) return null;
    return this.prisma.rssRule.findUnique({
      where: { id: ruleId },
      select: { id: true, name: true, importMode: true, storageProfileId: true },
    });
  }

  /** The rule a missing-episode grab was staged under, if it was one. */
  private async missingEpisodeRuleId(hash: string): Promise<string | null> {
    const wanted = await this.prisma.wantedEpisode.findFirst({
      where: { torrentHash: hash },
      orderBy: { grabbedAt: 'desc' },
      select: { intakeRuleId: true },
    });
    return wanted?.intakeRuleId ?? null;
  }
}
