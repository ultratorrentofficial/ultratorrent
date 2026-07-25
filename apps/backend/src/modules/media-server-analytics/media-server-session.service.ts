import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MODULE_IDS, NOTIFICATION_BUS_CHANNEL, NOTIFICATION_EVENTS } from '@ultratorrent/shared';
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
    private readonly eventBus: EventEmitter2,
  ) {}

  /** Publish a domain event onto the Notification Center bus (fire-and-forget). */
  private emit(event: string, payload: Record<string, unknown>): void {
    this.eventBus.emit(NOTIFICATION_BUS_CHANNEL, { event, payload, at: new Date().toISOString() });
  }

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

  /**
   * Proxy the poster recorded on one user's notification.
   *
   * A "stopped watching" card outlives its session — the row is deleted the moment
   * playback ends — so resolving artwork through the session would 404 on exactly
   * the notification that needs it. The connection and provider path are recorded
   * on the notification instead, and re-fetched here under the provider's
   * credentials.
   *
   * The path is read from the STORED payload, never from the request: a caller
   * cannot supply one, so this cannot be turned into a fetch-anything proxy. The
   * `userId` filter is the ownership check — someone else's notification id simply
   * does not match, and the caller cannot tell "not yours" from "no artwork".
   */
  async notificationArtwork(
    userId: string,
    notificationId: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const row = await this.prisma.userNotification.findFirst({
      where: { id: notificationId, userId },
      select: { payload: true },
    });
    if (!row) return null;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const connectionId = payload.connectionId;
    const artPath = payload.artPath;
    if (typeof connectionId !== 'string' || typeof artPath !== 'string' || !artPath) return null;
    return this.integrations.fetchArtwork(connectionId, artPath);
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
          // Identity of what is playing, as the media server already knows it.
          // The scrobbler reads these: a title alone cannot tell Trakt which
          // episode of which show was watched.
          showTitle: s.showTitle ?? null,
          seasonNumber: s.seasonNumber ?? null,
          episodeNumber: s.episodeNumber ?? null,
          year: s.year ?? null,
          externalIds:
            s.externalIds && Object.keys(s.externalIds).length ? s.externalIds : undefined,
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
          const startPayload = {
            mediaTitle: s.title, episodeTitle: null, mediaType: s.mediaType ?? null,
            userDisplayName: s.userName, userId: s.userId ?? null,
            serverName: conn.name ?? conn.id, libraryName: s.libraryName ?? null,
            device: s.device ?? null, client: s.client ?? null,
            playbackMethod: s.playbackMethod ?? null, resolution: s.resolution ?? null,
            videoCodec: s.videoCodec ?? null, audioCodec: s.audioCodec ?? null, bitrate: s.bitrateKbps ?? null,
            // Show identity and year let a notification render "The Last of Us -
            // S01E03" or "Dune (2021)" rather than the joined display string.
            showTitle: s.showTitle ?? null,
            seasonNumber: s.seasonNumber ?? null,
            episodeNumber: s.episodeNumber ?? null,
            year: s.year ?? null,
            playbackState: s.playbackState ?? null,
            progressPercent: s.progressPercent ?? null,
            // Artwork is carried as connection + provider path, never a URL: the
            // path is only fetchable through that connection's credentials, so
            // storing it grants nothing on its own.
            connectionId: conn.id,
            artPath: s.artPath ?? null,
            // Deliberately NOT ipAddress. No notification renders it, and the
            // payload is stored on every recipient's row.
            startedAt: new Date().toISOString(),
          };
          this.emit(NOTIFICATION_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, startPayload);
          if ((s.playbackMethod ?? '').toLowerCase().includes('transcode')) {
            this.emit(NOTIFICATION_EVENTS.MEDIA_SERVER_TRANSCODE_DETECTED, startPayload);
          }
        }
      }

      // Sessions that vanished since the last poll → completed playback.
      const current = await this.prisma.mediaServerSession.findMany({ where: { connectionId: conn.id } });
      for (const c of current) {
        if (!seen.has(c.providerSessionId)) {
          await this.endSession(c, conn.name ?? conn.id);
          ended += 1;
        }
      }
    }
    return { connections: connections.length, active, ended };
  }

  private async endSession(c: MediaServerSession, serverName: string): Promise<void> {
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
    this.emit(NOTIFICATION_EVENTS.MEDIA_SERVER_USER_FINISHED_WATCHING, {
      mediaTitle: c.title, mediaType: c.mediaType, userDisplayName: c.userName, userId: c.providerUserId ?? null,
      libraryName: c.libraryName ?? null, watchedSeconds, completionPercent: c.progressPercent ?? null,
      serverName,
      showTitle: c.showTitle, seasonNumber: c.seasonNumber, episodeNumber: c.episodeNumber, year: c.year,
      device: c.device, client: c.client,
      // The session row is deleted immediately below, so the stop notification
      // cannot resolve artwork through it. Carrying the connection and art path
      // on the event is what lets the card still show a poster afterwards.
      connectionId: c.connectionId,
      artPath: c.artPath,
      stoppedAt: new Date().toISOString(),
    });
  }
}
