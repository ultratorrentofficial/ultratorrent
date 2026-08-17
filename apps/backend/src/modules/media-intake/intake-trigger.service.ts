import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
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
 * A torrent added by hand traces to no rule at all, so rule provenance can never
 * speak for it. It is intercepted only when the operator said so **at add time**
 * by choosing "managed intake" in the Add Torrent dialog, which writes an
 * `IntakeIntent` against the hash. That is the third provenance source and the
 * only one that does not consult `importMode` — an explicit per-torrent choice
 * is itself the opt-in the gate above is asking for. Add a torrent the ordinary
 * way and nothing here touches it, exactly as before.
 */
@Injectable()
export class IntakeTriggerService implements OnModuleInit {
  private readonly logger = new Logger(IntakeTriggerService.name);
  /** Guards the sweep against overlapping ticks while an engine is slow. */
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
    private readonly intake: MediaIntakeService,
    private readonly profiles: StorageProfileService,
    private readonly pipeline: IntakePipelineService,
    /** Lazy engine access for the sweeper — see `sweepIntents`. */
    private readonly moduleRef?: ModuleRef,
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

    /*
     * A manual intent is checked FIRST and answers on its own.
     *
     * It is a per-torrent decision an operator made in the add dialog, so it
     * outranks any rule that happens to also match, and it deliberately skips
     * the `importMode` gate below: that gate exists to protect installs that
     * never opted in, and choosing "managed intake" IS opting in. Reading it
     * through the rule path would make an explicit choice depend on the setting
     * of a rule the operator never touched.
     */
    const intent = await this.intentFor(hash, event.payload?.engineId as string | undefined);
    if (intent) {
      const profile = await this.profiles.get(intent.profileId).catch(() => null);
      if (!profile) {
        this.logger.warn(
          `Torrent ${hash} was added for managed intake but its storage profile is gone; `
            + 'it was left alone.',
        );
        return;
      }
      await this.stage(hash, profile, this.sourcePathFrom(event.payload), {
        engineId: (event.payload?.engineId as string | undefined) ?? intent.engineId,
      });
      return;
    }

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

    await this.stage(hash, profile, this.sourcePathFrom(event.payload), {
      engineId: (event.payload?.engineId as string | undefined) ?? null,
    });
  }

  /**
   * Where on disk the thing that just finished actually is.
   *
   * `contentPath` FIRST, and this order is the whole point.
   *
   * `savePath` is the directory a torrent was saved INTO, and it is shared: ten
   * episodes of one show report the same one, and a movie feed's entire
   * catalogue reports the directory holding 3,000 other films. Importing from it
   * means importing everything in it, not the release that just finished.
   * `contentPath` is the torrent's own file or folder.
   *
   * Falling back to `savePath` keeps an engine that cannot report the item
   * working exactly as before rather than refusing outright.
   */
  private sourcePathFrom(payload: Record<string, unknown> | undefined): string | undefined {
    return (payload?.contentPath as string | undefined)
      || (payload?.savePath as string | undefined);
  }

  /** Register the intake, close out any intent behind it, and start the pipeline. */
  private async stage(
    hash: string,
    profile: { id: string; name: string },
    sourcePath: string | undefined,
    opts: { engineId?: string | null },
  ): Promise<void> {
    if (!sourcePath) {
      this.logger.warn(`Torrent ${hash} completed with no path in the event; cannot stage it.`);
      return;
    }

    const job = await this.intake.enqueue({
      profileId: profile.id,
      sourcePath,
      torrentHash: hash,
      engineId: opts.engineId ?? null,
    });
    this.logger.log(`Queued ${hash} for managed intake via profile "${profile.name}".`);

    /*
     * Spend the intent only once the intake exists. Marking it earlier would
     * lose the download to a failure between the two writes — the intent would
     * read as handled while nothing had been queued, and nothing revisits it.
     */
    if (opts.engineId) {
      await this.prisma.intakeIntent
        .updateMany({
          where: { engineId: opts.engineId, hash, consumedAt: null },
          data: { consumedAt: new Date() },
        })
        .catch((err) => this.logger.debug(`Could not close intent for ${hash}: ${(err as Error).message}`));
    }

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
   * The operator's own decision for this torrent, if they made one.
   *
   * Matched on the hash alone when the event carries no engine — a hash
   * identifies content globally, and refusing to act because the publisher
   * omitted an id would strand exactly the downloads this feature exists to
   * catch.
   */
  private async intentFor(hash: string, engineId?: string) {
    return this.prisma.intakeIntent.findFirst({
      where: { hash, consumedAt: null, ...(engineId ? { engineId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { engineId: true, profileId: true },
    });
  }

  /**
   * The safety net for intents whose completion edge never arrives.
   *
   * `torrent.completed` is published when progress CROSSES 100% — a rising edge
   * against the previous snapshot. Adding a torrent whose data is already on
   * disk (a re-add, a recheck of an existing download) never crosses it: the
   * first observation is already 1.0, and `if (!prev) continue` makes that the
   * baseline. The intent would then wait forever for an event that cannot be
   * published, which is indistinguishable to the operator from intake being
   * broken.
   *
   * So the edge stays the fast path and this is the floor: every two minutes,
   * ask the engine directly about each unspent intent. Enqueue is idempotent, so
   * a race with the edge costs one redundant lookup, not a double import.
   */
  @Interval('intake_intent_sweep', 2 * 60_000)
  async sweepIntents(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const intents = await this.prisma.intakeIntent.findMany({
        where: { consumedAt: null },
        select: { hash: true, engineId: true, profileId: true },
      });
      if (!intents.length) return 0;

      const torrents = await this.liveTorrents();
      // Null means the engine could not be read. Doing nothing is correct: an
      // unreachable engine looks exactly like a torrent that has not finished.
      if (!torrents) return 0;

      let staged = 0;
      for (const intent of intents) {
        const torrent = torrents.get(intent.hash.toLowerCase());
        if (!torrent || torrent.progress < 1) continue;
        const profile = await this.profiles.get(intent.profileId).catch(() => null);
        if (!profile) continue;
        await this.stage(intent.hash, profile, torrent.contentPath || torrent.savePath, {
          engineId: intent.engineId,
        });
        staged += 1;
      }
      if (staged) this.logger.log(`Swept ${staged} already-complete intake intent(s).`);
      return staged;
    } catch (err) {
      this.logger.warn(`Intent sweep failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Every torrent the engine holds, by lowercased hash, or null if unreadable.
   *
   * Resolved through `ModuleRef` at call time rather than injected: importing
   * `TorrentsModule` here closes the module cycle that already bites this
   * codebase (`automation → rss → media-intake → media → …`), and the symptom is
   * a boot-time "module at index [n] is undefined" that no type check or unit
   * test catches.
   */
  private async liveTorrents(): Promise<Map<string, {
    progress: number; contentPath?: string; savePath?: string;
  }> | null> {
    if (!this.moduleRef) return null;
    try {
      const { TorrentsService } = await import('../torrents/torrents.service');
      const torrents = this.moduleRef.get(TorrentsService, { strict: false });
      const listed = await torrents.list({ pageSize: 5000 } as never);
      const items = (listed as unknown as {
        items?: Array<{ hash?: string; progress?: number; contentPath?: string; savePath?: string }>;
      }).items;
      if (!Array.isArray(items)) return null;
      return new Map(
        items
          .filter((t) => t.hash)
          .map((t) => [
            t.hash!.toLowerCase(),
            { progress: t.progress ?? 0, contentPath: t.contentPath, savePath: t.savePath },
          ]),
      );
    } catch (err) {
      this.logger.debug(`Engine listing failed: ${(err as Error).message}`);
      return null;
    }
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
