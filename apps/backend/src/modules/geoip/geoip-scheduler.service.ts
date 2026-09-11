import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SettingsService } from '../settings/settings.module';
import { GeoIpSettingsService } from './geoip-settings.service';
import { GeoIpDownloaderService, type GeoIpUpdateResult } from './geoip-downloader.service';

const STATE_KEY = 'geoip.state';

/**
 * Keeps the GeoLite2 databases current, the way the IMDb dataset scheduler keeps
 * its datasets current: on an interval, when the operator has turned auto-update
 * on and supplied MaxMind credentials, it refreshes if enough time has passed
 * since the last run — or immediately the first time, when no database is on disk
 * yet. It never runs when unconfigured or disabled, so a fresh install makes no
 * outbound call. The heartbeat is hourly; the operator's `updateIntervalHours`
 * decides how often a heartbeat actually downloads.
 */
@Injectable()
export class GeoIpSchedulerService {
  private readonly logger = new Logger(GeoIpSchedulerService.name);

  constructor(
    private readonly settings: GeoIpSettingsService,
    private readonly downloader: GeoIpDownloaderService,
    private readonly store: SettingsService,
  ) {}

  @Interval('geoip_db_refresh', 3_600_000)
  async scheduledRefresh(): Promise<void> {
    try {
      const cfg = await this.settings.read();
      if (!cfg.autoUpdate || !cfg.accountId || !cfg.licenseKey) return;
      if (this.downloader.isUpdating) return;

      const last = await this.store.get<GeoIpUpdateResult>(STATE_KEY);
      const dueMs = cfg.updateIntervalHours * 3_600_000;
      const elapsed = last ? Date.now() - new Date(last.ranAt).getTime() : Infinity;
      // A prior success that has not yet aged out means nothing to do.
      if (last?.ok && elapsed < dueMs) return;

      this.logger.log('GeoIP databases due for a refresh — starting.');
      await this.downloader.updateNow();
    } catch (err) {
      this.logger.warn(`GeoIP scheduled refresh failed: ${(err as Error).message}`);
    }
  }
}
