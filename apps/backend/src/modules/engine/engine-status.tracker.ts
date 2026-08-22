import { Injectable } from '@nestjs/common';

/** The last thing the sync loop observed about one engine. */
export interface EngineLastKnownStatus {
  engineId: string;
  online: boolean;
  error: string | null;
  /** When this observation was made. */
  at: string;
  /** When the engine was last reached successfully — null if never, this boot. */
  lastSeenAt: string | null;
  /** Torrent count at the last successful poll. Null until one succeeds. */
  torrentCount: number | null;
}

/**
 * The last known state of each torrent engine, as the sync loop saw it.
 *
 * `TorrentSyncService` already asks every engine for its torrents and stats
 * every two seconds, and already decides online/offline from whether that
 * succeeded — it just broadcast the answer and forgot it. Anything that wanted
 * engine health afterwards had to ask the engine again.
 *
 * That re-ask is the problem this closes. An operations snapshot is requested
 * on a human's cadence but by however many clients are watching, and
 * `healthCheck()` is a real network call to rTorrent or qBittorrent. Reading a
 * fact the poller already established costs nothing and cannot make a sick
 * engine sicker, which is exactly when someone opens a console.
 *
 * Deliberately in-memory and deliberately not persisted: this is "what is true
 * right now", and a value that outlived the process would be a claim about a
 * world nobody has looked at since. `lastSeenAt` is null after a restart until
 * the first successful poll, and null is the honest answer.
 */
@Injectable()
export class EngineStatusTracker {
  private readonly statuses = new Map<string, EngineLastKnownStatus>();

  /** Record a successful poll. */
  recordOnline(engineId: string, at: string, torrentCount: number): void {
    this.statuses.set(engineId, {
      engineId,
      online: true,
      error: null,
      at,
      lastSeenAt: at,
      torrentCount,
    });
  }

  /**
   * Record a failed poll, preserving the last time the engine *was* reachable.
   *
   * Keeping `lastSeenAt` across the failure is the whole value of the row: "down
   * for 4 minutes" and "down since boot" are different incidents, and an entry
   * that reset the timestamp on every failed tick could only ever report the
   * second one.
   */
  recordOffline(engineId: string, at: string, error: string): void {
    const prior = this.statuses.get(engineId);
    this.statuses.set(engineId, {
      engineId,
      online: false,
      error,
      at,
      lastSeenAt: prior?.lastSeenAt ?? null,
      torrentCount: prior?.torrentCount ?? null,
    });
  }

  get(engineId: string): EngineLastKnownStatus | null {
    return this.statuses.get(engineId) ?? null;
  }

  list(): EngineLastKnownStatus[] {
    return [...this.statuses.values()];
  }
}
