import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NormalizedTorrent, NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS, WS_EVENTS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AutomationEngine } from '../automation/automation.module';
import { NotificationsService } from '../notifications/notifications.module';
import { MediaProcessingService } from '../media/media-processing.service';

/**
 * Background synchroniser. On a fixed cadence it pulls live torrent + stats
 * data from each engine, persists lightweight snapshots for fast querying /
 * search, and pushes deltas to connected clients over WebSocket.
 *
 * Polling (not per-torrent subscription) keeps the engine integration simple
 * while WebSocket fan-out keeps the UI responsive without client polling.
 */
@Injectable()
export class TorrentSyncService {
  private readonly logger = new Logger(TorrentSyncService.name);
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly realtime: RealtimeGateway,
    private readonly automation: AutomationEngine,
    private readonly notifications: NotificationsService,
    private readonly mediaProcessing: MediaProcessingService,
    private readonly eventBus: EventEmitter2,
  ) {}

  @Interval(2000)
  async sync(): Promise<void> {
    if (this.syncing) return; // skip overlapping ticks
    this.syncing = true;
    try {
      for (const provider of this.registry.list()) {
        await this.syncEngine(provider);
      }
    } finally {
      this.syncing = false;
    }
  }

  private async syncEngine(
    provider: import('../../domain/engine/torrent-engine-provider.interface').TorrentEngineProvider,
  ): Promise<void> {
    const at = new Date().toISOString();
    try {
      const [torrents, stats] = await Promise.all([
        provider.listTorrents(),
        provider.getGlobalStats(),
      ]);

      this.realtime.broadcast(WS_EVENTS.TORRENTS_UPDATE, {
        engineId: provider.engineId,
        torrents,
        at,
      });
      this.realtime.broadcast(WS_EVENTS.STATS_UPDATE, {
        engineId: provider.engineId,
        stats,
        at,
      });

      await this.detectTransitions(provider.engineId, torrents);
      await this.persistSnapshots(provider.engineId, torrents);
      this.realtime.broadcast(WS_EVENTS.ENGINE_STATUS, {
        engineId: provider.engineId,
        online: true,
        error: null,
        at,
      });
    } catch (err) {
      this.logger.warn(
        `Engine ${provider.engineId} sync failed: ${(err as Error).message}`,
      );
      this.realtime.broadcast(WS_EVENTS.ENGINE_STATUS, {
        engineId: provider.engineId,
        online: false,
        error: (err as Error).message,
        at,
      });
    }
  }

  /**
   * Compare each torrent against its last persisted snapshot to detect state
   * transitions, then fire the matching automation triggers:
   *  - `torrent.completed` — edge-fired once when progress crosses to 100%.
   *  - `ratio.reached` — re-checked every cycle but edge-fired once when a
   *    torrent first satisfies a ratio rule (the engine skips rules that were
   *    already satisfied at the previous ratio, so it doesn't re-fire).
   * Torrents with no prior snapshot are skipped this cycle (a baseline is
   * written by persistSnapshots), so nothing fires on the very first sighting.
   */
  private async detectTransitions(
    engineId: string,
    torrents: NormalizedTorrent[],
  ): Promise<void> {
    const prior = await this.prisma.torrentSnapshot.findMany({
      where: { engineId, hash: { in: torrents.map((t) => t.hash) } },
      select: { hash: true, progress: true, ratio: true },
    });
    const priorMap = new Map(prior.map((p) => [p.hash, p]));

    const ratioItems: Array<{
      context: NormalizedTorrent;
      previous: NormalizedTorrent;
    }> = [];
    // Torrents that crossed to 100% on THIS tick — handled by the edge path
    // below and excluded from the reconcile backfill so they can't double-fire.
    const risingEdges = new Set<string>();

    for (const t of torrents) {
      const prev = priorMap.get(t.hash);
      if (!prev) continue; // no baseline yet — establish one, act next cycle

      if (prev.progress < 1 && t.progress >= 1) {
        risingEdges.add(t.hash);
        await this.notifications.dispatch({
          level: 'success',
          title: 'Download complete',
          message: t.name,
          eventType: 'torrent.completed',
        });
        this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, {
          event: NOTIFICATION_EVENTS.DOWNLOAD_TORRENT_COMPLETED,
          payload: { torrentName: t.name, mediaTitle: t.name, hash: t.hash, size: t.size, ratio: t.ratio, savePath: t.savePath ?? null, label: t.label ?? null, serverName: t.engineId },
          at: new Date().toISOString(),
        });
        await this.automation
          .evaluate('torrent.completed', t)
          .catch((err) =>
            this.logger.warn(`Automation evaluate failed: ${err.message}`),
          );
        // Post-download Media Manager workflow (opt-in, best-effort). Runs after
        // rule evaluation so operator rules see the completion first.
        await this.mediaProcessing
          .handleTorrentCompleted(t)
          .catch((err) =>
            this.logger.warn(`Media workflow failed: ${err.message}`),
          );
      }

      // Rising-edge on ratio: previous = this torrent at last cycle's ratio.
      ratioItems.push({ context: t, previous: { ...t, ratio: prev.ratio } });
    }

    await this.automation
      .evaluateMany('ratio.reached', ratioItems)
      .catch((err) =>
        this.logger.warn(`Automation ratio.reached failed: ${err.message}`),
      );

    // Backfill: fire `torrent.completed` rules for torrents that are already at
    // 100% but did NOT cross the edge on this tick — those first seen already
    // complete, that finished while the app was down, or whose rule was created
    // after completion. The edge path above never covers these, which is why
    // completed torrents would otherwise seed forever instead of being removed.
    // Idempotent via AutomationLog, so it's safe to call every cycle.
    await this.automation
      .reconcileCompleted(
        torrents.filter((t) => t.progress >= 1 && !risingEdges.has(t.hash)),
      )
      .catch((err) =>
        this.logger.warn(`Automation reconcile failed: ${err.message}`),
      );
  }

  private async persistSnapshots(
    engineId: string,
    torrents: import('@ultratorrent/shared').NormalizedTorrent[],
  ): Promise<void> {
    // Upsert in a transaction; cheap because the set is bounded per engine.
    await this.prisma.$transaction(
      torrents.map((t) =>
        this.prisma.torrentSnapshot.upsert({
          where: { engineId_hash: { engineId, hash: t.hash } },
          create: {
            engineId,
            hash: t.hash,
            name: t.name,
            state: t.state,
            progress: t.progress,
            size: BigInt(Math.round(t.size)),
            downloaded: BigInt(Math.round(t.downloaded)),
            uploaded: BigInt(Math.round(t.uploaded)),
            ratio: t.ratio,
            downloadRate: t.downloadRate,
            uploadRate: t.uploadRate,
            savePath: t.savePath,
            label: t.label,
            addedAt: t.addedAt ? new Date(t.addedAt) : null,
            completedAt: t.completedAt ? new Date(t.completedAt) : null,
          },
          update: {
            name: t.name,
            state: t.state,
            progress: t.progress,
            size: BigInt(Math.round(t.size)),
            downloaded: BigInt(Math.round(t.downloaded)),
            uploaded: BigInt(Math.round(t.uploaded)),
            ratio: t.ratio,
            downloadRate: t.downloadRate,
            uploadRate: t.uploadRate,
            label: t.label,
            completedAt: t.completedAt ? new Date(t.completedAt) : null,
          },
        }),
      ),
    );
  }
}
