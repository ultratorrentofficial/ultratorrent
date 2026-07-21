import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

export interface ScheduleInfo {
  name: string;
  module: string;
  triggerType: 'interval' | 'cron';
  intervalMs: number | null;
  cron: string | null;
  enabled: boolean;
}

/** Known scheduler name → owning module (from the manifests' schedulerJobs + code). */
const SCHEDULE_MODULE: Record<string, string> = {
  media_server_session_poll: 'media_server_analytics',
  media_server_newsletter_dispatch: 'media_server_analytics',
  media_server_metadata_sync: 'media_server_analytics',
  notification_delivery_worker: 'notification_center',
  notification_provider_health: 'notification_center',
  media_acquisition_rss_sweep: 'media_acquisition_intelligence',
  media_acquisition_watchlist_sweep: 'media_acquisition_intelligence',
  media_acquisition_quality_upgrade_sweep: 'media_acquisition_intelligence',
  torrent_parking_sweep: 'torrents',
  system_update_check: 'system',
  system_health_monitor: 'system',
  subtitle_provider_health: 'subtitle_intelligence',
  subtitle_missing_scan: 'subtitle_intelligence',
  rss_show_status_refresh: 'rss',
  media_probe_backfill: 'media_manager',
  trakt_scrobble: 'media_manager',
  imdb_dataset_auto_update: 'media_manager',
  media_server_health_check: 'media_manager',
  media_library_periodic_scan: 'media_manager',
  platform_job_stall_detector: 'jobs_center',
};

/**
 * A read-only, honest inventory of the platform's scheduled tasks — the real
 * `@Interval`/`@Cron` jobs registered with Nest's {@link SchedulerRegistry}, enriched
 * with their owning module. Represents what actually runs; it does NOT fabricate
 * next-run/last-run/enable-disable controls the current scheduler model can't back
 * (those require wrapping each scheduler into the platform — a later step). No fake data.
 */
@Injectable()
export class PlatformSchedulesService {
  private readonly logger = new Logger(PlatformSchedulesService.name);

  constructor(private readonly scheduler: SchedulerRegistry) {}

  list(): ScheduleInfo[] {
    const out: ScheduleInfo[] = [];
    let intervalNames: string[] = [];
    try {
      intervalNames = this.scheduler.getIntervals();
    } catch (err) {
      this.logger.debug(`getIntervals failed: ${(err as Error).message}`);
    }
    for (const name of intervalNames) {
      out.push({
        name,
        module: SCHEDULE_MODULE[name] ?? this.inferModule(name),
        triggerType: 'interval',
        intervalMs: this.intervalMs(name),
        cron: null,
        enabled: true, // a registered interval is running
      });
    }
    try {
      for (const [name, job] of this.scheduler.getCronJobs()) {
        const anyJob = job as unknown as { cronTime?: { source?: string }; running?: boolean };
        out.push({
          name,
          module: SCHEDULE_MODULE[name] ?? this.inferModule(name),
          triggerType: 'cron',
          intervalMs: null,
          cron: anyJob.cronTime?.source ?? null,
          enabled: anyJob.running ?? true,
        });
      }
    } catch {
      /* no cron jobs */
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private intervalMs(name: string): number | null {
    try {
      const handle = this.scheduler.getInterval(name) as unknown as { _repeat?: number; _idleTimeout?: number };
      const ms = handle?._repeat ?? handle?._idleTimeout;
      return typeof ms === 'number' && ms >= 0 ? ms : null;
    } catch {
      return null;
    }
  }

  /** Best-effort module from a scheduler name prefix (for unmapped/auto-named intervals). */
  private inferModule(name: string): string {
    const n = name.toLowerCase();
    if (n.includes('torrent')) return 'torrents';
    if (n.includes('rss')) return 'rss';
    if (n.includes('subtitle')) return 'subtitle_intelligence';
    if (n.includes('notification')) return 'notification_center';
    if (n.includes('media_server') || n.includes('newsletter')) return 'media_server_analytics';
    if (n.includes('media') || n.includes('imdb') || n.includes('trakt') || n.includes('probe') || n.includes('library')) return 'media_manager';
    return 'system';
  }
}
