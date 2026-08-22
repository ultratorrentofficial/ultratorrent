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
 * Permissions a console socket is scoped by, beyond {@link SCOPED_PERMISSIONS}.
 *
 * The console's merged event feed carries facts from domains the web app has no
 * live channel for — jobs, the scheduler, storage, security, users — so those
 * permissions need a room too. They are kept separate from `SCOPED_PERMISSIONS`
 * deliberately: adding them there would start delivering these events to every
 * browser socket as well, which is a behaviour change to the web app made for
 * the console's convenience.
 */
const CONSOLE_SCOPED_PERMISSIONS = [
  ...SCOPED_PERMISSIONS,
  PERMISSIONS.TORRENT_SCHEDULER_VIEW,
  PERMISSIONS.MEDIA_INTAKE_VIEW,
  PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY,
  PERMISSIONS.JOBS_VIEW,
  PERMISSIONS.AUTOMATION_VIEW,
  PERMISSIONS.WORKFLOWS_VIEW,
  PERMISSIONS.LIBRARY_CLEANUP_VIEW,
  PERMISSIONS.SYSTEM_VIEW,
  PERMISSIONS.AUDIT_VIEW,
  PERMISSIONS.USERS_VIEW,
];

/** Room for a console socket's permission-free events. */
export const CONSOLE_ROOM_ALL = 'console:authenticated';

/** The room one console-visible permission maps to. */
export function consoleRoom(permission: string | null | undefined): string {
  return permission ? `console:${permission}` : CONSOLE_ROOM_ALL;
}

/**
 * Something watching what is emitted, without changing what is emitted.
 *
 * The console's event feed has to include `jobs.*`, and those are produced by
 * `PlatformJobService` straight onto this gateway — they never reach
 * `DomainEventBus`. An observer lets the operations bridge SEE them rather than
 * the jobs service gaining a second call to make, which is what "no new
 * producer anywhere" has to mean in practice.
 */
export type RealtimeObserver = (
  event: string,
  payload: unknown,
  permission: string | null,
) => void;

/**
 * Authenticated realtime channel. Clients pass a JWT access token via the
 * socket handshake auth. Each socket joins a private room (their id), a shared
 * `authenticated` room (permission-free events), and a
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

  private readonly observers = new Set<RealtimeObserver>();

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

      /*
       * Console rooms are the INTERSECTION of "may use the console" and "may
       * read this domain", which a single room per permission cannot express —
       * socket.io's `to(a).to(b)` is a union. Joining a `console:<perm>` room
       * only when both hold makes the intersection a membership fact, computed
       * once at connect rather than per emit, and keeps the console's feed off
       * every browser socket that merely shares the domain permission.
       */
      if (isSuper || held.has(PERMISSIONS.CONSOLE_VIEW)) {
        client.join(CONSOLE_ROOM_ALL);
        for (const perm of CONSOLE_SCOPED_PERMISSIONS) {
          if (isSuper || held.has(perm)) client.join(consoleRoom(perm));
        }
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
    // Permission-free events go to all authenticated sockets.
    return 'authenticated';
  }

  broadcast(event: string, payload: unknown): void {
    this.server?.to(this.roomForEvent(event)).emit(event, payload);
  }

  toUser(userId: string, event: string, payload: unknown): void {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }

  /**
   * Emit an event scoped to holders of a specific permission. Used by the Unified
   * Jobs Center, whose `jobs.*` events are scoped per-job by the job's required
   * permission (not by a fixed event-name prefix). A null permission falls back to
   * every authenticated client.
   */
  emitToPermission(permission: string | null | undefined, event: string, payload: unknown): void {
    const room = permission ? `perm:${permission}` : 'authenticated';
    this.server?.to(room).emit(event, payload);
    this.notifyObservers(event, payload, permission ?? null);
  }

  /**
   * Emit to console sockets that hold `permission`, and only those.
   *
   * Separate from {@link emitToPermission} because the scoping is different in
   * kind: this room already encodes "holds console.view AND holds this", so the
   * caller does not have to know that the console is a second audience with a
   * narrower membership.
   */
  emitToConsole(permission: string | null | undefined, event: string, payload: unknown): void {
    this.server?.to(consoleRoom(permission)).emit(event, payload);
  }

  /**
   * Watch what is emitted through {@link emitToPermission}.
   *
   * Deliberately NOT wired into `broadcast`/`toUser`: the one consumer needs
   * `jobs.*`, and a hook on every emit would put the whole realtime firehose
   * through a listener that wants a fraction of it. Returns an unsubscribe.
   */
  observe(fn: RealtimeObserver): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  /** One failing observer must not break the emit it was watching. */
  private notifyObservers(event: string, payload: unknown, permission: string | null): void {
    for (const fn of this.observers) {
      try {
        fn(event, payload, permission);
      } catch (err) {
        this.logger.warn(`Realtime observer failed on "${event}": ${(err as Error).message}`);
      }
    }
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
