import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DOMAIN_EVENTS, MODULE_IDS } from '@ultratorrent/shared';
import type { MediaServerSession } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ModuleRegistryService } from '../module-registry/module-registry.service';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import { AuditService } from '../audit/audit.service';
import { GeoIpService, type GeoResult } from '../geoip/geoip.service';
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
  /**
   * The viewer as a person would write it. Separate from `userName`, which stays
   * the provider's own value because analytics group by it — see
   * {@link MediaServerSessionService.viewerName}.
   */
  userDisplayName: string | null;
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
  /** The address the viewer streamed from — a LAN ip for local playback. */
  ipAddress: string | null;
  /** Offline-resolved location for `ipAddress`; null when unresolved or local. */
  geo: GeoResult | null;
  startedAt: Date;
  updatedAt: Date;
  hasArtwork: boolean;
  /**
   * Whether this session's server can be administratively stopped — drives the
   * "Terminate Stream" action and the monitor-only label. Provider-declared
   * (Kodi is false); never a reason to treat the server as unhealthy.
   */
  canTerminate: boolean;
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
    private readonly geoip: GeoIpService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Live activity — the current reconciled session snapshot, projected.
   *
   * An explicit `select`, not a bare `findMany()`, so a new column is never put
   * on the wire by accident. `ipAddress` IS selected and returned on purpose —
   * the operator asked to see where a viewer is streaming from, and this
   * endpoint is analytics-permissioned — and it carries its offline-resolved
   * location alongside.
   *
   * `artPath` is likewise withheld: it is a provider-internal path, and the
   * client fetches artwork through the authenticated proxy by session id. A
   * boolean is all the UI needs to decide between a poster and a placeholder.
   */
  async liveActivity(): Promise<LiveSessionView[]> {
    // One accounts read for the whole page, not one per row: resolving inside
    // the map would issue a query per playing session.
    const [rows, known, connections] = await Promise.all([
      this.prisma.mediaServerSession.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, connectionId: true, userName: true, providerUserId: true, title: true,
        showTitle: true, seasonNumber: true, episodeNumber: true, year: true,
        mediaType: true, libraryName: true, device: true, client: true,
        playbackState: true, progressPercent: true, playbackMethod: true,
        videoCodec: true, audioCodec: true, resolution: true, container: true,
        bitrateKbps: true, artPath: true, ipAddress: true, startedAt: true, updatedAt: true,
      },
      }),
      this.knownViewers(),
      this.prisma.mediaServerIntegration.findMany({ select: { id: true, kind: true, capabilities: true } }),
    ]);
    // Which connections can be administratively stopped — from the persisted,
    // provider-declared capability, defaulting by kind (Kodi cannot) when a
    // connection has not been health-probed yet.
    const canTerminateByConn = new Map<string, boolean>(
      connections.map((c) => {
        const declared = (c.capabilities as { terminateSessions?: boolean } | null)?.terminateSessions;
        return [c.id, typeof declared === 'boolean' ? declared : c.kind !== 'kodi'];
      }),
    );
    // Resolve every distinct address once, offline. The IP is now shown to the
    // operator (this endpoint is analytics-permissioned), so it is deliberately
    // on the wire — with its location attached where the database can place it.
    const geo = await this.geoip.lookupMany(rows.map((r) => r.ipAddress));
    // Mapped field by field rather than spread. A spread would pass through
    // whatever the query happened to return, making this correct only for as
    // long as the `select` above stays correct — defence in depth is cheap here
    // and the field this guards is a viewer's IP address.
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connectionId,
      userName: r.userName,
      userDisplayName: resolveViewerName(known, {
        connectionId: r.connectionId,
        providerUserId: r.providerUserId,
        userName: r.userName,
      }),
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
      ipAddress: r.ipAddress,
      geo: r.ipAddress ? geo.get(r.ipAddress.trim()) ?? null : null,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
      hasArtwork: !!r.artPath,
      canTerminate: canTerminateByConn.get(r.connectionId) ?? false,
    }));
  }

  /**
   * Administratively stop a live session (the manual "Terminate Stream" action).
   *
   * `id` is the internal `MediaServerSession` row id shown in Live Activity; the
   * provider-native id and connection are read from the row so the caller never
   * handles them. Delegates the actual stop to the provider (via the integration
   * service), records an audit entry with the acting admin + request context, and
   * broadcasts the outcome so every Live Activity view updates without a refresh.
   * A provider that cannot terminate (Kodi) yields `supported: false` and is not
   * treated as an error.
   */
  async terminateStream(
    id: string,
    ctx: { userId: string; ipAddress: string | null; userAgent: string | null },
    message?: string,
  ): Promise<{ supported: boolean; success: boolean; message?: string }> {
    const row = await this.prisma.mediaServerSession.findUnique({
      where: { id },
      select: {
        id: true, connectionId: true, providerSessionId: true,
        title: true, userName: true, device: true, client: true, ipAddress: true,
      },
    });
    if (!row) throw new NotFoundException('Session not found');

    const outcome = await this.integrations.terminateSession(row.connectionId, row.providerSessionId, { message });

    const audonly = {
      userId: ctx.userId,
      ipAddress: ctx.ipAddress ?? undefined,
      userAgent: ctx.userAgent ?? undefined,
      objectType: 'media_server_session',
      objectId: row.id,
    } as const;

    if (!outcome.supported) {
      await this.audit.record({
        ...audonly,
        action: 'media_server_analytics.session.terminate_unsupported',
        result: 'failure',
        metadata: { message: outcome.message, title: row.title, userName: row.userName },
      });
      return { supported: false, success: false, message: outcome.message };
    }

    const success = outcome.result?.success ?? false;
    await this.audit.record({
      ...audonly,
      action: 'media_server_analytics.session.terminated',
      result: success ? 'success' : 'failure',
      metadata: {
        title: row.title, userName: row.userName, device: row.device,
        client: row.client, viewerIp: row.ipAddress, providerMessage: outcome.result?.message,
      },
    });

    this.realtime.broadcast(
      success ? 'media_server.stream.terminated' : 'media_server.stream.termination_failed',
      { connectionId: row.connectionId, sessionId: row.id, title: row.title, userName: row.userName },
    );

    return { supported: true, success, message: outcome.result?.message };
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
    // Whether naming the server on a notification tells the reader anything.
    const multiServer = connections.length > 1;
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
          if (newItem) await this.recordStop(existing, conn.name ?? conn.id, multiServer ? (conn.kind ?? null) : null);

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
          if (newItem) await this.announceStart(conn, s, multiServer);
        } else {
          await this.prisma.mediaServerSession.create({
            data: { connectionId: conn.id, providerSessionId: s.sessionId, ...data },
          });
          await this.announceStart(conn, s, multiServer);
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
        await this.endSession(c, conn.name ?? conn.id, multiServer ? (conn.kind ?? null) : null);
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
    return resolveViewerName(await this.knownViewers(), { connectionId, providerUserId, userName });
  }

  /** The accounts every name is resolved against. */
  private knownViewers() {
    return this.prisma.mediaServerUser.findMany({
      select: { connectionId: true, providerUserId: true, userName: true, email: true },
    });
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
    conn: { id: string; name: string | null; kind?: string | null },
    s: ProviderSession,
    _multiServer: boolean,
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
        // Which product, not just which box: with Plex and Jellyfin on one host
        // the name alone does not say what is handling the stream.
        serverKind: conn.kind ?? null,
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
  private async recordStop(c: MediaServerSession, serverName: string, serverKind: string | null): Promise<void> {
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
        serverKind,
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
  private async endSession(c: MediaServerSession, serverName: string, serverKind: string | null): Promise<void> {
    await this.recordStop(c, serverName, serverKind);
    await this.prisma.mediaServerSession.delete({ where: { id: c.id } });
  }
}
