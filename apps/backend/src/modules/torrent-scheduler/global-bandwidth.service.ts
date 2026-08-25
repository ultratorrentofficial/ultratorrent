import { Injectable, Logger, BadRequestException } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EngineRegistryService } from '../engine/engine-registry.service';
import { SettingsService } from '../settings/settings.module';
import { AuditService } from '../audit/audit.service';
import { SchedulerSweepService, type SchedulerMode } from './scheduler-sweep.service';

/** Where the global ceiling lives. One key, one document, read as a whole. */
export const BANDWIDTH_SETTINGS_KEY = 'torrents.bandwidth';

/**
 * A ceiling every engine gets unless the Activity Scheduler is governing it.
 *
 * `null` means UNLIMITED, deliberately, and matches what the engines do with it:
 * qBittorrent takes 0 for "no limit". A missing settings row is a different
 * thing again — it means nobody has configured this, and nothing is pushed to
 * any engine at all. That distinction is what keeps an existing installation
 * from suddenly acquiring limits, or losing ones set in the engine's own UI,
 * the first time it runs a version that has this feature.
 */
export interface GlobalBandwidthSettings {
  maxDownloadRateKbps: number | null;
  maxUploadRateKbps: number | null;
}

/** Why an engine has, or has not, been given the global ceiling. */
export type BandwidthSource =
  | 'settings'            // the global ceiling is in force here
  | 'scheduler'           // an Activity Scheduler policy governs this engine
  | 'unconfigured'        // no global ceiling has been set
  | 'observing'           // the engine is in observe mode: never written to
  | 'unsupported';        // the engine cannot apply global rate limits

export interface EngineBandwidthStatus {
  engineId: string;
  mode: SchedulerMode;
  source: BandwidthSource;
  /** What is actually in force, as far as this service decided it. */
  maxDownloadRateKbps: number | null;
  maxUploadRateKbps: number | null;
}

/** Operators think in kbps; engines take bytes per second. */
function kbpsToBytes(kbps: number | null): number | null {
  if (kbps == null) return null;
  return Math.max(0, Math.round((kbps * 1000) / 8));
}

/**
 * The global bandwidth ceiling, and the rule for when the scheduler overrides it.
 *
 * # Precedence
 *
 * Per engine, never globally, because engines are opted into managed scheduling
 * one at a time:
 *
 *   - `managed` AND an enabled policy covers it — the SCHEDULER wins. That is
 *     what "properly configured" means here, and it is the same activation gate
 *     the rest of the scheduler already uses rather than a second notion of
 *     configured invented for this feature.
 *   - `managed` with no policy covering it — the ceiling applies. An engine
 *     put into managed mode and then left without a policy is exactly the
 *     "configured incorrectly" case, and falling back is better than an engine
 *     silently running uncapped.
 *   - `native` — the ceiling applies. Most installations are this.
 *   - `observe` — nothing is written. Observe mode's guarantee is that the
 *     scheduler makes NO provider call whatsoever, and quietly making one here
 *     would break a promise the operator relied on when choosing that mode. It
 *     is reported instead, so the reason is visible rather than mysterious.
 */
@Injectable()
export class GlobalBandwidthService {
  private readonly logger = new Logger(GlobalBandwidthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly registry: EngineRegistryService,
    private readonly sweep: SchedulerSweepService,
    private readonly audit: AuditService,
  ) {}

  /** The configured ceiling, or null when nobody has set one. */
  async get(): Promise<GlobalBandwidthSettings | null> {
    const raw = await this.settings.get<Partial<GlobalBandwidthSettings>>(BANDWIDTH_SETTINGS_KEY);
    if (!raw) return null;
    return {
      maxDownloadRateKbps: normalise(raw.maxDownloadRateKbps),
      maxUploadRateKbps: normalise(raw.maxUploadRateKbps),
    };
  }

  /**
   * Set the ceiling and put it into force immediately.
   *
   * Applied on save rather than on the next sweep: an operator who types a
   * number and sees it accepted has every reason to expect it is in effect, and
   * a sweep only visits engines that opted into scheduling at all.
   */
  async update(input: Partial<GlobalBandwidthSettings>, userId?: string): Promise<GlobalBandwidthSettings> {
    const value: GlobalBandwidthSettings = {
      maxDownloadRateKbps: validate(input.maxDownloadRateKbps, 'maxDownloadRateKbps'),
      maxUploadRateKbps: validate(input.maxUploadRateKbps, 'maxUploadRateKbps'),
    };
    await this.settings.set(BANDWIDTH_SETTINGS_KEY, value);
    await this.audit
      .record({
        userId,
        action: 'torrents.bandwidth.updated',
        objectType: 'settings',
        objectId: BANDWIDTH_SETTINGS_KEY,
      })
      .catch(() => undefined);
    await this.apply();
    return value;
  }

  /**
   * Decide, for every known engine, what governs its bandwidth.
   *
   * Shared by `apply` and by the settings screen, so what an operator is shown
   * is produced by the same code that acts. Two implementations of one rule is
   * how a screen ends up describing something the system does not do.
   */
  async plan(): Promise<EngineBandwidthStatus[]> {
    const ceiling = await this.get();
    const modes = await this.sweep.modes();
    const governed = await this.enginesGovernedByScheduler();

    return this.registry.list().map((provider) => {
      const engineId = provider.engineId;
      const mode = modes.get(engineId) ?? 'native';
      const base = { engineId, mode, maxDownloadRateKbps: null, maxUploadRateKbps: null };

      if (mode === 'managed' && governed.has(engineId)) {
        return { ...base, source: 'scheduler' as const };
      }
      if (mode === 'observe') {
        return { ...base, source: 'observing' as const };
      }
      if (!provider.setGlobalRateLimits) {
        return { ...base, source: 'unsupported' as const };
      }
      if (!ceiling) {
        return { ...base, source: 'unconfigured' as const };
      }
      return {
        engineId,
        mode,
        source: 'settings' as const,
        maxDownloadRateKbps: ceiling.maxDownloadRateKbps,
        maxUploadRateKbps: ceiling.maxUploadRateKbps,
      };
    });
  }

  /** Push the ceiling to every engine the scheduler is not governing. */
  async apply(): Promise<EngineBandwidthStatus[]> {
    const plan = await this.plan();
    for (const entry of plan) {
      if (entry.source !== 'settings') continue;
      const provider = this.registry.list().find((p) => p.engineId === entry.engineId);
      if (!provider?.setGlobalRateLimits) continue;
      try {
        await provider.setGlobalRateLimits({
          downloadBytesPerSec: kbpsToBytes(entry.maxDownloadRateKbps),
          uploadBytesPerSec: kbpsToBytes(entry.maxUploadRateKbps),
        });
      } catch (err) {
        // Never fatal. One unreachable engine must not stop the others from
        // being capped, and the operator's saved value is still correct.
        this.logger.warn(
          `Could not apply the global bandwidth ceiling on ${entry.engineId}: ${(err as Error).message}`,
        );
      }
    }
    return plan;
  }

  /**
   * Engines an enabled policy covers at global or engine scope.
   *
   * A policy row IS the configuration: within a row a NULL limit means
   * "explicitly unlimited", so a covering row means the scheduler has an
   * opinion about bandwidth even when that opinion is "no cap".
   */
  private async enginesGovernedByScheduler(): Promise<Set<string>> {
    const policies = await this.prisma.torrentSchedulerPolicy.findMany({
      where: { enabled: true, scopeType: { in: ['global', 'engine'] } },
      select: { scopeType: true, scopeId: true },
    });
    const all = this.registry.list().map((p) => p.engineId);
    const governed = new Set<string>();
    for (const policy of policies) {
      if (policy.scopeType === 'global') {
        all.forEach((id) => governed.add(id));
      } else if (policy.scopeId) {
        governed.add(policy.scopeId);
      }
    }
    return governed;
  }
}

function normalise(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A ceiling nobody can honour is worse than no ceiling: refuse it at the door. */
function validate(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} must be a number of kbps, or null for unlimited`);
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`${field} must be a whole number of kbps, or null for unlimited`);
  }
  // 0 would read as "unlimited" to qBittorrent, which is the opposite of what
  // someone typing zero into a speed limit means.
  if (value === 0) {
    throw new BadRequestException(
      `${field} of 0 would mean unlimited to the engine — leave it empty for unlimited, or set a real limit`,
    );
  }
  return value;
}
