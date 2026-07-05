import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';

/**
 * Media Server Analytics. Phase 1 provides the module foundation: a dashboard
 * over the (reused) media-server connections and their health, delegating
 * connection storage/secrets to the existing `MediaServerIntegrationService`.
 * Live activity, watch history, analytics, newsletters and Tautulli import land
 * in later phases.
 */
@Injectable()
export class MediaServerAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: MediaServerIntegrationService,
  ) {}

  async dashboard() {
    const servers = await this.prisma.mediaServerIntegration.findMany({ orderBy: { name: 'asc' } });
    const byKind: Record<string, number> = {};
    for (const s of servers) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    return {
      servers: {
        total: servers.length,
        enabled: servers.filter((s) => s.isEnabled).length,
        online: servers.filter((s) => s.status === 'online').length,
        offline: servers.filter((s) => s.status === 'offline').length,
        byKind,
      },
      connections: servers.map((s) => this.safe(s)),
      // Populated by later phases (live activity / watch history / newsletters / imports):
      liveSessions: 0,
      recentlyAdded: 0,
      newsletters: { active: 0 },
      imports: { configured: 0 },
    };
  }

  async connection(id: string) {
    const found = ((await this.integrations.list()) as Array<{ id: string }>).find((c) => c.id === id);
    if (!found) throw new NotFoundException('Connection not found');
    return found;
  }

  /** Completed playback, most recent first. */
  watchHistory(limit = 200) {
    return this.prisma.mediaServerWatchHistory.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }

  /** Safe projection — never includes the encrypted `config` blob. */
  private safe(s: {
    id: string; name: string; kind: string; isEnabled: boolean; isDefault: boolean;
    status: string | null; serverVersion: string | null; platform: string | null;
    capabilities: unknown; lastHealthCheckAt: Date | null; lastRefreshAt: Date | null; notes: string | null;
  }) {
    return {
      id: s.id, name: s.name, kind: s.kind, enabled: s.isEnabled, isDefault: s.isDefault,
      status: s.status ?? 'unknown', serverVersion: s.serverVersion, platform: s.platform,
      capabilities: s.capabilities, lastHealthCheckAt: s.lastHealthCheckAt,
      lastRefreshAt: s.lastRefreshAt, notes: s.notes,
    };
  }
}
