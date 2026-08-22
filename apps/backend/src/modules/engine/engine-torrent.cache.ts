import { Injectable } from '@nestjs/common';
import type { GlobalStats, NormalizedTorrent } from '@ultratorrent/shared';

/** One engine's torrents and rates, exactly as the sync loop last saw them. */
export interface EngineTorrentReading {
  engineId: string;
  torrents: NormalizedTorrent[];
  /** Null when the engine answered `listTorrents` but not `getGlobalStats`. */
  stats: GlobalStats | null;
  /** When this reading was taken. */
  at: string;
}

/**
 * The torrents the sync loop already fetched, kept instead of discarded.
 *
 * `TorrentSyncService` asks every engine for its full torrent list and global
 * stats every two seconds, broadcasts them, writes snapshot rows, and drops the
 * normalized objects on the floor. Anything wanting the same picture afterwards
 * had to ask the engine again.
 *
 * That second ask is what this closes, and the reason is measured rather than
 * theoretical: an operations snapshot on a real install spent **474 ms** in
 * `listTorrents()`/`getGlobalStats()` — over half its total — and a console
 * polling at the interval the contract advertises would have put two more full
 * engine listings every two seconds on top of the sync loop's own. A client
 * whose whole purpose is to watch must not become load on the thing it watches.
 *
 * **Why not the `torrent_snapshots` table**, which the sync loop already writes
 * and `SchedulerPreviewService` already reads: that row carries no `eta`, no
 * `seedsConnected`, no `peersConnected` and no `message`. Reading it would cost
 * the console the numbers an operator actually watches a download for — and
 * `isStalled()` is defined on `peersConnected`, so "stalled" could not even be
 * computed. The in-memory reading has every field because it *is* what the
 * engine said.
 *
 * Deliberately in-memory and never persisted, exactly like
 * {@link EngineStatusTracker}: this is "what is true right now", and a value
 * that outlived the process would be a claim about a world nobody has looked at
 * since. A reader gets nothing until the first successful poll — which is the
 * honest answer, and is why {@link EngineTorrentReading.at} travels with it.
 */
@Injectable()
export class EngineTorrentCache {
  private readonly readings = new Map<string, EngineTorrentReading>();

  /**
   * Record a successful poll.
   *
   * Replaces the engine's previous reading wholesale rather than merging: a
   * torrent that has been removed must disappear, and a merge would keep it
   * visible forever.
   */
  record(engineId: string, at: string, torrents: NormalizedTorrent[], stats: GlobalStats | null): void {
    this.readings.set(engineId, { engineId, torrents, stats, at });
  }

  /**
   * Drop an engine's reading.
   *
   * Called when an engine is deleted. A failed POLL deliberately does NOT clear
   * it: the last known torrents are still the best available answer during a
   * brief outage, the engine's own domain reports that it is down, and blanking
   * the list would tell an operator their torrents had vanished when only the
   * connection had.
   */
  forget(engineId: string): void {
    this.readings.delete(engineId);
  }

  get(engineId: string): EngineTorrentReading | null {
    return this.readings.get(engineId) ?? null;
  }

  list(): EngineTorrentReading[] {
    return [...this.readings.values()];
  }
}
