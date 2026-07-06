import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MODULE_IDS } from '@ultratorrent/shared';
import type { MediaServerSession } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';

/**
 * Live activity + watch-history capture. A poller reconciles now-playing
 * sessions across enabled connections into `MediaServerSession` rows; when a
 * session disappears it is written to `MediaServerWatchHistory`. This is the
 * media-server-native source of watch history (Tautulli import is the other).
 */
@Injectable()
export class MediaServerSessionService {
  private readonly logger = new Logger(MediaServerSessionService.name);
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ModuleRegistryService,
  ) {}

  /** Live activity = the current reconciled session snapshot. */
  liveActivity() {
    return this.prisma.mediaServerSession.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  /** Proxy the now-playing poster for a session through the provider's auth. */
  async artwork(sessionId: string): Promise<{ body: Buffer; contentType: string } | null> {
    const session = await this.prisma.mediaServerSession.findUnique({ where: { id: sessionId } });
    if (!session?.artPath) return null;
    return this.integrations.fetchArtwork(session.connectionId, session.artPath);
  }

  private get enabled(): boolean {
    return this.registry.getStatus(MODULE_IDS.MEDIA_SERVER_ANALYTICS)?.enabled ?? false;
  }

  @Interval('media_server_session_poll', 15_000)
  async scheduledPoll(): Promise<void> {
    if (!this.enabled || this.polling) return;
    this.polling = true;
    try {
      await this.poll();
    } catch (err) {
      this.logger.warn(`Session poll failed: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  /** Reconcile sessions across every enabled connection. */
  async poll(): Promise<{ connections: number; active: number; ended: number }> {
    const connections = await this.prisma.mediaServerIntegration.findMany({ where: { isEnabled: true } });
    let active = 0;
    let ended = 0;
    for (const conn of connections) {
      let result;
      try {
        result = await this.integrations.sessions(conn.id);
      } catch {
        continue; // one bad server never aborts the sweep
      }
      if (!result.supported) continue;

      const seen = new Set<string>();
      for (const s of result.sessions) {
        seen.add(s.sessionId);
        active += 1;
        const data = {
          providerUserId: s.userId ?? null,
          userName: s.userName ?? null,
          title: s.title,
          mediaType: s.mediaType ?? null,
          libraryName: s.libraryName ?? null,
          device: s.device ?? null,
          client: s.client ?? null,
          ipAddress: s.ipAddress ?? null,
          playbackState: s.playbackState ?? null,
          progressPercent: s.progressPercent ?? null,
          playbackMethod: s.playbackMethod ?? null,
          videoCodec: s.videoCodec ?? null,
          audioCodec: s.audioCodec ?? null,
          resolution: s.resolution ?? null,
          container: s.container ?? null,
          bitrateKbps: s.bitrateKbps ?? null,
          artPath: s.artPath ?? null,
        };
        const existing = await this.prisma.mediaServerSession.findUnique({
          where: { connectionId_providerSessionId: { connectionId: conn.id, providerSessionId: s.sessionId } },
        });
        if (existing) {
          await this.prisma.mediaServerSession.update({ where: { id: existing.id }, data });
        } else {
          await this.prisma.mediaServerSession.create({
            data: { connectionId: conn.id, providerSessionId: s.sessionId, ...data },
          });
          this.realtime.broadcast('media_server.session.started', { connectionId: conn.id, title: s.title, userName: s.userName });
        }
      }

      // Sessions that vanished since the last poll → completed playback.
      const current = await this.prisma.mediaServerSession.findMany({ where: { connectionId: conn.id } });
      for (const c of current) {
        if (!seen.has(c.providerSessionId)) {
          await this.endSession(c);
          ended += 1;
        }
      }
    }
    return { connections: connections.length, active, ended };
  }

  private async endSession(c: MediaServerSession): Promise<void> {
    const watchedSeconds = Math.max(0, Math.round((Date.now() - c.startedAt.getTime()) / 1000));
    await this.prisma.mediaServerWatchHistory.create({
      data: {
        connectionId: c.connectionId,
        providerUserId: c.providerUserId,
        userName: c.userName,
        title: c.title,
        mediaType: c.mediaType,
        libraryName: c.libraryName,
        device: c.device,
        client: c.client,
        ipAddress: c.ipAddress,
        startedAt: c.startedAt,
        stoppedAt: new Date(),
        watchedSeconds,
        percentComplete: c.progressPercent,
        playbackMethod: c.playbackMethod,
        resolution: c.resolution,
        videoCodec: c.videoCodec,
        audioCodec: c.audioCodec,
        container: c.container,
        bitrateKbps: c.bitrateKbps,
        importSource: 'live',
      },
    });
    await this.prisma.mediaServerSession.delete({ where: { id: c.id } });
    this.realtime.broadcast('media_server.session.ended', { connectionId: c.connectionId, title: c.title });
  }
}
