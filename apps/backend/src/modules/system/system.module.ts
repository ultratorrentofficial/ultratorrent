import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'node:fs/promises';
import * as os from 'node:os';
import { PERMISSIONS } from '@ultratorrent/shared';
import { StorageWatchService } from './storage-watch.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { SettingsModule } from '../settings/settings.module';
import { SystemUpdateService } from './system-update.service';
import { resolveBuildInfo } from '../../config/build-info';

@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly config: ConfigService,
  ) {}

  async liveness() {
    return { status: 'ok', uptime: process.uptime() };
  }

  /** Product/edition version — drives the UI version badge and ops tooling. */
  version() {
    const version = this.config.get<string>('node.productVersion') ?? '0.10.0';
    // Git commit / tag / build-time resolve env (Docker build args) → baked-in
    // build-info.json → null, so the badge can ALWAYS render `v<version> -
    // (<short-sha>)` even for a plain `docker compose build`. See config/build-info.ts.
    const build = resolveBuildInfo();
    return {
      product: 'UltraTorrent',
      version,
      edition: this.config.get<string>('edition') ?? 'community',
      apiVersion: 'v1',
      // Exact `git describe` tag when known; otherwise fall back to the tag
      // implied by VERSION (`v<version>`) — every commit is tagged vX.Y.Z.
      gitTag: build.gitTag || `v${version}`,
      gitSha: build.gitSha,
      buildTime: build.buildTime,
      node: process.version,
    };
  }

  async readiness() {
    let db = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      db = false;
    }
    return { status: db ? 'ok' : 'degraded', database: db };
  }

  async health() {
    const engines = await Promise.all(
      this.registry.list().map(async (p) => ({
        engineId: p.engineId,
        kind: p.kind,
        ...(await p.healthCheck()),
      })),
    );

    const roots = this.config.get<string[]>('fileManager.roots') ?? [];
    const disks = await Promise.all(
      roots.map(async (path) => {
        try {
          const fs = await statfs(path);
          const total = fs.blocks * fs.bsize;
          // `bavail`, not `bfree`: the root-reserved blocks (5% by default on
          // ext4) are not space anything here can use, and this is the figure
          // `df` calls "Avail".
          const free = fs.bavail * fs.bsize;
          return { path, total, free, used: total - free };
        } catch {
          return { path, total: 0, free: 0, used: 0, error: 'unavailable' };
        }
      }),
    );

    return {
      process: {
        uptime: process.uptime(),
        memory: process.memoryUsage().rss,
        nodeVersion: process.version,
        load: os.loadavg(),
        cpus: os.cpus().length,
      },
      engines,
      disks,
    };
  }
}

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly update: SystemUpdateService,
  ) {}

  @Public()
  @Get('live')
  live() {
    return this.system.liveness();
  }

  @Public()
  @Get('ready')
  ready() {
    return this.system.readiness();
  }

  @Public()
  @Get('version')
  version() {
    return this.system.version();
  }

  @Get('health')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SYSTEM_VIEW)
  health() {
    return this.system.health();
  }

  /** Whether a newer release is available + how to apply it for this deployment. */
  @Get('update')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SYSTEM_VIEW)
  updateStatus() {
    return this.update.getStatus();
  }

  /** Force a fresh update check now. */
  @Post('update/check')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SYSTEM_VIEW)
  checkUpdate() {
    return this.update.checkNow();
  }

  /** Enable/disable the background update check (super-admin). */
  @Patch('update/settings')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions(PERMISSIONS.SYSTEM_MANAGE)
  setUpdateCheck(@Body() dto: { enabled?: boolean }) {
    return this.update.setEnabled(Boolean(dto?.enabled));
  }
}

@Module({
  imports: [SettingsModule],
  providers: [StorageWatchService, SystemService, SystemUpdateService],
  controllers: [SystemController],
})
export class SystemModule {}
