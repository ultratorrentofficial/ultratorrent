import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MediaServerIntegrationService } from './media-server-integration.service';

const TICK_MS = 5 * 60_000;

/**
 * Periodically probes every enabled media-server integration and persists whether
 * it is reachable.
 *
 * Without this, a media server was only ever contacted *incidentally* — the library
 * refresh runs from the download pipeline, so it fires when a torrent completes and
 * at no other time. A server that died while downloads were idle went unnoticed
 * indefinitely, and even once downloads resumed the failures only landed in the
 * audit log: nothing wrote `status`, so the dashboard kept reporting `online`.
 * (Observed: a Plex that had been down for four days, 479 consecutive refresh
 * failures, still shown as healthy.)
 *
 * A five-minute poll makes "is the server up?" a question the app answers on its
 * own schedule rather than as a side effect of downloading. Only transitions are
 * logged — a server that is simply still up, or still down, says nothing, so the
 * log carries signal instead of a heartbeat. Runs are serialised via `running` so a
 * slow/timing-out server never overlaps the next tick, and each integration is
 * isolated so one unreachable server never prevents the others from being checked.
 */
@Injectable()
export class MediaServerHealthScheduler {
  private readonly logger = new Logger(MediaServerHealthScheduler.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: MediaServerIntegrationService,
  ) {}

  @Interval('media_server_health_check', TICK_MS)
  async tick(): Promise<void> {
    // Claim the run synchronously (before any await), so a tick firing while a
    // previous one is still waiting on a timing-out server bails out immediately.
    if (this.running) return;
    this.running = true;
    try {
      let rows: Array<{ id: string; name: string; status: string | null }>;
      try {
        rows = await this.prisma.mediaServerIntegration.findMany({
          where: { isEnabled: true },
          select: { id: true, name: true, status: true },
        });
      } catch (err) {
        this.logger.warn(`Could not load integrations for health check: ${(err as Error).message}`);
        return;
      }

      for (const row of rows) {
        try {
          // healthCheck persists status/lastHealthCheckAt itself; `before` is the
          // status as of this tick, so we can report only the edges.
          const before = row.status;
          const info = await this.integrations.healthCheck(row.id);
          const after = info.reachable ? 'online' : 'offline';
          if (before === after) continue;

          if (info.reachable) {
            this.logger.log(`Media server "${row.name}" is reachable again.`);
          } else {
            this.logger.warn(
              `Media server "${row.name}" is unreachable: ${info.message ?? 'no response'}`,
            );
          }
        } catch (err) {
          this.logger.warn(`Health check for "${row.name}" failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
