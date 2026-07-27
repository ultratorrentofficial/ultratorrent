import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DOMAIN_EVENTS, MODULE_IDS } from '@ultratorrent/shared';
import type { MediaServerSession } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import type { ProviderSession } from '../media/media-server-provider';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { isNewViewing, viewingKey } from './viewing-identity';
import { resolveViewerName } from './viewer-name';

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

/**
 * Consecutive missed polls before a session is declared over.
 *
 * Four polls ≈ 60s at the 15s cadence. Chosen from this platform's own live
 * history, where transient absences cluster at 0–45s and long-tail past 90s;
 * a longer window would start merging genuinely separate viewings.
 */
const GRACE_POLLS = 4;

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
      // Loaded once so a session whose provider id changed can be re-attached to
      // its existing row rather than becoming a second one.
      const rows = await this.prisma.mediaServerSession.findMany({ where: { connectionId: conn.id } });
      const byProviderId = new Map(rows.map((r) => [r.providerSessionId, r]));
      const claimed = new Set<string>();

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
          episodeTitle: s.episodeTitle ?? null,
          seasonNumber: s.seasonNumber ?? null,
          episodeNumber: s.episodeNumber ?? null,
          year: s.year ?? null,
          externalIds:
            s.externalIds && Object.keys(s.externalIds).length ? s.externalIds : undefined,
        };
        // Same id → the same session, still playing.
        let existing = byProviderId.get(s.sessionId) ?? null;

        if (!existing) {
          /*
           * No row under this id, but a client that re-registers mid-playback
           * gets a NEW provider session id for the SAME viewing. Treating that
           * as a fresh session is what produced "finished watching" immediately
           * followed by "resumed watching" — and, in the history, overlapping
           * rows whose start preceded the previous row's stop.
           *
           * Adopt a row only if it is the same person watching the same thing on
           * the same device, and its own id has disappeared from this poll. That
           * last condition is what stops a second simultaneous play on another
           * device being swallowed into the first.
           */
          existing = rows.find((r) =>
            !claimed.has(r.id) &&
            !seen.has(r.providerSessionId) &&
            r.title === s.title &&
            (r.userName ?? null) === (s.userName ?? null) &&
            (r.device ?? null) === (s.device ?? null),
          ) ?? null;

          if (existing) {
            this.logger.debug(
              `Re-attaching session ${existing.providerSessionId} → ${s.sessionId} (${s.title}).`,
            );
          }
        }

        if (existing) {
          claimed.add(existing.id);
          /*
           * A client that autoplays the next episode keeps ONE provider session
           * id, so "the row already exists" does not mean "the same viewing".
           * Treat a changed item as the end of one and the start of the next:
           * otherwise a whole binge is a single row, notified once, written to
           * history under whichever episode happened to be last.
           */
          const newItem = isNewViewing(existing, data);
          if (newItem) await this.recordStop(existing, conn.name ?? conn.id);

          await this.prisma.mediaServerSession.update({
            where: { id: existing.id },
            // `missedPolls` resets and the provider id is re-pointed: a session
            // that came back is present, whatever it is now called. `startedAt`
            // restarts only for a new item, so its watched time is its own.
            data: {
              ...data,
              providerSessionId: s.sessionId,
              missedPolls: 0,
              ...(newItem ? { startedAt: new Date() } : {}),
            },
          });
          if (newItem) await this.announceStart(conn, s);
        } else {
          await this.prisma.mediaServerSession.create({
            data: { connectionId: conn.id, providerSessionId: s.sessionId, ...data },
          });
          await this.announceStart(conn, s);
        }
      }

      /*
       * Sessions still missing after the grace period → genuinely finished.
       *
       * A single missed poll is not an ending. Measured against this install's
       * own history, absences cluster at 15–45s — one to three polls — and are
       * followed by the same person resuming the same title. Ending on the first
       * miss split one viewing into several.
       *
       * The cost is that a real stop is reported up to GRACE_POLLS × 15s late,
       * which is invisible in a notification and worth far more than accuracy in
       * the play counts that decide what gets deleted.
       */
      for (const c of rows) {
        if (claimed.has(c.id) || seen.has(c.providerSessionId)) continue;

        const missed = c.missedPolls + 1;
        if (missed < GRACE_POLLS) {
          await this.prisma.mediaServerSession.update({
            where: { id: c.id }, data: { missedPolls: missed },
          });
          continue;
        }
        await this.endSession(c, conn.name ?? conn.id);
        ended += 1;
      }
    }
    return { connections: connections.length, active, ended };
  }

  /**
   * The viewer's name as a person would write it, resolved against the accounts
   * synced from the media server — see {@link resolveViewerName} for why the
   * session's own name cannot be trusted to be one.
   *
   * Only for DISPLAY. The session and watch-history rows keep the provider's own
   * value, which is what analytics group by; rewriting it there would silently
   * split one person's history across two spellings.
   */
  private async viewerName(
    connectionId: string,
    providerUserId: string | null,
    userName: string | null,
  ): Promise<string | null> {
    if (!userName) return null;
    const known = await this.prisma.mediaServerUser.findMany({
      select: { connectionId: true, providerUserId: true, userName: true },
    });
    return resolveViewerName(known, { connectionId, providerUserId, userName });
  }

  /**
   * Announce that something has begun playing: the live-activity broadcast and
   * the domain event a notification is built from.
   *
   * Called for a brand-new session AND for a new item inside a session that was
   * already running, because both are the same fact to anyone downstream. The
   * `resourceId` carries the item's identity as well as the session's — the
   * event's five-minute dedupe window exists to swallow a pause-and-resume
   * republishing the same start, and keying it on the session alone would make it
   * swallow the next episode too.
   */
  private async announceStart(
    conn: { id: string; name: string | null },
    s: ProviderSession,
  ): Promise<void> {
    this.realtime.broadcast('media_server.session.started', {
      connectionId: conn.id,
      title: s.title,
      userName: s.userName,
    });
    this.bus.publish({
      eventKey: DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING,
      resourceType: 'media_server_session',
      resourceId: `${conn.id}:${s.sessionId}:${viewingKey(s)}`,
      payload: {
        mediaTitle: s.title,
        serverName: conn.name ?? conn.id,
        userDisplayName: await this.viewerName(conn.id, s.userId ?? null, s.userName ?? null),
        showTitle: s.showTitle ?? null,
        episodeTitle: s.episodeTitle ?? null,
        seasonNumber: s.seasonNumber ?? null,
        episodeNumber: s.episodeNumber ?? null,
        year: s.year ?? null,
        mediaType: s.mediaType ?? null,
        libraryName: s.libraryName ?? null,
        device: s.device ?? null,
        client: s.client ?? null,
        resolution: s.resolution ?? null,
        // Summarized into one short quality line by the presentation
        // builder — never rendered raw.
        videoDynamicRange: s.videoDynamicRange ?? null,
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
  }

  /** A finished session: write history, tell everyone, but leave the row alone. */
  private async recordStop(c: MediaServerSession, serverName: string): Promise<void> {
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
    this.realtime.broadcast('media_server.session.ended', { connectionId: c.connectionId, title: c.title });
    // Fired once per VIEWING — when the session vanishes from the provider, or
    // when it moves on to a different item — never as a heartbeat. Same reason as
    // the start event for keying the id on the item as well as the session.
    this.bus.publish({
      eventKey: DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING,
      resourceType: 'media_server_session',
      resourceId: `${c.connectionId}:${c.providerSessionId}:${viewingKey(c)}`,
      payload: {
        mediaTitle: c.title,
        serverName,
        userDisplayName: await this.viewerName(c.connectionId, c.providerUserId, c.userName),
        showTitle: c.showTitle,
        episodeTitle: c.episodeTitle,
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
        // The stop card outlives the session row — deleted when the session
        // ends, repointed at the next episode when it does not — so it cannot
        // resolve artwork through it. Carrying these is what lets it show a
        // poster.
        connectionId: c.connectionId,
        artPath: c.artPath,
        stoppedAt: new Date().toISOString(),
      },
    });
  }

  /** A session that vanished from the provider: record the stop, drop the row. */
  private async endSession(c: MediaServerSession, serverName: string): Promise<void> {
    await this.recordStop(c, serverName);
    await this.prisma.mediaServerSession.delete({ where: { id: c.id } });
  }
}
