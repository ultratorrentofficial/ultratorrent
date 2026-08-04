import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { SettingsService } from '../settings/settings.module';
import { SchedulerCapabilityService } from './scheduler-capability.service';
import { SchedulerPreviewService } from './scheduler-preview.service';
import { canDo } from './domain/capabilities';

/**
 * Turning enforcement on, and off again.
 *
 * Enabling managed scheduling is the moment UltraTorrent starts pausing other
 * people's torrents, so it is a guarded workflow rather than a toggle:
 *
 *  1. the engine must actually be able to pause,
 *  2. a preview is generated from the CURRENT queue,
 *  3. conflicts are reported — including our own parking service, which pauses
 *     torrents for its own reasons,
 *  4. the operator confirms that specific outcome,
 *  5. only then does the mode change.
 *
 * Step 4 exists because a count is not a decision. "This will pause 34 torrents"
 * is information an operator must be shown before it happens, not discovered
 * afterwards in an audit log.
 */
export interface ActivationPreview {
  engineId: string;
  /** Refuses activation outright when non-empty. */
  blockers: Array<{ code: string; messageKey: string }>;
  /** Allows activation, but the operator should know. */
  warnings: Array<{ code: string; messageKey: string; values?: Record<string, unknown> }>;
  wouldPause: number;
  wouldResume: number;
  totalTorrents: number;
}

@Injectable()
export class SchedulerActivationService {
  private readonly logger = new Logger(SchedulerActivationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: EngineRegistryService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly capabilities: SchedulerCapabilityService,
    private readonly preview: SchedulerPreviewService,
  ) {}

  /** What enabling managed scheduling would do, right now. */
  async describe(engineId: string): Promise<ActivationPreview> {
    let kind;
    try {
      kind = this.registry.get(engineId).kind;
    } catch {
      throw new NotFoundException(`Unknown engine: ${engineId}`);
    }

    const caps = this.capabilities.for(kind);
    const blockers: ActivationPreview['blockers'] = [];
    const warnings: ActivationPreview['warnings'] = [];

    // Without pause there is no queue management at all — everything else is moot.
    if (!canDo(caps.pause) || !canDo(caps.resume)) {
      blockers.push({
        code: 'engine_cannot_pause',
        messageKey: 'scheduler.activation.blocker.engine_cannot_pause',
      });
    }

    if (!canDo(caps.reportsQueuedState)) {
      warnings.push({
        code: 'queued_state_inferred',
        messageKey: 'scheduler.activation.warning.queued_state_inferred',
      });
    }
    if (caps.forceStart === 'approximated') {
      warnings.push({
        code: 'force_start_approximated',
        messageKey: 'scheduler.activation.warning.force_start_approximated',
      });
    }

    /*
     * The conflict that actually bites: `TorrentParkingService` also pauses and
     * resumes torrents on this engine, for a reason the scheduler deliberately
     * does not own. They coexist — the planner treats a parked torrent as
     * untouchable — but an operator enabling a second system that pauses things
     * deserves to be told the first one is running.
     */
    const parking = await this.settings
      .get<{ enabled?: boolean }>('torrents.parking')
      .catch(() => null);
    if (parking?.enabled) {
      warnings.push({
        code: 'parking_also_enabled',
        messageKey: 'scheduler.activation.warning.parking_also_enabled',
      });
    }

    const plan = await this.preview.previewEngine(engineId);
    const decisions = plan?.decisions ?? [];

    // No policies means every limit is unlimited, so the plan is empty and
    // activation would change nothing. Worth saying: an operator who enables
    // enforcement and sees no effect should know why.
    const policyCount = await this.prisma.torrentSchedulerPolicy.count({ where: { enabled: true } });
    if (policyCount === 0) {
      warnings.push({
        code: 'no_policies',
        messageKey: 'scheduler.activation.warning.no_policies',
      });
    }

    return {
      engineId,
      blockers,
      warnings,
      wouldPause: decisions.filter((d) => d.action === 'pause').length,
      wouldResume: decisions.filter((d) => d.action === 'resume').length,
      totalTorrents: decisions.length,
    };
  }

  /**
   * Enable enforcement, having shown the operator what it will do.
   *
   * `confirm` is required and unforgiving: a client that omits it gets a 400
   * carrying the preview, so the only way to reach enforcement is to have asked
   * for it twice.
   */
  async activate(engineId: string, confirm: boolean, userId?: string) {
    const description = await this.describe(engineId);

    if (description.blockers.length) {
      throw new BadRequestException(
        `This engine cannot be managed: ${description.blockers.map((b) => b.code).join(', ')}`,
      );
    }
    if (!confirm) {
      throw new BadRequestException(
        `Managed scheduling would pause ${description.wouldPause} and resume `
          + `${description.wouldResume} torrent(s) on this engine. Confirm to proceed.`,
      );
    }

    const now = new Date();
    const saved = await this.prisma.torrentSchedulerEngineConfig.upsert({
      where: { engineId },
      create: {
        engineId,
        mode: 'managed',
        modeChangedAt: now,
        modeChangedBy: userId ?? null,
        // Honest record: neither shipped engine exposes its queue settings
        // through this provider interface, so there is nothing to restore later
        // and the snapshot says so rather than pretending to hold a backup.
        nativeSettingsSnapshot: {
          captured: false,
          reason: 'This engine does not expose its queue settings through the provider interface.',
        },
        nativeSettingsSnapshotAt: now,
      },
      update: {
        mode: 'managed',
        modeChangedAt: now,
        modeChangedBy: userId ?? null,
      },
    });

    await this.audit.record({
      userId,
      action: 'torrent_scheduler.activated',
      objectType: 'torrent_engine',
      objectId: engineId,
      result: 'success',
      metadata: {
        wouldPause: description.wouldPause,
        wouldResume: description.wouldResume,
        warnings: description.warnings.map((w) => w.code),
      },
    });

    this.logger.log(
      `Managed scheduling enabled for ${engineId} — expects to pause ${description.wouldPause}, `
        + `resume ${description.wouldResume}.`,
    );
    return saved;
  }

  /**
   * Stop enforcing.
   *
   * Torrents the scheduler paused stay paused unless the operator asks for them
   * back. Blanket-resuming would start downloads nobody chose to start, on an
   * engine whose own limits are about to take over again — and some of those
   * pauses will look identical to ones a person made. So the count is reported
   * and the resume is a separate, explicit request.
   */
  async deactivate(engineId: string, resumePaused: boolean, userId?: string) {
    try {
      this.registry.get(engineId);
    } catch {
      throw new NotFoundException(`Unknown engine: ${engineId}`);
    }

    const held = await this.prisma.torrentSchedulerState.findMany({
      where: { engineId, schedulerPausedAt: { not: null } },
      select: { hash: true },
    });

    const now = new Date();
    await this.prisma.torrentSchedulerEngineConfig.upsert({
      where: { engineId },
      create: { engineId, mode: 'native', modeChangedAt: now, modeChangedBy: userId ?? null },
      update: { mode: 'native', modeChangedAt: now, modeChangedBy: userId ?? null },
    });

    let resumed = 0;
    if (resumePaused && held.length) {
      const provider = this.registry.get(engineId);
      for (const { hash } of held) {
        try {
          await provider.resumeTorrent(hash);
          resumed += 1;
        } catch (err) {
          // Best-effort and per-torrent: one refusal must not strand the rest.
          this.logger.warn(`Could not resume ${hash.slice(0, 8)}: ${(err as Error).message}`);
        }
      }
      await this.prisma.torrentSchedulerState.deleteMany({ where: { engineId } });
    }

    await this.audit.record({
      userId,
      action: 'torrent_scheduler.deactivated',
      objectType: 'torrent_engine',
      objectId: engineId,
      result: 'success',
      metadata: { heldPaused: held.length, resumed, resumeRequested: resumePaused },
    });

    return { mode: 'native' as const, heldPaused: held.length, resumed };
  }
}
