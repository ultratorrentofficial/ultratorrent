import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PERMISSIONS, SystemRole, WS_EVENTS } from '@ultratorrent/shared';

/**
 * View permissions that gate the realtime feeds. On connect a socket joins a
 * `perm:<key>` room for each of these it holds; events are emitted only to the
 * matching room, so a user never receives live data they can't read over REST.
 */
const SCOPED_PERMISSIONS = [
  PERMISSIONS.TORRENTS_VIEW,
  PERMISSIONS.FILES_VIEW,
  PERMISSIONS.MEDIA_MANAGER_VIEW,
  PERMISSIONS.MEDIA_ACQUISITION_VIEW,
  PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW,
  PERMISSIONS.RSS_VIEW,
];

/**
 * Authenticated realtime channel. Clients pass a JWT access token via the
 * socket handshake auth. Each socket joins a private room (their id), a shared
 * `authenticated` room (permission-free events like notifications), and a
 * `perm:<key>` room for each view permission it holds.
 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  path: '/ws',
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  afterInit(): void {
    this.logger.log('Realtime gateway initialised on /ws');
  }

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token =
        (client.handshake.auth?.token as string) ??
        (client.handshake.query?.token as string);
      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
        algorithms: ['HS256'],
      });
      client.data.userId = payload.sub;
      client.join('authenticated');
      client.join(`user:${payload.sub}`);

      // Join only the feeds the user is permitted to read (SUPER_ADMIN: all).
      const held = new Set<string>(payload.permissions ?? []);
      const isSuper = (payload.roles ?? []).includes(SystemRole.SUPER_ADMIN);
      for (const perm of SCOPED_PERMISSIONS) {
        if (isSuper || held.has(perm)) client.join(`perm:${perm}`);
      }
    } catch {
      client.disconnect(true);
    }
  }

  /** Room an event is confined to, by the permission required to read it. */
  private roomForEvent(event: string): string {
    if (
      event === WS_EVENTS.TORRENTS_UPDATE ||
      event === WS_EVENTS.STATS_UPDATE ||
      event === WS_EVENTS.ENGINE_STATUS
    ) {
      return `perm:${PERMISSIONS.TORRENTS_VIEW}`;
    }
    if (event.startsWith('files.')) return `perm:${PERMISSIONS.FILES_VIEW}`;
    if (event.startsWith('media_manager.') || event.startsWith('imdb.')) {
      return `perm:${PERMISSIONS.MEDIA_MANAGER_VIEW}`;
    }
    if (event.startsWith('media_acquisition.')) {
      return `perm:${PERMISSIONS.MEDIA_ACQUISITION_VIEW}`;
    }
    if (event.startsWith('media_server.')) {
      return `perm:${PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW}`;
    }
    if (event.startsWith('rss.')) {
      return `perm:${PERMISSIONS.RSS_VIEW}`;
    }
    // Permission-free events (e.g. notifications) go to all authenticated sockets.
    return 'authenticated';
  }

  broadcast(event: string, payload: unknown): void {
    this.server?.to(this.roomForEvent(event)).emit(event, payload);
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  emitStats(payload: unknown): void {
    this.broadcast(WS_EVENTS.STATS_UPDATE, payload);
  }

  emitTorrents(payload: unknown): void {
    this.broadcast(WS_EVENTS.TORRENTS_UPDATE, payload);
  }

  emitEngineStatus(payload: unknown): void {
    this.broadcast(WS_EVENTS.ENGINE_STATUS, payload);
  }
}
