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
   * Refresh `MediaServerUser` from two sources: durable watch history (one row per
   * (connection, userName) with play count + last-seen, provider-agnostic and
   * always available), then each enabled connection's provider account list, which
   * adds users who have never watched anything and fills in an email where the
   * server holds one (Plex). A user's email is only written when the row has none,
   * so an email an admin typed by hand (see {@link setUserEmail}) is never
   * clobbered by a later sync.
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

      // Pull provider accounts so users who have never watched still appear (and so
      // Plex emails land). One unreachable/unsupported connection never aborts the
      // sweep — it just contributes no users.
      const connections = await this.prisma.mediaServerIntegration.findMany({ where: { isEnabled: true } });
      for (const conn of connections) {
        await this.syncConnectionUsers(conn.id).catch((err) => {
          this.logger.warn(`Provider user pull failed for ${conn.id}: ${(err as Error).message}`);
        });
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

  /**
   * Upsert one connection's provider accounts into `MediaServerUser`, then collapse
   * rows that turn out to be the same person.
   *
   * Matching is by `providerUserId` FIRST, `userName` only as a fallback. This is
   * load-bearing: a user's watch-history row is keyed on the session DISPLAY name
   * ("Madeline Ayala") while their provider account comes back under the account
   * HANDLE ("madeline24") — same id, different name. Matching on name alone spawned
   * a second row and left the heavily-watched one with no email. Email is written
   * only when the row has none, so a hand-entered address survives.
   */
  private async syncConnectionUsers(connectionId: string): Promise<number> {
    const result = await this.integrations.users(connectionId);
    if (!result.supported) return 0;
    let upserted = 0;
    for (const u of result.users) {
      const existing =
        (u.providerUserId
          ? await this.prisma.mediaServerUser.findFirst({ where: { connectionId, providerUserId: u.providerUserId } })
          : null) ?? (await this.prisma.mediaServerUser.findFirst({ where: { connectionId, userName: u.userName } }));
      if (existing) {
        await this.prisma.mediaServerUser.update({
          where: { id: existing.id },
          data: {
            providerUserId: existing.providerUserId ?? u.providerUserId,
            // Keep the display name already on the row — it reads better in the
            // picker than the account handle. Never overwrite an existing email.
            email: existing.email ?? u.email ?? undefined,
          },
        });
      } else {
        await this.prisma.mediaServerUser.create({
          data: { connectionId, userName: u.userName, providerUserId: u.providerUserId, email: u.email ?? undefined },
        });
      }
      upserted += 1;
    }
    await this.dedupeUsersByProviderId(connectionId);
    return upserted;
  }

  /**
   * Collapse rows in one connection that share a `providerUserId` — the same person
   * recorded once under their session display name and once under their account
   * handle. Keep the most-played row, carry an email onto it, drop the rest. Runs
   * every sync so it also heals duplicates a past name-only match created.
   */
  private async dedupeUsersByProviderId(connectionId: string): Promise<void> {
    const rows = await this.prisma.mediaServerUser.findMany({ where: { connectionId, providerUserId: { not: null } } });
    const byId = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!r.providerUserId) continue; // defensive — the query already excludes nulls
      const arr = byId.get(r.providerUserId) ?? [];
      arr.push(r);
      byId.set(r.providerUserId, arr);
    }
    for (const group of byId.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.plays - a.plays);
      const [keep, ...dupes] = group;
      const email = keep.email ?? dupes.find((d) => d.email)?.email ?? null;
      if (email !== keep.email) {
        await this.prisma.mediaServerUser.update({ where: { id: keep.id }, data: { email } });
      }
      await this.prisma.mediaServerUser.deleteMany({ where: { id: { in: dupes.map((d) => d.id) } } });
    }
  }

  /**
   * Set (or clear) a synced user's email by hand — for servers whose accounts carry
   * no email (Jellyfin/Emby). Clearing it (empty string) lets a later provider sync
   * repopulate it. Returns the updated row.
   */
  async setUserEmail(userId: string, email: string | null) {
    const trimmed = (email ?? '').trim();
    return this.prisma.mediaServerUser.update({
      where: { id: userId },
      data: { email: trimmed || null },
    });
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
