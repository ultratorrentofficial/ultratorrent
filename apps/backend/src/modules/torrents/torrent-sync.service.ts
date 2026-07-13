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
import { TorrentNameRepairService } from './torrent-name-repair.service';

/** An engine call that never settles must not be able to wedge the tick. */
const ENGINE_TIMEOUT_MS = 15_000;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ENGINE_TIMEOUT_MS}ms`)),
      ENGINE_TIMEOUT_MS,
    );
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Background synchroniser. On a fixed cadence it pulls live torrent + stats
 * data from each engine, persists lightweight snapshots for fast querying /
 * search, and pushes deltas to connected clients over WebSocket.
 *
 * Polling (not per-torrent subscription) keeps the engine integration simple
 * while WebSocket fan-out keeps the UI responsive without client polling.
 *
 * ORDER MATTERS, and it is the whole reason this tick is written the way it is.
 * The new state is persisted BEFORE any side-effect fires. A transition is derived
 * by comparing the engine against the last snapshot, so if we act first and persist
 * afterwards, a side-effect that is slow — or that hangs — leaves the snapshot
 * unwritten, and the *same* transition is detected again on the next tick. That is
 * not hypothetical: a torrent sitting at 0.9999570 in the snapshot while the engine
 * reported 1.0 re-fired `torrent.completed` every 2 seconds, each time awaiting the
 * full post-download media pipeline, until it had run **5,284 times** and finally
 * blocked on an external metadata fetch. The tick's re-entrancy guard is cleared in
 * a `finally`, so that one stuck await killed the entire sync loop — no torrent
 * updates, no transitions, no automation, no name repair — until the process was
 * restarted. Persisting first makes an edge fire at most once, whatever the
 * side-effects do.
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
    private readonly nameRepair: TorrentNameRepairService,
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
        withTimeout(provider.listTorrents(), `${provider.engineId} listTorrents`),
        withTimeout(provider.getGlobalStats(), `${provider.engineId} getGlobalStats`),
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

      // Read the baseline BEFORE overwriting it — transitions are the diff between
      // the engine and the last snapshot.
      const prior = await this.priorSnapshots(provider.engineId, torrents);
      // Then record the new state, BEFORE acting on any transition. See the class
      // docstring: acting first and persisting after lets a slow side-effect keep
      // re-arming the same edge, forever.
      await this.persistSnapshots(provider.engineId, torrents);
      await this.applyTransitions(prior, torrents);
      await this.nameRepair.repair(provider, torrents);
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
  /** The last snapshot of each torrent — the baseline a transition is measured from. */
  private async priorSnapshots(
    engineId: string,
    torrents: NormalizedTorrent[],
  ): Promise<Map<string, { hash: string; progress: number; ratio: number }>> {
    const prior = await this.prisma.torrentSnapshot.findMany({
      where: { engineId, hash: { in: torrents.map((t) => t.hash) } },
      select: { hash: true, progress: true, ratio: true },
    });
    return new Map(prior.map((p) => [p.hash, p]));
  }

  private async applyTransitions(
    priorMap: Map<string, { hash: string; progress: number; ratio: number }>,
    torrents: NormalizedTorrent[],
  ): Promise<void> {
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
        // A throw here used to abort the whole tick — skipping the name repair and
        // the engine-status broadcast — for a notification nobody reads.
        await this.notifications
          .dispatch({
            level: 'success',
            title: 'Download complete',
            message: t.name,
            eventType: 'torrent.completed',
          })
          .catch((err) =>
            this.logger.warn(`Completion notification failed: ${err.message}`),
          );
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
        // Post-download Media Manager workflow (opt-in, best-effort). DETACHED, not
        // awaited: it is a scan → identify → metadata → artwork → subtitles → rename
        // pipeline that runs for minutes and reaches out to metadata providers. It has
        // no business blocking a 2-second tick, and blocking it is what let a single
        // repeating edge run the pipeline 5,284 times and then wedge the sync loop on
        // an external fetch. It queues its own jobs, so nothing here needs its result.
        void this.mediaProcessing
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

    // Drop snapshots for torrents this engine no longer has. Without this the
    // table only ever grows: every torrent ever removed from the engine stays
    // behind forever, and the consumers of these rows (search, and acquisition's
    // "do we already have this?" dedupe) go on matching torrents that are gone.
    //
    // Safe to run with an empty list: `listTorrents()` throwing is handled by the
    // caller, so reaching here with zero torrents means the engine genuinely has
    // none, and its snapshots *should* all go.
    await this.prisma.torrentSnapshot.deleteMany({
      where: { engineId, hash: { notIn: torrents.map((t) => t.hash) } },
    });
  }
}
