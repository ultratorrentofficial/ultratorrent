import { Injectable, Logger } from '@nestjs/common';
import {
  OPERATIONS_CONTRACT_VERSION,
  OPERATIONS_DOMAINS,
  PERMISSIONS,
  SystemRole,
  TorrentState,
  isActiveIntake,
  type IntakeState,
  type OperationsAcquisition,
  type OperationsAcquisitionEvent,
  type OperationsActivityItem,
  type OperationsAlert,
  type OperationsAutomation,
  type OperationsDomain,
  type OperationsDomainKey,
  type OperationsEngine,
  type OperationsHealth,
  type OperationsIndexer,
  type OperationsIntakeJob,
  type OperationsJobs,
  type OperationsMedia,
  type OperationsMediaIntake,
  type OperationsNotifications,
  type OperationsPlayback,
  type OperationsProvider,
  type OperationsQueue,
  type OperationsSnapshot,
  type OperationsStorage,
  type OperationsSystem,
  type OperationsTorrent,
  type OperationsTorrents,
} from '@ultratorrent/shared';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { EngineStatusTracker } from '../engine/engine-status.tracker';
import { EngineTorrentCache } from '../engine/engine-torrent.cache';
import { DashboardService } from '../dashboard/dashboard.module';
import { SystemService } from '../system/system.module';
import { MediaIntakeService } from '../media-intake/media-intake.service';
import { MediaHealthService } from '../media/media-health.service';
import { MediaServerSessionService } from '../media-server-analytics/media-server-session.service';
import { PlatformJobsQueryService } from '../jobs/platform/platform-jobs-query.service';
import { SchedulerPreviewService } from '../torrent-scheduler/scheduler-preview.service';
import { IndexerService } from '../indexers/indexer.service';
import { ProwlarrIntegrationService } from '../integrations/prowlarr/prowlarr.service';
import { TorrentParkingService } from '../torrents/torrent-parking.service';
import { projectAlerts, type AlertInputs } from './operations-alerts';

/**
 * Default cap on any list inside a snapshot.
 *
 * A snapshot is an operational *reading*, not an export. The cap is what keeps a
 * console that asks every few seconds from being able to ask the database for a
 * library scan — and it is enforced here rather than trusted to the client,
 * because the client is the thing that might be wrong.
 */
export const DEFAULT_ITEM_CAP = 25;
export const MAX_ITEM_CAP = 100;

/**
 * How long any single domain gets before it is reported as `timeout`.
 *
 * The point is the whole-snapshot guarantee: one sick subsystem degrades its own
 * panel and nothing else. Without a per-domain deadline a hung media server
 * would hold the entire response open, and the console would show nothing at all
 * about a platform that is mostly fine.
 */
const DOMAIN_TIMEOUT_MS = 4_000;

/** Domains served when the caller does not name any. */
export const DEFAULT_DOMAINS: OperationsDomainKey[] = [...OPERATIONS_DOMAINS];

interface Collector {
  key: OperationsDomainKey;
  /** Every permission the caller must hold. SUPER_ADMIN bypasses, as everywhere. */
  requires: string[];
  resolve: (ctx: CollectCtx) => Promise<unknown>;
}

interface CollectCtx {
  user: AuthenticatedUser;
  limit: number;
  now: Date;
}

@Injectable()
export class OperationsSnapshotService {
  private readonly logger = new Logger(OperationsSnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly engineStatus: EngineStatusTracker,
    private readonly torrentCache: EngineTorrentCache,
    private readonly dashboard: DashboardService,
    private readonly system: SystemService,
    private readonly intake: MediaIntakeService,
    private readonly mediaHealth: MediaHealthService,
    private readonly sessions: MediaServerSessionService,
    private readonly jobs: PlatformJobsQueryService,
    private readonly scheduler: SchedulerPreviewService,
    private readonly indexers: IndexerService,
    private readonly prowlarr: ProwlarrIntegrationService,
    private readonly parking: TorrentParkingService,
  ) {}

  // -------------------------------------------------------------------------
  // Permission plumbing
  // -------------------------------------------------------------------------

  /** Held, with the same SUPER_ADMIN short-circuit `PermissionsGuard` applies. */
  private holds(user: AuthenticatedUser, permission: string): boolean {
    if (user.roles?.includes(SystemRole.SUPER_ADMIN)) return true;
    return (user.permissions ?? []).includes(permission);
  }

  private permitted(user: AuthenticatedUser, requires: string[]): boolean {
    return requires.every((p) => this.holds(user, p));
  }

  /** Which domains this identity may read. Used by the capability handshake too. */
  permittedDomains(user: AuthenticatedUser): OperationsDomainKey[] {
    return this.collectors()
      .filter((c) => this.permitted(user, c.requires))
      .map((c) => c.key);
  }

  // -------------------------------------------------------------------------
  // The snapshot
  // -------------------------------------------------------------------------

  async snapshot(
    user: AuthenticatedUser,
    opts: { domains?: OperationsDomainKey[]; limit?: number } = {},
  ): Promise<OperationsSnapshot> {
    const started = Date.now();
    const now = new Date();
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_ITEM_CAP, 1), MAX_ITEM_CAP);
    const wanted = new Set(opts.domains?.length ? opts.domains : DEFAULT_DOMAINS);
    const ctx: CollectCtx = { user, limit, now };

    const collectors = this.collectors().filter((c) => wanted.has(c.key));
    const domains: OperationsSnapshot['domains'] = {};

    /*
     * Alerts are computed from the OTHER domains, so they are resolved last and
     * only from what this caller was actually allowed to see. Deriving them from
     * a privileged view would leak: "3 torrents are in error" tells someone
     * without `torrents.view` that there are torrents, how many, and that
     * something is wrong with them.
     */
    const dataCollectors = collectors.filter((c) => c.key !== 'alerts');

    const results = await Promise.all(
      dataCollectors.map(async (c) => {
        if (!this.permitted(ctx.user, c.requires)) {
          return [c.key, { available: false, reason: 'forbidden' } as OperationsDomain<never>] as const;
        }
        return [c.key, await this.resolveGuarded(c, ctx)] as const;
      }),
    );

    for (const [key, value] of results) {
      (domains as Record<string, unknown>)[key] = value;
    }

    if (wanted.has('alerts')) {
      const inputs: AlertInputs = {};
      const take = <T>(key: OperationsDomainKey): T | undefined => {
        const d = (domains as Record<string, OperationsDomain<unknown> | undefined>)[key];
        return d?.available ? (d.data as T) : undefined;
      };
      inputs.system = take('system');
      inputs.storage = take('storage');
      inputs.torrents = take('torrents');
      inputs.mediaIntake = take('mediaIntake');
      inputs.jobs = take('jobs');
      inputs.engines = take('engines');
      inputs.indexers = take('indexers');
      inputs.providers = take('providers');
      domains.alerts = {
        available: true,
        data: projectAlerts(inputs) as OperationsAlert[],
      };
    }

    return {
      contractVersion: OPERATIONS_CONTRACT_VERSION,
      generatedAt: now.toISOString(),
      durationMs: Date.now() - started,
      domains,
    };
  }

  /**
   * Run one collector behind a deadline, turning any failure into a degraded
   * domain rather than a failed response.
   *
   * The error message is passed through because these are operational strings
   * from our own services ("engine unreachable", "connection refused"), not
   * user input — but it is never a stack trace, and the collectors below never
   * put a credential in one.
   */
  private async resolveGuarded(c: Collector, ctx: CollectCtx): Promise<OperationsDomain<unknown>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const data = await Promise.race([
        c.resolve(ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DomainTimeout()), DOMAIN_TIMEOUT_MS);
        }),
      ]);
      return { available: true, data };
    } catch (err) {
      if (err instanceof DomainTimeout) {
        this.logger.warn(`Operations domain "${c.key}" timed out after ${DOMAIN_TIMEOUT_MS}ms`);
        return { available: false, reason: 'timeout' };
      }
      const message = (err as Error)?.message ?? 'Unavailable';
      this.logger.warn(`Operations domain "${c.key}" failed: ${message}`);
      return { available: false, reason: 'unavailable', message };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Collectors — one per domain, each reading a service that already owns it
  // -------------------------------------------------------------------------

  private collectors(): Collector[] {
    return [
      { key: 'system', requires: [PERMISSIONS.SYSTEM_VIEW], resolve: () => this.collectSystem() },
      { key: 'storage', requires: [PERMISSIONS.SYSTEM_VIEW], resolve: () => this.collectStorage() },
      { key: 'engines', requires: [PERMISSIONS.SYSTEM_VIEW], resolve: () => this.collectEngines() },
      { key: 'torrents', requires: [PERMISSIONS.TORRENTS_VIEW], resolve: (c) => this.collectTorrents(c) },
      { key: 'queue', requires: [PERMISSIONS.TORRENT_SCHEDULER_VIEW], resolve: (c) => this.collectQueue(c) },
      { key: 'mediaIntake', requires: [PERMISSIONS.MEDIA_INTAKE_VIEW], resolve: (c) => this.collectIntake(c) },
      { key: 'media', requires: [PERMISSIONS.MEDIA_MANAGER_VIEW], resolve: () => this.collectMedia() },
      {
        key: 'playback',
        requires: [PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY],
        resolve: (c) => this.collectPlayback(c),
      },
      { key: 'jobs', requires: [PERMISSIONS.JOBS_VIEW], resolve: (c) => this.collectJobs(c) },
      { key: 'automation', requires: [PERMISSIONS.AUTOMATION_VIEW], resolve: (c) => this.collectAutomation(c) },
      { key: 'acquisition', requires: [PERMISSIONS.RSS_VIEW], resolve: (c) => this.collectAcquisition(c) },
      { key: 'indexers', requires: [PERMISSIONS.INDEXERS_VIEW], resolve: () => this.collectIndexers() },
      { key: 'providers', requires: [PERMISSIONS.SYSTEM_VIEW], resolve: () => this.collectProviders() },
      {
        key: 'notifications',
        requires: [PERMISSIONS.NOTIFICATIONS_VIEW_OWN],
        resolve: (c) => this.collectNotifications(c),
      },
      { key: 'recentActivity', requires: [PERMISSIONS.AUDIT_VIEW], resolve: (c) => this.collectActivity(c) },
      // Resolved separately, from the domains above. Requires nothing of its own:
      // an alert can only be built from a domain the caller already read.
      { key: 'alerts', requires: [], resolve: async () => [] },
    ];
  }

  private async collectSystem(): Promise<OperationsSystem> {
    const [health, version, ready] = await Promise.all([
      this.system.health(),
      Promise.resolve(this.system.version()),
      this.system.readiness(),
    ]);
    const load = health.process.load as number[];
    return {
      product: version.product,
      version: version.version,
      apiVersion: version.apiVersion,
      gitSha: version.gitSha ?? null,
      gitTag: version.gitTag ?? null,
      buildTime: version.buildTime ?? null,
      nodeVersion: version.node,
      uptimeSeconds: Math.round(health.process.uptime),
      memoryBytes: health.process.memory,
      loadAverage: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      cpuCount: health.process.cpus,
      database: ready.database ? 'healthy' : 'down',
      // Redis is optional here and nothing reports its liveness, so the honest
      // answer is "not reported" rather than a green light nobody checked.
      cache: 'unknown',
    };
  }

  private async collectStorage(): Promise<OperationsStorage> {
    const health = await this.system.health();
    return {
      roots: (health.disks ?? []).map((d) => {
        const total = d.total ?? 0;
        const used = d.used ?? 0;
        const measured = total > 0 && !('error' in d && d.error);
        return {
          path: d.path,
          totalBytes: total,
          freeBytes: d.free ?? 0,
          usedBytes: used,
          usedPercent: measured ? Math.round((used / total) * 100) : null,
          health: !measured
            ? ('unknown' as OperationsHealth)
            : used / total >= 0.97
              ? ('down' as OperationsHealth)
              : used / total >= 0.9
                ? ('degraded' as OperationsHealth)
                : ('healthy' as OperationsHealth),
          ...('error' in d && d.error ? { error: d.error as string } : {}),
        };
      }),
    };
  }

  /**
   * Engine health from the sync loop's last observation — never a fresh
   * `healthCheck()`.
   *
   * Asking the engine again would make a console's presence cost the engine
   * something, and the poller established the same fact two seconds ago.
   */
  private async collectEngines(): Promise<OperationsEngine[]> {
    return this.registry.list().map((provider) => {
      const last = this.engineStatus.get(provider.engineId);
      return {
        engineId: provider.engineId,
        kind: provider.kind,
        health: !last ? 'unknown' : last.online ? 'healthy' : 'down',
        lastSeenAt: last?.lastSeenAt ?? null,
        error: last?.error ?? null,
        // The provider interface reports no version; nothing invents one here.
        version: null,
        torrentCount: last?.torrentCount ?? null,
      } satisfies OperationsEngine;
    });
  }

  /**
   * The torrent picture, from what the sync loop last saw — never a fresh
   * `listTorrents()`.
   *
   * This used to ask every engine directly, and it was the single most
   * expensive thing in a snapshot: **474 ms of 840 ms** measured on a real
   * install. Worse than the latency was what it implied — the contract
   * advertises a two-second poll, so every console watching would have added a
   * full listing per engine every two seconds, on top of the sync loop's own
   * `@Interval(2000)`. A client whose entire purpose is to observe must not
   * become load on the thing it observes, which is the same rule
   * {@link EngineStatusTracker} and `ProwlarrIntegrationService.storedStatus()`
   * already follow.
   *
   * Readings are looked up BY REGISTRY, so an engine the registry no longer
   * knows contributes nothing even if its reading has not been forgotten yet.
   * An engine that has never been polled is simply absent — reported honestly
   * through `observedAt` rather than as an engine with zero torrents.
   */
  private async collectTorrents(ctx: CollectCtx): Promise<OperationsTorrents> {
    const readings = this.registry
      .list()
      .map((p) => this.torrentCache.get(p.engineId))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const all = readings.flatMap((r) => r.torrents);
    const counts = {
      total: all.length,
      downloading: all.filter((t) => t.state === TorrentState.DOWNLOADING).length,
      seeding: all.filter((t) => t.state === TorrentState.SEEDING).length,
      paused: all.filter((t) => t.state === TorrentState.PAUSED || t.state === TorrentState.STOPPED).length,
      queued: all.filter((t) => t.state === TorrentState.QUEUED).length,
      checking: all.filter((t) => t.state === TorrentState.CHECKING).length,
      errored: all.filter((t) => t.state === TorrentState.ERROR).length,
      stalled: all.filter(isStalled).length,
      parked: 0,
    };

    // Lifetime totals come from the dashboard's ledger-backed summary, not from
    // summing the torrents in front of us — that is a census of survivors and
    // shrinks every time one is removed.
    const summary = await this.dashboard.summary().catch(() => null);

    /*
     * Bounded, and bounded BEFORE annotation: parking and intake lookups are
     * per-hash database reads, so annotating the whole queue to display 25 rows
     * would be paying for the queue to render a page.
     */
    const attentionPool = all
      .filter((t) => t.state === TorrentState.ERROR || isStalled(t))
      .slice(0, ctx.limit);
    const activePool = all
      .filter((t) => t.state === TorrentState.DOWNLOADING || t.state === TorrentState.SEEDING)
      .sort((a, b) => b.downloadRate + b.uploadRate - (a.downloadRate + a.uploadRate))
      .slice(0, ctx.limit);

    const [active, attention] = await Promise.all([
      this.projectTorrents(activePool),
      this.projectTorrents(attentionPool),
    ]);
    counts.parked = [...active, ...attention].filter((t) => t.parked).length;

    return {
      counts,
      rates: {
        downloadRate: readings.reduce((n, r) => n + (r.stats?.downloadRate ?? 0), 0),
        uploadRate: readings.reduce((n, r) => n + (r.stats?.uploadRate ?? 0), 0),
        totalDownloaded: summary?.totalDownloaded ?? 0,
        totalUploaded: summary?.totalUploaded ?? 0,
        ratio: summary?.ratio ?? 0,
      },
      /*
       * The OLDEST reading, not the newest: this is one figure for a merged
       * list, so it must show the worst staleness in it. An engine that stopped
       * answering an hour ago must not be hidden behind one polled a second ago.
       */
      observedAt: readings.reduce<string | null>(
        (oldest, r) => (oldest === null || r.at < oldest ? r.at : oldest),
        null,
      ),
      active,
      attention,
      truncated:
        all.filter((t) => t.state === TorrentState.DOWNLOADING || t.state === TorrentState.SEEDING).length >
          activePool.length ||
        all.filter((t) => t.state === TorrentState.ERROR || isStalled(t)).length > attentionPool.length,
    };
  }

  /**
   * Project engine-normalized torrents into the operations shape.
   *
   * Field by field, never a spread: the normalized torrent carries `savePath`
   * and `contentPath`, which are filesystem layout an observability client has
   * no business receiving, and a spread would put them on the wire the moment
   * someone adds a field upstream.
   */
  private async projectTorrents(
    torrents: Array<import('@ultratorrent/shared').NormalizedTorrent>,
  ): Promise<OperationsTorrent[]> {
    if (!torrents.length) return [];
    const byEngine = new Map<string, typeof torrents>();
    for (const t of torrents) {
      const list = byEngine.get(t.engineId) ?? [];
      list.push(t);
      byEngine.set(t.engineId, list);
    }
    const annotated = (
      await Promise.all(
        [...byEngine.entries()].map(([engineId, list]) =>
          this.parking.annotate(engineId, list).catch(() => list.map((t) => ({ ...t, parked: null }))),
        ),
      )
    ).flat();

    const hashes = annotated.map((t) => t.hash);
    const intakeRows = hashes.length
      ? await this.prisma.mediaIntakeJob.findMany({
          where: { torrentHash: { in: hashes }, state: { not: 'archived' } },
          select: { torrentHash: true, state: true },
        })
      : [];
    const intakeByHash = new Map(
      intakeRows.filter((r) => r.torrentHash).map((r) => [r.torrentHash!.toLowerCase(), r.state]),
    );

    return annotated.map((t) => ({
      hash: t.hash,
      name: t.name,
      engineId: t.engineId,
      state: t.state,
      progress: t.progress,
      sizeBytes: t.size,
      downloadRate: t.downloadRate,
      uploadRate: t.uploadRate,
      ratio: t.ratio,
      eta: t.eta,
      seedsConnected: t.seedsConnected,
      peersConnected: t.peersConnected,
      addedAt: t.addedAt,
      completedAt: t.completedAt,
      message: t.message,
      parked: !!(t as { parked?: unknown }).parked,
      parkedReason:
        ((t as { parked?: { reason?: string } | null }).parked?.reason as string | undefined) ?? null,
      intakeState: intakeByHash.get(t.hash.toLowerCase()) ?? null,
      stalled: isStalled(t),
    }));
  }

  private async collectQueue(ctx: CollectCtx): Promise<OperationsQueue> {
    const [plans, configs] = await Promise.all([
      this.scheduler.previewAll(ctx.now),
      this.prisma.torrentSchedulerEngineConfig.findMany({
        select: { engineId: true, mode: true },
      }),
    ]);

    const names = new Map(
      (
        await this.prisma.torrentSnapshot.findMany({
          where: { hash: { in: plans.flatMap((p) => p.decisions.map((d) => d.hash)).slice(0, 500) } },
          select: { hash: true, name: true },
        })
      ).map((r) => [r.hash, r.name]),
    );

    const decisions = plans.flatMap((p) => p.decisions);
    // Only what an operator would look at: something the scheduler wants to
    // change, or is deliberately holding. A torrent it has no opinion about is
    // not a queue entry.
    const interesting = decisions.filter((d) => d.action !== 'none' || d.protectedFromPause);
    const entries = interesting.slice(0, ctx.limit).map((d) => ({
      hash: d.hash,
      name: names.get(d.hash) ?? d.hash,
      engineId: d.engineId,
      currentState: d.currentOccupancy,
      desiredState: d.desiredState ?? null,
      // The scheduler's own message key: a stable identifier the console
      // localises, rather than a server-rendered English sentence a Spanish
      // operator would be stuck with.
      reason: d.messageKey ?? d.reasonCode ?? null,
      policyName: d.policySource ?? null,
      priority: d.score ?? null,
      override: null,
      protectedFromRemoval: !!d.protectedFromPause,
    }));

    return {
      engineModes: this.registry.list().map((p) => {
        const cfg = configs.find((c) => c.engineId === p.engineId);
        const last = this.engineStatus.get(p.engineId);
        return {
          engineId: p.engineId,
          mode: cfg?.mode ?? 'native',
          health: (!last ? 'unknown' : last.online ? 'healthy' : 'down') as OperationsHealth,
        };
      }),
      entries,
      truncated: interesting.length > entries.length,
    };
  }

  private async collectIntake(ctx: CollectCtx): Promise<OperationsMediaIntake> {
    const startOfDay = new Date(ctx.now);
    startOfDay.setHours(0, 0, 0, 0);

    const [summary, recent, importedToday] = await Promise.all([
      this.intake.summary(),
      this.prisma.mediaIntakeJob.findMany({
        orderBy: { updatedAt: 'desc' },
        take: ctx.limit,
        select: {
          id: true,
          state: true,
          torrentHash: true,
          engineId: true,
          sourcePath: true,
          strategy: true,
          attempts: true,
          lastError: true,
          libraryId: true,
          createdAt: true,
          updatedAt: true,
          startedAt: true,
          importedAt: true,
        },
      }),
      this.prisma.mediaIntakeJob.count({ where: { importedAt: { gte: startOfDay } } }),
    ]);

    const byState = summary.byState as Record<string, number>;
    return {
      byState,
      active: summary.active,
      failed: byState['failed'] ?? 0,
      quarantined: byState['quarantined'] ?? 0,
      importedToday,
      recent: recent.map(
        (r): OperationsIntakeJob => ({
          id: r.id,
          state: r.state,
          torrentHash: r.torrentHash,
          engineId: r.engineId,
          // Basename only. A staging path is deployment layout — the operator
          // needs to know WHICH release, not where this install stages things.
          sourceName: basename(r.sourcePath),
          strategy: r.strategy,
          attempts: r.attempts,
          lastError: r.lastError,
          libraryId: r.libraryId,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          startedAt: r.startedAt?.toISOString() ?? null,
          importedAt: r.importedAt?.toISOString() ?? null,
        }),
      ),
      truncated: (summary.active ?? 0) > recent.length,
    };
  }

  private async collectMedia(): Promise<OperationsMedia> {
    const [health, libraries] = await Promise.all([
      this.mediaHealth.health() as Promise<Record<string, unknown>>,
      this.prisma.mediaLibrary.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          kind: true,
          isEnabled: true,
          lastScanAt: true,
          scanIntervalMinutes: true,
          _count: { select: { items: true } },
        },
      }),
    ]);

    const num = (key: string): number => Number(health[key] ?? 0);
    return {
      totalItems: num('total'),
      byType: (health.byType as Record<string, number>) ?? {},
      unmatched: num('unmatched'),
      lowConfidence: num('lowConfidence'),
      missingArtwork: num('missingArtwork'),
      missingSubtitles: num('missingSubtitles'),
      duplicateGroups: num('duplicateGroups'),
      failedJobs: num('failedJobs'),
      recentlyAdded: num('recentlyAdded'),
      libraries: libraries.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        enabled: l.isEnabled,
        itemCount: l._count?.items ?? null,
        lastScanAt: l.lastScanAt?.toISOString() ?? null,
        scanIntervalMinutes: l.scanIntervalMinutes ?? null,
      })),
    };
  }

  /**
   * Live playback, through `liveActivity()` — the method that is already the
   * redaction boundary. It withholds each viewer's IP address and the
   * provider-internal artwork path; a second reader must not get a second,
   * laxer projection of the same rows.
   */
  private async collectPlayback(ctx: CollectCtx): Promise<OperationsPlayback> {
    const sessions = await this.sessions.liveActivity();
    const shown = sessions.slice(0, ctx.limit);
    const isTranscode = (m: string | null): boolean => !!m && m.toLowerCase().includes('transcode');
    return {
      sessions: shown.map((s) => ({
        id: s.id,
        viewer: s.userDisplayName ?? s.userName,
        title: s.title,
        showTitle: s.showTitle,
        seasonNumber: s.seasonNumber,
        episodeNumber: s.episodeNumber,
        year: s.year,
        mediaType: s.mediaType,
        libraryName: s.libraryName,
        device: s.device,
        client: s.client,
        playbackState: s.playbackState,
        progressPercent: s.progressPercent,
        playbackMethod: s.playbackMethod,
        videoCodec: s.videoCodec,
        audioCodec: s.audioCodec,
        resolution: s.resolution,
        container: s.container,
        bitrateKbps: s.bitrateKbps,
        startedAt: s.startedAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
      transcoding: sessions.filter((s) => isTranscode(s.playbackMethod)).length,
      directPlaying: sessions.filter((s) => !isTranscode(s.playbackMethod)).length,
      truncated: sessions.length > shown.length,
    };
  }

  /**
   * Jobs, through the Jobs Center's own visibility rules.
   *
   * `PlatformJobsQueryService` already scopes a listing to the jobs this caller
   * may see and redacts their payloads. Re-querying `platform_jobs` here would
   * be a second, unreviewed answer to a question that already has one.
   */
  private async collectJobs(ctx: CollectCtx): Promise<OperationsJobs> {
    const [overview, page] = await Promise.all([
      this.jobs.overview(ctx.user),
      this.jobs.list(ctx.user, { pageSize: ctx.limit, sort: 'createdAt', order: 'desc' } as never),
    ]);
    const o = overview as Record<string, number | Record<string, number> | null>;
    const items = (page as { items?: unknown[] }).items ?? [];
    const total = (page as { total?: number }).total ?? items.length;

    return {
      byStatus: (o.byStatus as Record<string, number>) ?? {},
      running: (o.running as number) ?? 0,
      queued: (o.queued as number) ?? 0,
      failed: (o.failed as number) ?? 0,
      active: (o.active as number) ?? 0,
      completedToday: (o.completedToday as number) ?? 0,
      failedToday: (o.failedToday as number) ?? 0,
      successRate: (o.successRate as number | null) ?? null,
      recent: (items as Array<Record<string, unknown>>).map((j) => ({
        id: String(j.id ?? ''),
        type: String(j.type ?? ''),
        moduleKey: String(j.moduleKey ?? ''),
        status: String(j.status ?? ''),
        phase: (j.phase as string | null) ?? null,
        progress: (j.progress as number | null) ?? null,
        message: (j.message as string | null) ?? null,
        errorCode: (j.errorCode as string | null) ?? null,
        createdAt: isoOf(j.createdAt),
        startedAt: isoOrNull(j.startedAt),
        completedAt: isoOrNull(j.completedAt),
      })),
      truncated: total > items.length,
    };
  }

  private async collectAutomation(ctx: CollectCtx): Promise<OperationsAutomation> {
    const since = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000);
    const [rules, logs, failures24h] = await Promise.all([
      this.prisma.automationRule.findMany({
        orderBy: { name: 'asc' },
        take: MAX_ITEM_CAP,
        select: { id: true, name: true, isEnabled: true, trigger: true, updatedAt: true },
      }),
      this.prisma.automationLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: ctx.limit,
        select: {
          id: true,
          ruleId: true,
          status: true,
          message: true,
          context: true,
          createdAt: true,
          rule: { select: { name: true } },
        },
      }),
      this.prisma.automationLog.count({ where: { status: 'failed', createdAt: { gte: since } } }),
    ]);

    const lastByRule = new Map<string, { at: Date; status: string }>();
    for (const l of logs) {
      if (!lastByRule.has(l.ruleId)) lastByRule.set(l.ruleId, { at: l.createdAt, status: l.status });
    }

    return {
      rules: rules.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.isEnabled,
        trigger: r.trigger ?? null,
        lastRunAt: lastByRule.get(r.id)?.at.toISOString() ?? null,
        lastStatus: lastByRule.get(r.id)?.status ?? null,
      })),
      recentRuns: logs.map((l) => ({
        id: l.id,
        ruleId: l.ruleId,
        ruleName: l.rule?.name ?? l.ruleId,
        status: l.status,
        message: l.message,
        // One named scalar out of the context, never the context itself: it is
        // a free-form Json column, and forwarding it wholesale is how a payload
        // nobody reviewed reaches a client.
        trigger: scalarFrom(l.context, 'trigger'),
        at: l.createdAt.toISOString(),
      })),
      failures24h,
      truncated: rules.length >= MAX_ITEM_CAP,
    };
  }

  /**
   * The acquisition picture, assembled from the two rows RSS actually writes.
   *
   * `RssHistory` is per FEED ITEM — it knows the title, the feed and whether the
   * item was matched and taken, but not which rule decided that.
   * `RssRuleMatchEvaluation` is per RULE JUDGEMENT and knows the rule, the
   * verdict and the resulting hash, but not the release title. Neither alone
   * answers "what did acquisition do", so both are read and joined here rather
   * than a column being added to carry the answer twice.
   *
   * The join key is `rssItemId`, which is the feed's own `itemGuid` (not a
   * history row id — see `recordEvaluation`). A guid is unique within a feed but
   * nothing forbids two feeds publishing the same one, so the most recent
   * evaluation wins; the alternative, a compound key RSS does not store, would
   * mean changing the writer for a display nicety.
   */
  private async collectAcquisition(ctx: CollectCtx): Promise<OperationsAcquisition> {
    const since = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000);
    const [feeds, history, grabs24h] = await Promise.all([
      this.prisma.rssFeed.findMany({
        orderBy: { name: 'asc' },
        take: MAX_ITEM_CAP,
        select: {
          id: true,
          name: true,
          isEnabled: true,
          lastFetchedAt: true,
          refreshInterval: true,
          _count: { select: { rules: true } },
        },
      }),
      this.prisma.rssHistory.findMany({
        orderBy: { createdAt: 'desc' },
        take: ctx.limit,
        select: {
          id: true,
          feedId: true,
          itemGuid: true,
          title: true,
          matched: true,
          downloaded: true,
          infoHash: true,
          createdAt: true,
          feed: { select: { name: true } },
        },
      }),
      /*
       * First-seen grabs in the window. A re-grab UPDATES its history row
       * rather than inserting one, so this counts items acquisition took for
       * the first time in 24h — which is the number an operator means by "what
       * did it pull today", and is not the same as a count of engine adds.
       */
      this.prisma.rssHistory.count({
        where: { downloaded: true, createdAt: { gte: since } },
      }),
    ]);

    const evaluations = history.length
      ? await this.prisma.rssRuleMatchEvaluation.findMany({
          where: { rssItemId: { in: history.map((h) => h.itemGuid) } },
          orderBy: { createdAt: 'desc' },
          select: {
            rssItemId: true,
            rssRuleId: true,
            result: true,
            actionTaken: true,
            torrentHash: true,
            rule: { select: { name: true } },
          },
        })
      : [];

    // Newest-first, so the first sighting of a guid is its latest judgement.
    const verdicts = new Map<string, (typeof evaluations)[number]>();
    for (const e of evaluations) if (!verdicts.has(e.rssItemId)) verdicts.set(e.rssItemId, e);

    return {
      feeds: feeds.map((f) => ({
        id: f.id,
        name: f.name,
        enabled: f.isEnabled,
        lastPolledAt: f.lastFetchedAt?.toISOString() ?? null,
        refreshIntervalSeconds: f.refreshInterval,
        ruleCount: f._count?.rules ?? 0,
      })),
      recent: history.map((h): OperationsAcquisitionEvent => {
        const verdict = verdicts.get(h.itemGuid);
        return {
          id: h.id,
          feedId: h.feedId,
          feedName: h.feed?.name ?? null,
          ruleId: verdict?.rssRuleId ?? null,
          ruleName: verdict?.rule?.name ?? null,
          releaseTitle: h.title,
          result: acquisitionResult(h.downloaded, h.matched, verdict?.result ?? null),
          // Only when it explains why nothing was taken. Repeating "matched" as
          // the reason for a download says nothing.
          reason: h.downloaded ? null : (verdict?.actionTaken ?? verdict?.result ?? null),
          /*
           * The feed's own hash first: it is recorded for every grabbed item,
           * including those no rule evaluated. The evaluation's hash is the
           * fallback for an item whose link carried neither magnet nor btih.
           */
          torrentHash: h.infoHash ?? verdict?.torrentHash ?? null,
          at: h.createdAt.toISOString(),
        };
      }),
      grabs24h,
      truncated: feeds.length >= MAX_ITEM_CAP || history.length >= ctx.limit,
    };
  }

  private async collectIndexers(): Promise<OperationsIndexer[]> {
    const rows = (await this.indexers.list()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.name ?? ''),
      implementation: String(r.implementation ?? ''),
      protocol: String(r.protocol ?? ''),
      enabled: !!r.enabled,
      priority: Number(r.priority ?? 0),
      health: r.status === 'ok' ? 'healthy' : r.status === 'error' ? 'down' : 'unknown',
      message: (r.statusMessage as string | null) ?? null,
      lastTestedAt: isoOrNull(r.lastTestedAt),
    }));
  }

  /**
   * Non-engine external services, flattened.
   *
   * Every entry is read from a STORED status column that some existing health
   * check wrote. Nothing here reaches out to a provider: a snapshot must not
   * make the act of looking at the platform into load on the platform's
   * dependencies.
   */
  private async collectProviders(): Promise<OperationsProvider[]> {
    const [mediaServers, subtitleProviders, prowlarr] = await Promise.all([
      this.prisma.mediaServerIntegration.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          kind: true,
          isEnabled: true,
          status: true,
          serverVersion: true,
          platform: true,
          lastHealthCheckAt: true,
        },
      }),
      this.prisma.subtitleProviderConfig
        .findMany({ select: { provider: true, isEnabled: true, priority: true } })
        .catch(() => []),
      this.prowlarr.storedStatus().catch(() => null),
    ]);

    const out: OperationsProvider[] = mediaServers.map((m) => ({
      category: 'media_server',
      key: m.id,
      name: m.name,
      enabled: m.isEnabled,
      health: m.status === 'online' ? 'healthy' : m.status === 'offline' ? 'down' : 'unknown',
      message: null,
      version: m.serverVersion ?? null,
      lastCheckedAt: m.lastHealthCheckAt?.toISOString() ?? null,
      capabilities: [m.kind, ...(m.platform ? [m.platform] : [])],
    }));

    for (const s of subtitleProviders as Array<{ provider: string; isEnabled: boolean; priority: number }>) {
      out.push({
        category: 'subtitle',
        key: s.provider,
        name: s.provider,
        enabled: s.isEnabled,
        // Subtitle providers record configuration, not liveness. Reporting
        // "healthy" from an enabled flag would be inventing a health check.
        health: 'unknown',
        message: null,
        version: null,
        lastCheckedAt: null,
        capabilities: [`priority ${s.priority}`],
      });
    }

    if (prowlarr) {
      out.push({
        category: 'companion',
        key: 'prowlarr',
        name: 'Prowlarr',
        enabled: prowlarr.enabled,
        health:
          prowlarr.status === 'ok'
            ? 'healthy'
            : prowlarr.status === 'error'
              ? 'down'
              : prowlarr.status === 'disabled'
                ? 'unknown'
                : 'degraded',
        message: prowlarr.message,
        version: prowlarr.version,
        lastCheckedAt: prowlarr.lastCheckedAt,
        capabilities: prowlarr.indexerCount !== null ? [`${prowlarr.indexerCount} indexers`] : [],
      });
    }

    return out;
  }

  /**
   * Notification delivery health.
   *
   * Scoped to the caller's own deliveries unless they hold `users.view`. A
   * delivery row names who was told what, which is exactly the kind of fact
   * that must not widen just because it arrived through a different client.
   * Channel *type* is reported; channel credentials are never read.
   */
  private async collectNotifications(ctx: CollectCtx): Promise<OperationsNotifications> {
    const since = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000);
    const seesEveryone = this.holds(ctx.user, PERMISSIONS.USERS_VIEW);
    const where = seesEveryone ? {} : { userId: ctx.user.id };

    const [grouped, pending, failed24h, recent] = await Promise.all([
      this.prisma.userNotificationDelivery.groupBy({
        by: ['status'],
        where: { ...where, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.userNotificationDelivery.count({ where: { ...where, status: 'pending' } }),
      this.prisma.userNotificationDelivery.count({
        where: { ...where, status: 'failed', createdAt: { gte: since } },
      }),
      this.prisma.userNotificationDelivery.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: ctx.limit,
        select: {
          id: true,
          eventKey: true,
          channelType: true,
          status: true,
          attempts: true,
          lastError: true,
          createdAt: true,
          user: { select: { username: true, displayName: true } },
        },
      }),
    ]);

    return {
      last24h: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
      pending,
      failed24h,
      recent: recent.map((d) => ({
        id: d.id,
        eventKey: d.eventKey,
        channelType: d.channelType,
        status: d.status,
        attempts: d.attempts,
        recipient: seesEveryone ? (d.user?.displayName ?? d.user?.username ?? null) : null,
        error: d.lastError,
        at: d.createdAt.toISOString(),
      })),
      truncated: false,
    };
  }

  /**
   * The same collapsed feed the web app's dashboard shows, projected flat.
   *
   * `events` is deliberately dropped and replaced by a count: the web app can
   * expand a collapsed line into its constituents, but a snapshot that carried
   * every one of them would let a burst of 200 enrichment rows arrive inside a
   * response whose whole purpose is to be bounded. The count preserves what the
   * line means — "this stands for more than itself" — at fixed size.
   */
  private async collectActivity(ctx: CollectCtx): Promise<OperationsActivityItem[]> {
    const items = await this.dashboard.recentActivity(ctx.limit);
    return items.map((i) => ({
      id: i.id,
      type: i.type,
      message: i.message,
      detail: i.detail,
      level: i.level,
      eventCount: i.events?.length ?? 1,
      at: i.at,
    }));
  }
}

/**
 * The one word for what acquisition did with a feed item.
 *
 * `downloaded` beats everything — the item was taken, whatever any single rule's
 * evaluation said, because more than one rule may judge the same item and only
 * one of them needs to have wanted it. `matched` is kept distinct from
 * `no_match` deliberately: "a rule wanted this and it was not taken" is the
 * state worth looking into, and collapsing both into "rejected" would bury it
 * among the thousands of feed items nothing was ever going to want.
 */
function acquisitionResult(
  downloaded: boolean,
  matched: boolean,
  verdict: string | null,
): string {
  if (downloaded) return 'downloaded';
  if (verdict === 'skipped_duplicate') return 'skipped_duplicate';
  return matched ? 'matched' : 'no_match';
}

/** Marker so a deadline is distinguishable from a genuine failure. */
class DomainTimeout extends Error {}

/**
 * An operator's "stalled": downloading, connected to nobody, moving nothing.
 *
 * Deliberately not "zero rate" alone — a torrent can legitimately sit at 0 B/s
 * for a tick between pieces, and a queued or checking torrent is not stalled,
 * it is waiting.
 */
function isStalled(t: { state: string; downloadRate: number; peersConnected: number; progress: number }): boolean {
  return (
    t.state === TorrentState.DOWNLOADING &&
    t.downloadRate === 0 &&
    t.peersConnected === 0 &&
    t.progress < 1
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(0).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** One named scalar out of a free-form Json column, or null. Never the column. */
function scalarFrom(json: unknown, key: string): string | null {
  if (!json || typeof json !== 'object') return null;
  const value = (json as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/** Re-exported so specs can assert the state vocabulary they depend on. */
export const ACTIVE_INTAKE = (state: string): boolean => isActiveIntake(state as IntakeState);
