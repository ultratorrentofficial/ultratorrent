import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { SchedulerCapabilityService } from './scheduler-capability.service';
import type { SchedulerMode } from './scheduler-sweep.service';

/**
 * Read and change an engine's scheduling mode.
 *
 * `managed` is refused. There is no reconciliation layer yet, so accepting it
 * would store a mode that claims enforcement and enforces nothing — an operator
 * would reasonably stop watching a queue believing the scheduler had it. A mode
 * that lies about what it does is worse than a mode that is missing, so the
 * refusal is explicit and says when it will be available.
 */
@Injectable()
export class SchedulerModeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly audit: AuditService,
    private readonly capabilities: SchedulerCapabilityService,
  ) {}

  private assertKnownEngine(engineId: string): void {
    try {
      this.registry.get(engineId);
    } catch {
      throw new NotFoundException(`Unknown engine: ${engineId}`);
    }
  }

  /** Every engine, with its mode, health and capabilities. */
  async list() {
    const configs = await this.prisma.torrentSchedulerEngineConfig.findMany();
    const byId = new Map(configs.map((c) => [c.engineId, c]));

    return this.registry.list().map((provider) => {
      const config = byId.get(provider.engineId);
      return {
        engineId: provider.engineId,
        kind: provider.kind,
        // No row means untouched, which means native.
        mode: (config?.mode ?? 'native') as SchedulerMode,
        healthState: config?.healthState ?? 'unknown',
        healthDetail: config?.healthDetail ?? null,
        lastSweepAt: config?.lastSweepAt ?? null,
        lastSuccessfulSweepAt: config?.lastSuccessfulSweepAt ?? null,
        capabilities: this.capabilities.for(provider.kind),
      };
    });
  }

  async setMode(engineId: string, mode: SchedulerMode, userId?: string) {
    this.assertKnownEngine(engineId);

    if (mode === 'managed') {
      throw new BadRequestException(
        'Managed scheduling is not available yet. The scheduler can currently observe '
          + 'and explain what it would do, but nothing applies those decisions, so this '
          + 'mode would enforce nothing while implying otherwise. Use Observe Only.',
      );
    }
    if (mode !== 'native' && mode !== 'observe') {
      throw new BadRequestException(`Unknown scheduling mode: ${mode}`);
    }

    const now = new Date();
    const saved = await this.prisma.torrentSchedulerEngineConfig.upsert({
      where: { engineId },
      create: { engineId, mode, modeChangedAt: now, modeChangedBy: userId ?? null },
      update: { mode, modeChangedAt: now, modeChangedBy: userId ?? null },
    });

    await this.audit.record({
      userId,
      action: 'torrent_scheduler.mode_changed',
      objectType: 'torrent_engine',
      objectId: engineId,
      result: 'success',
      metadata: { mode },
    });

    return saved;
  }

  /** Recent sweep outcomes for one engine, newest first. */
  history(engineId: string, limit = 50) {
    this.assertKnownEngine(engineId);
    return this.prisma.torrentSchedulerDecision.findMany({
      where: { engineId },
      orderBy: { generatedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}
