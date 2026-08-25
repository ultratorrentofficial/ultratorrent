import { Injectable, Logger } from '@nestjs/common';
import { TorrentState } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { SchedulerCapabilityService } from './scheduler-capability.service';
import { classify } from './domain/classification';
import { scoreTorrent } from './domain/priority';
import { planEngine, type PlannerTorrent, type EngineActivityPlan } from './domain/planner';
import {
  resolveEffectivePolicy,
  type TorrentSchedulingPolicy,
  type SchedulingPolicyScopeType,
} from './domain/policy';
import { applySchedule, type ScheduleWindow } from './domain/schedule';
import { libraryForPath } from './domain/library-scope';
import { hashCaseVariants, rulesByTorrentHash } from './domain/rss-scope';
import { SchedulerOverrideService } from './scheduler-override.service';

/**
 * Build the plan for an engine, without touching anything.
 *
 * Reads the persisted `TorrentSnapshot` rows that `TorrentSyncService` already
 * maintains rather than polling the engine again: the snapshot is the normalized
 * state the rest of the application trusts, and a second poll would both add
 * load and let the preview disagree with what every other screen shows.
 *
 * This is the whole of Observe Only. The same function backs the enforced plan
 * later, so what an operator validates here is what enforcement would do — a
 * preview computed by a different code path would be a guess about the real one.
 */
@Injectable()
export class SchedulerPreviewService {
  private readonly logger = new Logger(SchedulerPreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly capabilities: SchedulerCapabilityService,
    private readonly overrides: SchedulerOverrideService,
  ) {}

  /** Policies as the pure resolver wants them. */
  private async loadPolicies(): Promise<TorrentSchedulingPolicy[]> {
    const rows = await this.prisma.torrentSchedulerPolicy.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      scope: { type: r.scopeType as SchedulingPolicyScopeType, id: r.scopeId },
      // A NULL column is "explicitly unlimited"; the resolver needs `undefined`
      // to mean inherit, and Prisma gives null for both. A column that was never
      // set is indistinguishable from one set to unlimited at the storage layer,
      // so the presence of the ROW at a scope is what makes it a decision.
      maxConcurrentDownloads: r.maxConcurrentDownloads,
      maxConcurrentSeeds: r.maxConcurrentSeeds,
      maxTotalActive: r.maxTotalActive,
      maxDownloadRateKbps: r.maxDownloadRateKbps,
      maxUploadRateKbps: r.maxUploadRateKbps,
      reserveDownloadBandwidthPercent: r.reserveDownloadBandwidthPercent ?? undefined,
      reserveSeedBandwidthPercent: r.reserveSeedBandwidthPercent ?? undefined,
      seedPolicy: (r.seedPolicy as unknown as TorrentSchedulingPolicy['seedPolicy']) ?? undefined,
    }));
  }

  /**
   * Plan one engine from its current snapshots.
   *
   * Returns null when the engine is unknown to the registry — an engine that
   * cannot be resolved has no capabilities, and planning against
   * `UNKNOWN_QUEUE_CAPABILITIES` would produce a page of "cannot pause" noise
   * rather than an answer.
   */
  async previewEngine(engineId: string, now = new Date()): Promise<EngineActivityPlan | null> {
    let kind;
    try {
      kind = this.registry.get(engineId).kind;
    } catch {
      return null;
    }
    const caps = this.capabilities.for(kind);

    /*
     * Snapshots first, because the intake lookup is bounded BY them. Asking for
     * every intake job an engine ever had would load a table that grows forever
     * to answer a question about the couple of hundred torrents currently
     * loaded — a query that is fine on a new install and ruinous on a two-year
     * old one. One extra round trip buys a bound that does not decay.
     */
    const snapshots = await this.prisma.torrentSnapshot.findMany({ where: { engineId } });
    const hashes = snapshots.map((s) => s.hash);

    const [policies, parked, states, intakeJobs, libraries, ruleMatches, windows, overrides,
      categories] = await Promise.all([
      this.loadPolicies(),
      this.prisma.parkedTorrent.findMany({ where: { engineId }, select: { hash: true } }),
      // Which torrents the SCHEDULER is holding paused. Without this every pause
      // reads as someone else's and the scheduler can never give a slot back —
      // enforcement in one direction only.
      this.prisma.torrentSchedulerState.findMany({
        where: { engineId, schedulerPausedAt: { not: null } },
        select: { hash: true, lastActionAt: true },
      }),
      /*
       * Media Intake's view of the same torrents. A seeding policy that removes
       * or stops a torrent once its target is met usually exists BECAUSE the
       * library copy is not safe yet, so the scheduler has to be able to ask
       * whether the import actually finished — and answer "no" when it cannot
       * tell, rather than assuming it did.
       */
      this.prisma.mediaIntakeJob.findMany({
        where: { engineId, torrentHash: { in: hashes } },
        // `libraryId` is what a library-scoped policy matches on. Where intake
        // handled the import this is the RECORDED association, which beats
        // inferring one from a path.
        select: { torrentHash: true, state: true, mediaItemId: true, libraryId: true },
      }),
      // Library roots, for the torrents intake did not import. On this platform
      // libraries sit inside the download tree, so the covering root is how the
      // rest of the system already decides which library a file belongs to.
      this.prisma.mediaLibrary.findMany({
        where: { isEnabled: true },
        select: { id: true, path: true },
      }),
      /*
       * Which RSS rule downloaded each torrent, for `rss_rule`-scoped policies.
       *
       * Bounded by the loaded hashes like the intake lookup above, and for the
       * same reason: this table records EVERY evaluation every rule ever made,
       * so an unbounded read grows without limit to answer a question about the
       * couple of hundred torrents currently in the queue. `actionTaken` is
       * filtered in the query rather than after it, because declined and
       * duplicate-skipped rows are the overwhelming majority.
       */
      this.prisma.rssRuleMatchEvaluation.findMany({
        where: {
          torrentHash: { in: hashCaseVariants(hashes) },
          actionTaken: 'download',
        },
        select: { torrentHash: true, rssRuleId: true, actionTaken: true, createdAt: true },
      }),
      // Loaded once per engine and evaluated against `now`, rather than each
      // window owning a timer. One clock read answers every window.
      this.prisma.torrentSchedulerWindow.findMany({ where: { enabled: true } }),
      // What an operator asked for, per torrent. Expired instructions are
      // filtered by the clock rather than by a cleanup job.
      this.overrides.active(engineId, now),
      /*
       * Category NAMES, not the ids the snapshot stores.
       *
       * `seed.category` is a text condition an operator writes as
       * `contains "TV"`. Feeding it `categoryId` would compare that against a
       * UUID — populated, type-correct, and matching nothing — which is the
       * same failure as leaving it undefined, only harder to see.
       */
      this.prisma.torrentCategory.findMany({ select: { id: true, name: true } }),
    ]);
    const intake = new Map(
      intakeJobs
        .filter((j) => j.torrentHash)
        .map((j) => [j.torrentHash!.toLowerCase(), j]),
    );
    // Which rule put each torrent here — most recent download wins.
    const ruleByHash = rulesByTorrentHash(ruleMatches);
    // Parking owns these torrents; the scheduler must not contend for them.
    const parkedHashes = new Set(parked.map((p) => p.hash.toLowerCase()));
    const ourPauses = new Map(states.map((s) => [s.hash.toLowerCase(), s.lastActionAt]));
    const categoryNames = new Map(categories.map((c) => [c.id, c.name]));

    const torrents: PlannerTorrent[] = snapshots.map((s) => {
      const complete = s.progress >= 1;
      const classification = classify(
        {
          state: s.state as TorrentState,
          progress: s.progress,
          downloadRate: s.downloadRate,
          uploadRate: s.uploadRate,
          parked: parkedHashes.has(s.hash.toLowerCase()),
          // Only a pause WE recorded counts as ours. Anything else — a person, an
          // automation rule, the engine — stays untouchable.
          schedulerPaused: ourPauses.has(s.hash.toLowerCase()),
        },
        caps,
      );

      const ov = overrides.get(s.hash.toLowerCase()) ?? new Set<string>();
      const job = intake.get(s.hash.toLowerCase());
      // `imported` and everything after it means the file reached the library.
      const imported = !!job && ['imported', 'metadata_ready', 'artwork_ready',
        'subtitle_ready', 'seeding', 'archived'].includes(job.state);

      // Scopes decide the policy; an open window then overrides it. A schedule
      // is a temporary override of what the scopes concluded, not another scope.
      const policy = applySchedule(
        resolveEffectivePolicy(policies, {
          torrentHash: s.hash,
          engineId,
          categoryId: s.categoryId,
          /*
           * Which library this torrent belongs to.
           *
           * Without this a `library`-scoped policy matched nothing at all —
           * `matches()` requires `ctx.libraryId` and it was never populated, so
           * the scope existed in the editor, saved happily, and then silently
           * governed no torrent. A policy that cannot apply is worse than one
           * the UI refuses to create.
           *
           * Recorded association first (intake knows exactly where it put the
           * file), then the covering library root for everything intake did not
           * import — which on this platform is most of the queue, since the
           * libraries live inside the download tree.
           */
          libraryId: job?.libraryId ?? libraryForPath(s.savePath, libraries),
          rssRuleId: ruleByHash.get(s.hash.toLowerCase()) ?? null,
        }),
        windows as unknown as ScheduleWindow[],
        now,
      );

      return {
        hash: s.hash,
        // Populated at last: the field existed on PlannerTorrent and nothing
        // ever filled it, so `seed.name` conditions matched nothing and every
        // decision reached the UI identified only by a hash.
        name: s.name,
        engineId,
        // Exclusion outranks everything the engine reports: the operator has
        // taken this torrent out of the scheduler's hands.
        occupancy: ov.has('exclude') ? 'excluded' : classification.occupancy,
        complete,
        ratio: s.ratio,
        // Deliberately absent: nothing records seed duration, so a time-based
        // target must evaluate to unknown rather than to zero.
        seedMinutes: undefined,
        /*
         * The rest of the facts a seeding condition can be written against.
         *
         * Every one of these was declared on PlannerTorrent, offered in the
         * condition builder, and never populated here — so a rule naming any of
         * them evaluated to `unknown` forever. That is fail-safe (an unmeasured
         * fact can never be shown to match, so nothing was ever deleted for the
         * wrong reason) but it is silent, which is the actual defect: the policy
         * sat in the database looking configured while governing nothing.
         *
         * BigInt is converted at this boundary, not left to the comparator. The
         * ordinal operators coerce with Number() and would survive, but `eq`
         * compares with === , where `5n === 5` is false — a rule that looks
         * exact and is never true.
         */
        sizeBytes: Number(s.size),
        uploadedBytes: Number(s.uploaded),
        label: s.label ?? undefined,
        category: (s.categoryId ? categoryNames.get(s.categoryId) : undefined) ?? undefined,
        // Unlike seed duration, completion IS recorded — which is what makes an
        // age deadline enforceable where a seed-time target is not.
        completedAt: s.completedAt,
        intakeImported: imported,
        // The item exists in a library, which is as close to "verified" as the
        // current data goes; a stronger check belongs with intake, not here.
        libraryCopyVerified: imported && !!job?.mediaItemId,
        addedAt: s.addedAt,
        // Feeds the hysteresis check, so a torrent the scheduler only just
        // started is not paused again seconds later.
        lastActionAt: ourPauses.get(s.hash.toLowerCase()) ?? null,
        allowNewDownloads: policy.allowNewDownloads,
        protectedFromPause: ov.has('protect_from_pause'),
        protectedFromRemoval: ov.has('protect_from_removal'),
        forceStarted: ov.has('force_start'),
        policy,
        decision: scoreTorrent({
          torrentHash: s.hash,
          progress: s.progress,
          ageMinutes: s.addedAt ? (now.getTime() - s.addedAt.getTime()) / 60_000 : undefined,
        }),
      };
    });

    return planEngine(engineId, torrents, caps, { now });
  }

  /**
   * Plan every engine the registry knows about, concurrently.
   *
   * Each engine's plan is independent — `previewEngine` reads that engine's own
   * snapshot rows and policies and shares nothing across engines — so the
   * sequential loop this replaces made the cost the SUM rather than the MAX for
   * no benefit. Measured on a real two-engine install, the queue domain took
   * 469 ms of an 840 ms operations snapshot; nothing in it was waiting on
   * anything but the previous engine.
   *
   * Order is preserved, because the caller renders these as a list and a set of
   * panels that reshuffles between refreshes is unreadable.
   */
  async previewAll(now = new Date()): Promise<EngineActivityPlan[]> {
    const settled = await Promise.all(
      this.registry.list().map(async (provider) => {
        try {
          return await this.previewEngine(provider.engineId, now);
        } catch (err) {
          // One engine's failure must not deny the operator the others' plans.
          this.logger.warn(
            `Scheduler preview failed for ${provider.engineId}: ${(err as Error).message}`,
          );
          return null;
        }
      }),
    );
    return settled.filter((plan): plan is EngineActivityPlan => plan !== null);
  }
}
