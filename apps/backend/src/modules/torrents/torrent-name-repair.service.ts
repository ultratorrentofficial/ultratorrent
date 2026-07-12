import { Injectable, Logger } from '@nestjs/common';
import type { NormalizedTorrent } from '@ultratorrent/shared';
import type { TorrentEngineProvider } from '../../domain/engine/torrent-engine-provider.interface';

/**
 * Repairs torrents whose engine-reported name is an infohash placeholder rather
 * than the real torrent name.
 *
 * How they arise: a magnet has no name until its metadata arrives, so an engine
 * names it after the infohash in the meantime — rTorrent as `<HASH>.meta` (the
 * placeholder file it writes into the download directory), qBittorrent as the
 * bare hash. Once the metadata lands, the *torrent* knows its real name, but
 * neither engine necessarily rewrites the display name it already committed to.
 * qBittorrent in particular pins it in `qBt-name` and never revisits it, so the
 * torrent can sit there complete, seeding, correctly filed on disk — and still
 * be listed as `246C4643….meta` forever.
 *
 * We can't fix that in the UI alone: the name lives in the engine, and everything
 * that reads the engine (the list, search, the parking queue, the automation log)
 * would keep showing the placeholder. So repair it at the source, once, by asking
 * the engine for the torrent's file list — which *is* derived from the real
 * metadata — reconstructing the torrent name from it, and renaming via the engine.
 *
 * Deliberately conservative:
 *   • only acts on a name that is unambiguously a placeholder (an infohash, with
 *     an optional `.meta` suffix) — never on a name a user might have chosen;
 *   • only when the metadata has actually arrived (no files ⇒ nothing to rename
 *     to, so a still-resolving or dead magnet is left alone and retried later);
 *   • rate-limited per tick, because the sync loop runs every 2 seconds and each
 *     repair costs a file-list round-trip;
 *   • remembers failures so a torrent whose engine refuses the rename is not
 *     retried forever.
 */
@Injectable()
export class TorrentNameRepairService {
  private readonly logger = new Logger(TorrentNameRepairService.name);

  /** Hashes we've already repaired or given up on, so we don't retry every tick. */
  private readonly settled = new Set<string>();

  /** A repair costs a round-trip; don't stall the 2s sync loop behind a backlog. */
  private static readonly MAX_PER_TICK = 5;

  /** `<40-hex>` or `<40-hex>.meta` — an engine placeholder, never a real name. */
  private static readonly PLACEHOLDER = /^[0-9a-f]{40}(\.meta)?$/i;

  static isPlaceholderName(name: string, hash: string): boolean {
    const n = (name ?? '').trim();
    if (!n) return true;
    if (n.toLowerCase() === hash.toLowerCase()) return true;
    return TorrentNameRepairService.PLACEHOLDER.test(n);
  }

  /**
   * The torrent name as bittorrent defines it: for a single-file torrent, the
   * file's name; for a multi-file torrent, the root directory every path shares.
   * If the paths don't agree on a root we return null rather than guess.
   */
  static nameFromFiles(paths: string[]): string | null {
    const cleaned = paths
      .map((p) => (p ?? '').replace(/\\/g, '/').replace(/^\/+/, ''))
      .filter(Boolean);
    if (!cleaned.length) return null;

    if (cleaned.length === 1 && !cleaned[0].includes('/')) return cleaned[0];

    const roots = new Set(cleaned.map((p) => p.split('/')[0]));
    return roots.size === 1 ? [...roots][0] : null;
  }

  /** Called on every sync tick with the engine's current torrent list. */
  async repair(
    provider: TorrentEngineProvider,
    torrents: NormalizedTorrent[],
  ): Promise<void> {
    const broken = torrents.filter(
      (t) =>
        !this.settled.has(t.hash) &&
        TorrentNameRepairService.isPlaceholderName(t.name, t.hash),
    );

    for (const t of broken.slice(0, TorrentNameRepairService.MAX_PER_TICK)) {
      try {
        const files = await provider.getFiles(t.hash);
        const name = TorrentNameRepairService.nameFromFiles(
          files.map((f) => f.path),
        );

        // No metadata yet (a magnet still resolving, or a dead swarm). Leave it:
        // there is nothing to rename it *to*, and it may resolve later.
        if (!name || TorrentNameRepairService.isPlaceholderName(name, t.hash)) {
          continue;
        }

        await provider.renameTorrent(t.hash, name);
        this.settled.add(t.hash);
        this.logger.log(`Repaired placeholder name: ${t.name} -> ${name}`);
      } catch (err) {
        // An engine that can't rename (or won't) must not be retried every 2s.
        this.settled.add(t.hash);
        this.logger.warn(
          `Could not repair name for ${t.hash}: ${(err as Error).message}`,
        );
      }
    }
  }
}
