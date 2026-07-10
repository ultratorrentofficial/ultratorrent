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
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { statfs } from 'node:fs/promises';
import * as os from 'node:os';
import { PERMISSIONS, NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS } from '@ultratorrent/shared';
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
  /** Conditions currently in an alerting state (edge-fire: emit once on cross). */
  private alerting = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly config: ConfigService,
    private readonly eventBus: EventEmitter2,
  ) {}

  /**
   * Periodic resource-health monitor. Emits `system.disk_space_low` / `cpu_high`
   * / `memory_high` on the rising edge only (and clears on recovery), so rules
   * fire once per incident rather than every minute.
   */
  @Interval('system_health_monitor', 60_000)
  async monitorHealth(): Promise<void> {
    try {
      const emit = (key: string, event: string, payload: Record<string, unknown>) => {
        if (!this.alerting.has(key)) {
          this.alerting.add(key);
          this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, { event, payload, at: new Date().toISOString() });
        }
      };
      const clear = (key: string) => this.alerting.delete(key);

      // Disk: any root under 10% free.
      const roots = this.config.get<string[]>('fileManager.roots') ?? [];
      for (const path of roots) {
        try {
          const fs = await statfs(path);
          const total = fs.blocks * fs.bsize;
          const freePct = total ? (fs.bfree * fs.bsize) / total * 100 : 100;
          if (freePct < 10) emit(`disk:${path}`, NOTIFICATION_EVENTS.SYSTEM_DISK_SPACE_LOW, { mediaTitle: path, path, freePercent: Math.round(freePct) });
          else clear(`disk:${path}`);
        } catch { /* unavailable root — ignore */ }
      }

      // CPU: 1-min load average per core > 0.9.
      const loadPct = os.loadavg()[0] / Math.max(1, os.cpus().length) * 100;
      if (loadPct > 90) emit('cpu', NOTIFICATION_EVENTS.SYSTEM_CPU_HIGH, { mediaTitle: 'CPU', loadPercent: Math.round(loadPct) });
      else clear('cpu');

      // Memory: system memory > 90% used.
      const memPct = os.totalmem() ? (1 - os.freemem() / os.totalmem()) * 100 : 0;
      if (memPct > 90) emit('mem', NOTIFICATION_EVENTS.SYSTEM_MEMORY_HIGH, { mediaTitle: 'Memory', usedPercent: Math.round(memPct) });
      else clear('mem');
    } catch { /* health monitor must never throw */ }
  }

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
  providers: [SystemService, SystemUpdateService],
  controllers: [SystemController],
})
export class SystemModule {}
