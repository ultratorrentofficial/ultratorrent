import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import { paginate, parsePage } from '../../common/pagination';

/**
 * Phase 6e sync overhaul. Normalizes provider metadata into queryable tables so
 * the dashboard filters (server / library / user) are backed by real entities:
 *   - libraries are pulled from each connection's provider (capability-aware);
 *   - users are derived from durable watch history (provider-agnostic, always
 *     available — even for Tautulli-imported history with no live connection).
 * Every run is tracked in `MediaProviderSyncRun`. One bad server never aborts
 * the sweep. Runs hourly and on demand.
 */
@Injectable()
export class MediaServerSyncService {
  private readonly logger = new Logger(MediaServerSyncService.name);
  private syncing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ModuleRegistryService,
  ) {}

  private get enabled(): boolean {
    return this.registry.getStatus(MODULE_IDS.MEDIA_SERVER_ANALYTICS)?.enabled ?? false;
  }

  @Interval('media_server_metadata_sync', 3_600_000)
  async scheduledSync(): Promise<void> {
    if (!this.enabled || this.syncing) return;
    try {
      await this.syncAll();
    } catch (err) {
      this.logger.warn(`Metadata sync failed: ${(err as Error).message}`);
    }
  }

  /** Sync libraries for every enabled connection, then refresh the user set. */
  async syncAll(): Promise<{ connections: number; librariesSynced: number; usersSynced: number }> {
    if (this.syncing) return { connections: 0, librariesSynced: 0, usersSynced: 0 };
    this.syncing = true;
    try {
      const connections = await this.prisma.mediaServerIntegration.findMany({ where: { isEnabled: true } });
      let librariesSynced = 0;
      for (const conn of connections) {
        librariesSynced += await this.syncConnectionLibraries(conn.id);
      }
      const usersSynced = await this.syncUsers();
      this.realtime.broadcast('media_server.sync.completed', { connections: connections.length, librariesSynced, usersSynced });
      return { connections: connections.length, librariesSynced, usersSynced };
    } finally {
      this.syncing = false;
    }
  }

  /** Pull the provider's libraries into `MediaServerLibrary`, pruning removed ones. */
  async syncConnectionLibraries(connectionId: string): Promise<number> {
    const run = await this.prisma.mediaProviderSyncRun.create({
      data: { connectionId, type: 'libraries', status: 'running' },
    });
    try {
      const result = await this.integrations.libraries(connectionId);
      if (!result.supported) {
        await this.prisma.mediaProviderSyncRun.update({
          where: { id: run.id },
          data: { status: 'partial', message: result.message ?? 'Libraries not supported', finishedAt: new Date() },
        });
        return 0;
      }
      const seen = new Set<string>();
      for (const lib of result.libraries) {
        seen.add(lib.id);
        const existing = await this.prisma.mediaServerLibrary.findUnique({
          where: { connectionId_providerLibraryId: { connectionId, providerLibraryId: lib.id } },
        });
        const data = { name: lib.name, type: lib.type, itemCount: lib.itemCount ?? null, lastSyncedAt: new Date() };
        if (existing) {
          await this.prisma.mediaServerLibrary.update({ where: { id: existing.id }, data });
        } else {
          await this.prisma.mediaServerLibrary.create({ data: { connectionId, providerLibraryId: lib.id, ...data } });
        }
      }
      // Prune libraries that vanished from the provider.
      const stale = await this.prisma.mediaServerLibrary.findMany({ where: { connectionId } });
      for (const lib of stale) {
        if (!seen.has(lib.providerLibraryId)) {
          await this.prisma.mediaServerLibrary.delete({ where: { id: lib.id } });
        }
      }
      await this.prisma.mediaProviderSyncRun.update({
        where: { id: run.id },
        data: { status: 'success', librariesSynced: result.libraries.length, finishedAt: new Date() },
      });
      return result.libraries.length;
    } catch (err) {
      await this.prisma.mediaProviderSyncRun.update({
        where: { id: run.id },
        data: { status: 'failed', message: (err as Error).message, finishedAt: new Date() },
      });
      this.logger.warn(`Library sync failed for ${connectionId}: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * Refresh `MediaServerUser` from durable watch history: one row per
   * (connection, userName) with play count + last-seen. Provider-agnostic.
   */
  async syncUsers(): Promise<number> {
    const run = await this.prisma.mediaProviderSyncRun.create({ data: { type: 'users', status: 'running' } });
    try {
      const grouped = await this.prisma.mediaServerWatchHistory.groupBy({
        by: ['connectionId', 'userName'],
        where: { userName: { not: null } },
        _count: { _all: true },
        _max: { startedAt: true, providerUserId: true },
      });
      let count = 0;
      for (const g of grouped) {
        const userName = g.userName;
        if (!userName) continue;
        const connectionId = g.connectionId ?? null;
        const existing = await this.prisma.mediaServerUser.findFirst({ where: { connectionId, userName } });
        const data = {
          plays: g._count._all,
          lastSeenAt: g._max.startedAt,
          providerUserId: g._max.providerUserId ?? undefined,
        };
        if (existing) {
          await this.prisma.mediaServerUser.update({ where: { id: existing.id }, data });
        } else {
          await this.prisma.mediaServerUser.create({ data: { connectionId, userName, ...data } });
        }
        count += 1;
      }
      await this.prisma.mediaProviderSyncRun.update({
        where: { id: run.id },
        data: { status: 'success', usersSynced: count, finishedAt: new Date() },
      });
      return count;
    } catch (err) {
      await this.prisma.mediaProviderSyncRun.update({
        where: { id: run.id },
        data: { status: 'failed', message: (err as Error).message, finishedAt: new Date() },
      });
      this.logger.warn(`User sync failed: ${(err as Error).message}`);
      return 0;
    }
  }

  // --- read models for the filter selectors + status panel ------------------

  /** Synced libraries, newest-synced first, for the library filter. */
  listLibraries() {
    return this.prisma.mediaServerLibrary.findMany({ orderBy: [{ name: 'asc' }] });
  }

  /** Known users (most active first) for the user filter. */
  listUsers() {
    return this.prisma.mediaServerUser.findMany({ orderBy: [{ plays: 'desc' }, { userName: 'asc' }] });
  }

  /** Recent sync runs for the status panel. */
  listRuns(page?: string, pageSize?: string) {
    return paginate(this.prisma.mediaProviderSyncRun, { orderBy: { startedAt: 'desc' } }, parsePage(page, pageSize, 20));
  }
}
