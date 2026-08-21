import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { stat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * What else holds these bytes.
 *
 * Every delete surface in this application — the Library Browser, the File
 * Manager, Media Purge, duplicate resolution — is deleting from a library whose
 * import strategy is `hardlink`. That means the ordinary case is that a file
 * exists TWICE by design: once in the library, once in the Intake payload a
 * torrent is seeding. Two consequences follow, and each surface used to get
 * both wrong independently:
 *
 * 1. **Deleting one name does not free the bytes.** `nlink` is 2, so the
 *    inode survives and the disk gives nothing back. A "reclaimable" figure
 *    computed from file size is fiction for any hardlinked file.
 * 2. **Deleting one name breaks something at the other end.** Removing the
 *    library copy strands a torrent seeding a payload nothing points at — 29
 *    of them on one live host, 10.3 GB. Removing the Intake copy breaks the
 *    torrent, and where a torrent's save path points INTO a library, a
 *    recursive delete there destroys organised media.
 *
 * So this service answers, for a set of paths or library items: which torrent
 * backs them, whether the payload is the same inode, and what a delete would
 * ACTUALLY free. It is deliberately read-only — it informs a decision, it never
 * makes one.
 */

/** A torrent behind a selection, as a confirmation dialog lists it. */
export interface LinkedTorrent {
  torrentHash: string;
  engineId: string | null;
  /** The release folder name — what the operator recognises in the client. */
  name: string;
  sourcePath: string;
  /** Intake job state. Note this is the DB's belief; see {@link liveHashes}. */
  state: string;
  /** Bytes the payload occupies now. */
  sizeBytes: number;
  itemIds: string[];
}

/** One path, and what deleting it would really do. */
export interface PathLinkage {
  path: string;
  exists: boolean;
  /** Hard link count. >1 means another name holds these same bytes. */
  links: number;
  sizeBytes: number;
  /** What the disk gets back: 0 while another link survives. */
  freesBytes: number;
  /** The torrent whose payload shares this file, when there is one. */
  torrent: LinkedTorrent | null;
}

@Injectable()
export class MediaLinkageService {
  private readonly logger = new Logger(MediaLinkageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * The torrents behind a set of library items.
   *
   * The mirror of `TorrentsService.importedLibraryItems`, and it takes the same
   * care: an intake job can outlive what it imported, so a torrent is reported
   * only when its job still names one of these items. One torrent can back
   * several items (a season pack), so results are grouped — offering the same
   * removal once per episode would count its bytes many times over.
   */
  async torrentsForItems(itemIds: readonly string[]): Promise<LinkedTorrent[]> {
    const ids = [...new Set((itemIds ?? []).filter(Boolean))];
    if (!ids.length) return [];

    const jobs = await this.prisma.mediaIntakeJob.findMany({
      where: { mediaItemId: { in: ids }, torrentHash: { not: null } },
      select: { torrentHash: true, engineId: true, sourcePath: true, mediaItemId: true, state: true },
    });
    return this.group(jobs);
  }

  /**
   * The torrents whose payload CONTAINS any of these paths.
   *
   * Used by the File Manager, where the operator is acting on a path rather
   * than a library item and may be aiming straight at a live payload.
   */
  async torrentsForPaths(paths: readonly string[]): Promise<LinkedTorrent[]> {
    const wanted = [...new Set((paths ?? []).filter(Boolean))];
    if (!wanted.length) return [];

    const jobs = await this.prisma.mediaIntakeJob.findMany({
      where: { torrentHash: { not: null } },
      select: { torrentHash: true, engineId: true, sourcePath: true, mediaItemId: true, state: true },
    });
    // A path matches when it IS the payload, sits inside it, or contains it —
    // deleting a parent directory takes the payload with it just as surely.
    const hit = jobs.filter((j) => wanted.some((p) => this.overlaps(p, j.sourcePath)));
    return this.group(hit);
  }

  /**
   * Per-path truth about links and reclaimable bytes.
   *
   * `freesBytes` is the number a confirmation may quote. It is zero whenever
   * another link survives, which for a hardlink import is most of the time.
   */
  async describePaths(paths: readonly string[]): Promise<PathLinkage[]> {
    const torrents = await this.torrentsForPaths(paths);
    const out: PathLinkage[] = [];
    for (const path of [...new Set((paths ?? []).filter(Boolean))]) {
      let info;
      try {
        info = await stat(path);
      } catch {
        out.push({ path, exists: false, links: 0, sizeBytes: 0, freesBytes: 0, torrent: null });
        continue;
      }
      const torrent = torrents.find((t) => this.overlaps(path, t.sourcePath)) ?? null;
      if (info.isDirectory()) {
        const { total, freeable } = await this.dirBytes(path);
        out.push({ path, exists: true, links: 1, sizeBytes: total, freesBytes: freeable, torrent });
        continue;
      }
      out.push({
        path,
        exists: true,
        links: info.nlink,
        sizeBytes: info.size,
        // The whole point: a second link means the disk gives nothing back.
        freesBytes: info.nlink > 1 ? 0 : info.size,
        torrent,
      });
    }
    return out;
  }

  /**
   * Hashes the engine is actually running, for callers that must not trust the
   * intake job's `state` column.
   *
   * That column is written when a job finishes and never revisited — nothing in
   * the codebase performs the `seeding -> archived` transition it defines — so
   * a job can claim to be seeding a torrent that was removed weeks ago. Live
   * state is the only honest answer to "is this still seeding".
   *
   * Resolved through `ModuleRef` at call time: importing `TorrentsModule` would
   * close a module cycle that fails only at bootstrap.
   */
  async liveHashes(): Promise<Set<string>> {
    return (await this.liveHashesStrict()) ?? new Set();
  }

  /**
   * The same question, answered honestly when the engine cannot be reached:
   * `null` means UNKNOWN, not "nothing is seeding".
   *
   * The distinction decides opposite behaviours in the two callers. A delete
   * preflight must not be blocked by an unreachable engine, so it treats
   * unknown as "nothing to warn about" — {@link liveHashes}. A purge must do
   * the reverse and skip the item, because deleting something that might still
   * be seeding is the direction that cannot be undone.
   */
  async liveHashesStrict(): Promise<Set<string> | null> {
    try {
      const { TorrentsService } = await import('../torrents/torrents.service');
      const torrents = this.moduleRef.get(TorrentsService, { strict: false });
      // One page large enough for the whole engine: a partial list would report
      // live torrents as gone, which is the direction that loses data.
      const listed = await torrents.list({ pageSize: 5000 } as never);
      const items = (listed as unknown as { items?: Array<{ hash?: string }> }).items ?? [];
      return new Set(items.map((t) => (t.hash ?? '').toLowerCase()).filter(Boolean));
    } catch (err) {
      // A preflight that cannot reach the engine must not block a delete; it
      // reports what it knows and says nothing it cannot support.
      this.logger.warn(`Could not read live torrents: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Item ids a live torrent is seeding, or `null` when the engine could not be
   * asked. Callers that destroy media must treat `null` as "skip everything",
   * never as "nothing is seeding".
   */
  async seedingItemIdsStrict(itemIds: readonly string[]): Promise<Set<string> | null> {
    const live = await this.liveHashesStrict();
    if (!live) return null;
    const torrents = await this.torrentsForItems(itemIds);
    const seeding = new Set<string>();
    for (const t of torrents) {
      if (!live.has((t.torrentHash ?? '').toLowerCase())) continue;
      for (const id of t.itemIds ?? []) seeding.add(id);
    }
    return seeding;
  }

  /** Item ids, within the given set, that a live torrent is still seeding. */
  async seedingItemIds(itemIds: readonly string[]): Promise<Set<string>> {
    const torrents = await this.torrentsForItems(itemIds);
    return this.liveItemIdsOf(torrents);
  }

  /**
   * Every library item a live torrent is seeding, install-wide.
   *
   * Driven from the intake jobs, which already name their item — NOT by
   * listing the library and asking about each one. A library here can hold
   * hundreds of thousands of rows while the jobs number in the dozens, and a
   * scan must not read the whole library twice to answer one question.
   */
  async allSeedingItemIds(): Promise<Set<string>> {
    const jobs = await this.prisma.mediaIntakeJob.findMany({
      where: { torrentHash: { not: null }, mediaItemId: { not: null } },
      select: { torrentHash: true, engineId: true, sourcePath: true, mediaItemId: true, state: true },
    });
    if (!jobs.length) return new Set();
    return this.liveItemIdsOf(this.group(jobs));
  }

  private async liveItemIdsOf(torrents: LinkedTorrent[]): Promise<Set<string>> {
    if (!torrents.length) return new Set();
    const live = await this.liveHashes();
    const out = new Set<string>();
    for (const t of torrents) {
      if (!live.has(t.torrentHash.toLowerCase())) continue;
      for (const id of t.itemIds) out.add(id);
    }
    return out;
  }

  private group(
    jobs: Array<{ torrentHash: string | null; engineId: string | null; sourcePath: string; mediaItemId: string | null; state: string }>,
  ): LinkedTorrent[] {
    const byHash = new Map<string, LinkedTorrent>();
    for (const j of jobs) {
      if (!j.torrentHash) continue;
      const entry = byHash.get(j.torrentHash) ?? {
        torrentHash: j.torrentHash,
        engineId: j.engineId ?? null,
        name: basename(j.sourcePath),
        sourcePath: j.sourcePath,
        state: j.state,
        sizeBytes: 0,
        itemIds: [],
      };
      if (j.mediaItemId && !entry.itemIds.includes(j.mediaItemId)) entry.itemIds.push(j.mediaItemId);
      byHash.set(j.torrentHash, entry);
    }
    return [...byHash.values()];
  }

  /** Is one path the same as, inside, or a parent of the other? */
  private overlaps(a: string, b: string): boolean {
    if (a === b) return true;
    return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }

  /** Total bytes under a directory, and how many of them a delete would free. */
  private async dirBytes(root: string): Promise<{ total: number; freeable: number }> {
    let total = 0;
    let freeable = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
          continue;
        }
        if (!e.isFile()) continue;
        try {
          const info = await stat(p);
          total += info.size;
          if (info.nlink === 1) freeable += info.size;
        } catch {
          /* raced with a delete */
        }
      }
    };
    await walk(root);
    return { total, freeable };
  }
}
