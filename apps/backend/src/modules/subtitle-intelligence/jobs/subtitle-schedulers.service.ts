/**
 * Background schedulers (@nestjs/schedule `@Interval`). Two jobs keep subtitle
 * libraries healthy without any user action:
 *
 *   subtitle_provider_health — hourly liveness + quota refresh for enabled
 *                              providers (a no-op when none are configured).
 *   subtitle_missing_scan    — opt-in periodic missing-subtitle sweep, gated on
 *                              `media.subtitles.autoScanIntervalMinutes`.
 *
 * Each guards re-entrancy with a flag claimed SYNCHRONOUSLY before the first
 * await, and isolates every unit of work so one failure never blocks the rest —
 * the convention every other scheduler in the codebase follows.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../../settings/settings.module';
import { SubtitleProviderRegistry } from '../providers/provider-registry.service';
import { SubtitleProviderSettingsService } from '../providers/subtitle-provider-settings.service';
import { SubtitleMissingScanService } from './subtitle-missing-scan.service';

const HEALTH_TICK_MS = 60 * 60_000; // hourly
const SCAN_TICK_MS = 5 * 60_000; // 5-min tick; acts only when the interval is due
export const AUTO_SCAN_INTERVAL_KEY = 'media.subtitles.autoScanIntervalMinutes';

@Injectable()
export class SubtitleSchedulers {
  private readonly logger = new Logger(SubtitleSchedulers.name);
  private healthRunning = false;
  private scanRunning = false;
  private lastScanAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly registry: SubtitleProviderRegistry,
    private readonly providerSettings: SubtitleProviderSettingsService,
    private readonly missingScan: SubtitleMissingScanService,
  ) {}

  @Interval('subtitle_provider_health', HEALTH_TICK_MS)
  async providerHealth(): Promise<void> {
    if (this.healthRunning) return;
    this.healthRunning = true;
    try {
      const providers = await this.registry.build();
      for (const p of providers) {
        try {
          const health = await p.healthCheck();
          await this.providerSettings.recordHealth(p.name, health);
        } catch (err) {
          this.logger.warn(`health check for ${p.name} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.healthRunning = false;
    }
  }

  @Interval('subtitle_missing_scan', SCAN_TICK_MS)
  async missingScanSweep(): Promise<void> {
    if (this.scanRunning) return;
    const intervalMin = await this.settings.get<number>(AUTO_SCAN_INTERVAL_KEY);
    if (!intervalMin || intervalMin <= 0) return; // opt-in; off by default
    if (Date.now() - this.lastScanAt < intervalMin * 60_000) return;

    this.scanRunning = true;
    this.lastScanAt = Date.now();
    try {
      const libraries = await this.prisma.mediaLibrary.findMany({ where: { isEnabled: true } });
      for (const lib of libraries) {
        try {
          await this.missingScan.scanLibrary(lib.id);
        } catch (err) {
          this.logger.warn(`missing scan for library ${lib.id} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.scanRunning = false;
    }
  }
}
