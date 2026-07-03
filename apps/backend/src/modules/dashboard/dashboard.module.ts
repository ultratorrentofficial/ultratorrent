import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS, TorrentState } from '@ultratorrent/shared';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@Injectable()
export class DashboardService {
  constructor(
    private readonly registry: EngineRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  async summary(engineId?: string) {
    const provider = await this.registry.resolve(engineId).catch(() => null);
    const [torrents, stats] = provider
      ? await Promise.all([
          provider.listTorrents().catch(() => []),
          provider.getGlobalStats().catch(() => null),
        ])
      : [[], null];

    const byState = (s: TorrentState) =>
      torrents.filter((t) => t.state === s).length;

    const totalUploaded = torrents.reduce((a, t) => a + t.uploaded, 0);
    const totalDownloaded = torrents.reduce((a, t) => a + t.downloaded, 0);

    return {
      engineOnline: Boolean(provider),
      downloadRate: stats?.downloadRate ?? 0,
      uploadRate: stats?.uploadRate ?? 0,
      totalTorrents: torrents.length,
      downloading: byState(TorrentState.DOWNLOADING),
      paused: byState(TorrentState.PAUSED) + byState(TorrentState.STOPPED),
      completed: torrents.filter((t) => t.progress >= 1).length,
      seeding: byState(TorrentState.SEEDING),
      errored: byState(TorrentState.ERROR),
      ratio: totalDownloaded > 0 ? totalUploaded / totalDownloaded : 0,
      totalUploaded,
      totalDownloaded,
    };
  }

  async recentActivity(limit = 15) {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { username: true } } },
    });
  }
}

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  summary(@Query('engineId') engineId?: string) {
    return this.dashboard.summary(engineId);
  }

  @Get('activity')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  activity() {
    return this.dashboard.recentActivity();
  }
}

@Module({
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
