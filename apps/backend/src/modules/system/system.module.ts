import {
  Controller,
  Get,
  Injectable,
  Module,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'node:fs/promises';
import * as os from 'node:os';
import { PERMISSIONS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';

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
    return {
      product: 'UltraTorrent',
      version,
      edition: this.config.get<string>('edition') ?? 'community',
      apiVersion: 'v1',
      // Exact `git describe` tag when supplied at build time (GIT_TAG); otherwise
      // fall back to the tag implied by VERSION (`v<version>`) — every commit is
      // tagged vX.Y.Z, so this matches the release.
      gitTag: process.env.GIT_TAG || `v${version}`,
      gitSha: process.env.GIT_SHA ?? null,
      buildTime: process.env.BUILD_TIME ?? null,
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
          const free = fs.bfree * fs.bsize;
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
  constructor(private readonly system: SystemService) {}

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
}

@Module({
  providers: [SystemService],
  controllers: [SystemController],
})
export class SystemModule {}
