import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DOMAIN_EVENTS, MODULE_IDS } from '@ultratorrent/shared';
import type { MediaServerSession } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';

/**
 * Live activity + watch-history capture. A poller reconciles now-playing
 * sessions across enabled connections into `MediaServerSession` rows; when a
 * session disappears it is written to `MediaServerWatchHistory`. This is the
 * media-server-native source of watch history (Tautulli import is the other).
 */

/**
 * What a live-activity consumer receives.
 *
 * Deliberately narrower than the row: no `ipAddress` (nothing renders it), and
 * no `artPath` (a provider-internal path; artwork comes from the authed proxy).
 */
export interface LiveSessionView {
  id: string;
  connectionId: string;
  userName: string | null;
  title: string;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  mediaType: string | null;
  libraryName: string | null;
  device: string | null;
  client: string | null;
  playbackState: string | null;
  progressPercent: number | null;
  playbackMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  container: string | null;
  bitrateKbps: number | null;
  startedAt: Date;
  updatedAt: Date;
  hasArtwork: boolean;
}

@Injectable()
export class MediaServerSessionService {
  private readonly logger = new Logger(MediaServerSessionService.name);
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: MediaServerIntegrationService,
    private readonly realtime: RealtimeGateway,
    private readonly registry: ModuleRegistryService,
    private readonly bus: DomainEventBus,
  ) {}

  /**
   * Live activity — the current reconciled session snapshot, projected.
   *
   * An explicit `select`, not a bare `findMany()`. The previous version returned
   * every column, which put **`ipAddress` on the wire** for every session; the
   * frontend type happened not to declare it, but a TypeScript type is not a
   * security boundary. Nothing renders a viewer's IP, so nothing should receive
   * it.
   *
   * `artPath` is likewise withheld: it is a provider-internal path, and the
   * client fetches artwork through the authenticated proxy by session id. A
   * boolean is all the UI needs to decide between a poster and a placeholder.
   */
  async liveActivity(): Promise<LiveSessionView[]> {
    const rows = await this.prisma.mediaServerSession.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, connectionId: true, userName: true, title: true,
        showTitle: true, seasonNumber: true, episodeNumber: true, year: true,
        mediaType: true, libraryName: true, device: true, client: true,
        playbackState: true, progressPercent: true, playbackMethod: true,
        videoCodec: true, audioCodec: true, resolution: true, container: true,
        bitrateKbps: true, artPath: true, startedAt: true, updatedAt: true,
      },
    });
    // Mapped field by field rather than spread. A spread would pass through
    // whatever the query happened to return, making this correct only for as
    // long as the `select` above stays correct — defence in depth is cheap here
    // and the field this guards is a viewer's IP address.
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connectionId,
      userName: r.userName,
      title: r.title,
      showTitle: r.showTitle,
      seasonNumber: r.seasonNumber,
      episodeNumber: r.episodeNumber,
      year: r.year,
      mediaType: r.mediaType,
      libraryName: r.libraryName,
      device: r.device,
      client: r.client,
      playbackState: r.playbackState,
      progressPercent: r.progressPercent,
      playbackMethod: r.playbackMethod,
      videoCodec: r.videoCodec,
      audioCodec: r.audioCodec,
      resolution: r.resolution,
      container: r.container,
      bitrateKbps: r.bitrateKbps,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      hasArtwork: !!r.artPath,
    }));
  }

  /**
   * Proxy the poster recorded on one user's notification.
   *
   * A stopped-playback card outlives its session — the row is deleted the moment
   * playback ends — so resolving through the session would 404 on exactly the
   * card that needs it. The connection and provider path are read from the
   * STORED notification, never from the request, so this cannot be turned into a
   * fetch-anything proxy. The `userId` filter is the ownership check: someone
   * else's notification id simply does not match, and the caller cannot tell
   * "not yours" from "no artwork".
   */
  async notificationArtwork(
    userId: string,
    notificationId: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const row = await this.prisma.userNotification.findFirst({
      where: { id: notificationId, userId },
      select: { artConnectionId: true, artPath: true },
    });
    if (!row?.artConnectionId || !row.artPath) return null;
    return this.integrations.fetchArtwork(row.artConnectionId, row.artPath);
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
          // Published only on CREATE — the poller reconciles the same session
          // every 15s, and this branch is the genuine start transition.
          this.bus.publish({
            eventKey: DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING,
            resourceType: 'media_server_session',
            resourceId: `${conn.id}:${s.sessionId}`,
            payload: {
              mediaTitle: s.title,
              serverName: conn.name ?? conn.id,
              userDisplayName: s.userName ?? null,
              showTitle: s.showTitle ?? null,
              seasonNumber: s.seasonNumber ?? null,
              episodeNumber: s.episodeNumber ?? null,
              year: s.year ?? null,
              mediaType: s.mediaType ?? null,
              libraryName: s.libraryName ?? null,
              device: s.device ?? null,
              client: s.client ?? null,
              resolution: s.resolution ?? null,
              playbackMethod: s.playbackMethod ?? null,
              playbackState: s.playbackState ?? null,
              progressPercent: s.progressPercent ?? null,
              // Connection + provider path, never a URL: only fetchable through
              // that connection's credentials, so storing it grants nothing.
              connectionId: conn.id,
              artPath: s.artPath ?? null,
              // Deliberately NOT ipAddress. Nothing renders it.
              startedAt: new Date().toISOString(),
            },
          });
          const startPayload = {
            mediaTitle: s.title, episodeTitle: null, mediaType: s.mediaType ?? null,
            userDisplayName: s.userName, userId: s.userId ?? null,
            serverName: conn.name ?? conn.id, libraryName: s.libraryName ?? null,
            device: s.device ?? null, client: s.client ?? null,
            playbackMethod: s.playbackMethod ?? null, resolution: s.resolution ?? null,
            videoCodec: s.videoCodec ?? null, audioCodec: s.audioCodec ?? null, bitrate: s.bitrateKbps ?? null,
            // Show identity and year let a consumer render "The Last of Us -
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
            // Deliberately NOT ipAddress. Nothing downstream renders it, and the
            // payload is stored on every recipient's row.
            startedAt: new Date().toISOString(),
          };
          if ((s.playbackMethod ?? '').toLowerCase().includes('transcode')) {
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
    // Fired once, when the session vanishes from the provider — the genuine stop
    // transition, not a heartbeat.
    this.bus.publish({
      eventKey: DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING,
      resourceType: 'media_server_session',
      resourceId: `${c.connectionId}:${c.providerSessionId}`,
      payload: {
        mediaTitle: c.title,
        serverName,
        userDisplayName: c.userName,
        showTitle: c.showTitle,
        seasonNumber: c.seasonNumber,
        episodeNumber: c.episodeNumber,
        year: c.year,
        mediaType: c.mediaType,
        libraryName: c.libraryName,
        device: c.device,
        client: c.client,
        resolution: c.resolution,
        completionPercent: c.progressPercent,
        watchedSeconds,
        // The session row is deleted above, so the stop card cannot resolve
        // artwork through it — carrying these is what lets it show a poster.
        connectionId: c.connectionId,
        artPath: c.artPath,
        stoppedAt: new Date().toISOString(),
      },
    });
  }
}
