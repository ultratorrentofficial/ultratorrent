import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ImdbService } from './imdb.service';
import { ImdbSettingsService } from './imdb-settings.service';

const HOUR_MS = 60 * 60_000;

/**
 * Periodically downloads + imports the IMDb datasets when auto-update is enabled.
 *
 * A cheap hourly tick reads the IMDb settings and does nothing unless the
 * provider uses datasets (`mode` is `dataset`/`hybrid`), `autoDownloadEnabled`
 * is on, and a `datasetPath` is configured. It runs at most once per
 * `autoUpdateIntervalHours` — "due" is computed from the most recent dataset
 * import plus an in-memory attempt clock so a fresh boot or a failed run can't
 * hammer the download host. Runs are serialised via `running` so a long
 * transfer never overlaps the next tick. (Nest `@Interval` first fires after the
 * interval, so a just-enabled config waits for the next tick — the manual
 * "update now" action exists for an immediate run.)
 */
@Injectable()
export class ImdbDatasetScheduler {
  private readonly logger = new Logger(ImdbDatasetScheduler.name);
  private running = false;
  private lastAttemptAt = 0;
  /** So the "enabled but inert" warning is logged once, not hourly. */
  private warnedInert = false;

  constructor(
    private readonly imdb: ImdbService,
    private readonly settings: ImdbSettingsService,
  ) {}

  @Interval('imdb_dataset_auto_update', HOUR_MS)
  async tick(): Promise<void> {
    if (this.running) return;

    let settings;
    try {
      settings = await this.settings.read();
    } catch (err) {
      this.logger.warn(`Could not read IMDb settings: ${(err as Error).message}`);
      return;
    }

    // A datasetPath is NOT required — runDatasetUpdate falls back to a managed
    // default location under the storage root when none is configured.
    const usesDataset = settings.mode === 'dataset' || settings.mode === 'hybrid';
    /*
     * Say why nothing is happening, once.
     *
     * `autoDownloadEnabled` with an interval reads as "this is scheduled", but
     * the provider `mode` gates it: on a live install we found auto-download on
     * and the interval set to 168h while `mode` was `disabled`, so this returned
     * on every tick for weeks with nothing to show for it. The operator has no
     * way to see a silent early return — the UI warns too, but a log line is
     * what someone reads when the UI has already been believed.
     */
    if (settings.autoDownloadEnabled && !usesDataset) {
      if (!this.warnedInert) {
        this.warnedInert = true;
        this.logger.warn(
          `IMDb auto-update is enabled (every ${settings.autoUpdateIntervalHours}h) but the provider mode is `
            + `"${settings.mode}", which does not use datasets — nothing will be imported until the mode is `
            + `"dataset" or "hybrid".`,
        );
      }
      return;
    }
    // A mode change should be able to un-silence the warning.
    this.warnedInert = false;
    if (!usesDataset || !settings.autoDownloadEnabled) return;

    const intervalMs = Math.max(1, settings.autoUpdateIntervalHours) * HOUR_MS;
    const now = Date.now();
    if (this.lastAttemptAt && now - this.lastAttemptAt < intervalMs) return;

    const last = await this.imdb.latestImportAt().catch(() => null);
    if (last && now - last.getTime() < intervalMs) return;

    this.running = true;
    this.lastAttemptAt = now;
    this.logger.log('IMDb dataset auto-update: downloading and importing datasets…');
    try {
      await this.imdb.runDatasetUpdate({});
    } catch (err) {
      this.logger.warn(`IMDb dataset auto-update failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
