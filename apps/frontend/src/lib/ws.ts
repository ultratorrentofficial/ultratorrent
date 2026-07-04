/**
 * Socket.IO client wrapper for the realtime gateway.
 *
 * The socket authenticates with the current access token and reconnects with a
 * fresh token after a refresh. Consumers subscribe to typed events via the
 * `WsClient` instance; the React layer wraps this in a context provider.
 */

import { io, type Socket } from 'socket.io-client';
import {
  WS_EVENTS,
  type EngineStatusPayload,
  type FileOperationEventPayload,
  type ImdbEventPayload,
  type NotificationPayload,
  type StatsUpdatePayload,
  type TorrentsUpdatePayload,
} from '@ultratorrent/shared';
import { getAccessToken } from './api';

const WS_URL = (import.meta.env.VITE_WS_URL ?? 'http://localhost:4000').replace(/\/$/, '');

export interface WsEventMap {
  [WS_EVENTS.TORRENTS_UPDATE]: TorrentsUpdatePayload;
  [WS_EVENTS.STATS_UPDATE]: StatsUpdatePayload;
  [WS_EVENTS.ENGINE_STATUS]: EngineStatusPayload;
  [WS_EVENTS.NOTIFICATION]: NotificationPayload;
  [WS_EVENTS.FILES_OP_STARTED]: FileOperationEventPayload;
  [WS_EVENTS.FILES_OP_PROGRESS]: FileOperationEventPayload;
  [WS_EVENTS.FILES_OP_COMPLETED]: FileOperationEventPayload;
  [WS_EVENTS.FILES_OP_FAILED]: FileOperationEventPayload;
  [WS_EVENTS.FILES_CLEANUP_COMPLETED]: Record<string, unknown>;
  [WS_EVENTS.FILES_TRASH_UPDATED]: Record<string, unknown>;
  // IMDb provider lifecycle (scoped to the media_manager.view room).
  [WS_EVENTS.IMDB_DATASET_VALIDATE_STARTED]: ImdbEventPayload;
  [WS_EVENTS.IMDB_DATASET_VALIDATE_COMPLETED]: ImdbEventPayload;
  [WS_EVENTS.IMDB_DATASET_VALIDATE_FAILED]: ImdbEventPayload;
  [WS_EVENTS.IMDB_DATASET_IMPORT_PROGRESS]: ImdbEventPayload;
  [WS_EVENTS.IMDB_DATASET_IMPORT_COMPLETED]: ImdbEventPayload;
  [WS_EVENTS.IMDB_DATASET_IMPORT_FAILED]: ImdbEventPayload;
  [WS_EVENTS.IMDB_MATCH_COMPLETED]: ImdbEventPayload;
  [WS_EVENTS.IMDB_ENRICHMENT_COMPLETED]: ImdbEventPayload;
}

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

type StatusListener = (status: WsStatus) => void;

type AnyHandler = (...args: unknown[]) => void;

export class WsClient {
  private socket: Socket | null = null;
  private status: WsStatus = 'disconnected';
  private readonly statusListeners = new Set<StatusListener>();
  // Durable event-handler registry, keyed by event name. Handlers live here —
  // NOT only on the live socket — so subscriptions survive socket (re)creation:
  // a consumer that calls `on()` before `connect()`, or that stays subscribed
  // across `reauthenticate()`/reconnect/backend-restart, keeps receiving events.
  // (Previously handlers were bound to the current socket only and silently
  // lost, which stopped live dashboard stats.)
  private readonly handlers = new Map<string, Set<AnyHandler>>();

  get connectionStatus(): WsStatus {
    return this.status;
  }

  connect(): void {
    const token = getAccessToken();
    if (!token) return;
    if (this.socket?.connected) return;

    // Tear down any stale socket before reconnecting with a fresh token.
    this.socket?.removeAllListeners();
    this.socket?.disconnect();

    this.setStatus('connecting');

    this.socket = io(WS_URL, {
      path: '/ws',
      transports: ['websocket'],
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });

    this.socket.on('connect', () => this.setStatus('connected'));
    this.socket.on('disconnect', () => this.setStatus('disconnected'));
    this.socket.on('connect_error', () => this.setStatus('disconnected'));

    // Re-bind every registered consumer handler to the freshly-created socket.
    this.attachHandlers();
  }

  /** Bind all registered handlers to the current socket. */
  private attachHandlers(): void {
    if (!this.socket) return;
    for (const [event, set] of this.handlers) {
      for (const handler of set) this.socket.on(event, handler);
    }
  }

  /** Reconnect with the latest access token (call after a token refresh). */
  reauthenticate(): void {
    this.disconnect();
    this.connect();
  }

  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.setStatus('disconnected');
  }

  on<E extends keyof WsEventMap>(event: E, handler: (payload: WsEventMap[E]) => void): () => void {
    const key = event as string;
    const fn = handler as AnyHandler;
    // Record in the durable registry first so it survives (re)connects…
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set<AnyHandler>();
      this.handlers.set(key, set);
    }
    set.add(fn);
    // …then bind to the current socket if one already exists.
    this.socket?.on(key, fn);
    return () => {
      set?.delete(fn);
      if (set && set.size === 0) this.handlers.delete(key);
      this.socket?.off(key, fn);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: WsStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export const wsClient = new WsClient();
export { WS_URL };
