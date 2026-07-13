import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readdir, rename, rm, stat, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { FilesService } from '../files/files.service';
import { AuditService } from '../audit/audit.service';
import { VIDEO_EXT } from './media-scanner.service';
import { parseItemIdentity } from './media-identification.service';
import { showCanonicalKey } from './series-grouping';

/** One folder in a family of possible duplicates. */
export interface DuplicateShowMember {
  showId: string;
  path: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  /** Video files actually on disk right now (not the DB's count). */
  videoCount: number;
  sizeBytes: number;
}

export interface DuplicateShowFamily {
  /** What tied these folders together. */
  reason: 'name' | 'imdb' | 'name+imdb';
  /**
   * The folders' NAMES disagree and only a shared IMDb id ties them — which a
   * single mis-tagged item is enough to do. On a real library `Masters of the Air`
   * was found carrying High Desert's `tt13701758`; merging on that would move one
   * show's episodes into the other. Such a family is surfaced but flagged, never
   * presented as an obvious duplicate.
   */
  needsReview: boolean;
  /** The member with the most video files — a suggestion, never applied on its own. */
  suggestedCanonicalShowId: string;
  members: DuplicateShowMember[];
}

/** One file that would move into the canonical folder. */
export interface MergeMove {
  from: string;
  to: string;
  sizeBytes: number;
}

/** The same episode present in both folders. The larger file wins. */
export interface MergeCollision {
  season: number | null;
  episode: number | null;
  incoming: string;
  incomingBytes: number;
  existing: string;
  existingBytes: number;
  winner: 'incoming' | 'existing';
  /** The file that loses — moved to Trash, never destroyed outright. */
  trashed: string;
}

export interface MergePlan {
  canonical: { showId: string; path: string; title: string };
  duplicates: Array<{ showId: string; path: string; title: string }>;
  moves: MergeMove[];
  collisions: MergeCollision[];
  /** Duplicate folders that will be permanently deleted once emptied. */
  deletions: string[];
  /** Anything that makes the merge unsafe. Non-empty → `merge` refuses. */
  blockers: string[];
}

export interface MergeResult extends MergePlan {
  moved: number;
  trashed: number;
  deleted: number;
  /** Watchlist items re-pointed from a merged show to the canonical one. */
  rebound: number;
}

interface VideoFile {
  path: string;
  sizeBytes: number;
  season: number | null;
  episode: number | null;
}

/**
 * Duplicate SHOW FOLDERS — two directories in one library that are really the same
 * show, e.g. `Happy's Place (2024)` and `Happys Place`, or `Magnum P.I. (2018)` and
 * `Magnum P.I (2018)`. They are created when something files a download into a
 * folder named after a title instead of the folder the show already has.
 *
 * This is NOT {@link MediaDuplicateService}, which groups duplicate *items/files*
 * (same episode ripped twice). This groups the directories themselves.
 *
 * Nothing here is automatic. Detection only reports; the operator chooses which
 * path is the real one, previews every move and deletion, and confirms.
 */
@Injectable()
export class MediaShowDuplicateService {
  private readonly logger = new Logger(MediaShowDuplicateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  // --- detection ------------------------------------------------------------

  /**
   * Families of show folders that look like the same show.
   *
   * Two folders are tied together when they share a {@link showCanonicalKey} AND
   * their years are compatible, or when they share a non-null IMDb id.
   *
   * The year check is what keeps genuinely different shows apart: `Dark Matter
   * (2015)` and `Dark Matter (2024)` canonicalize identically, as do `Invasion
   * (2005)`/`(2021)` and `Tracker (2001)`/`(2024)`. Two folders that both carry a
   * year, and disagree about it, are different shows — never a duplicate.
   */
  async detect(libraryId?: string): Promise<DuplicateShowFamily[]> {
    const shows = await this.prisma.mediaShow.findMany({
      where: libraryId ? { libraryId } : undefined,
      select: { id: true, libraryId: true, path: true, title: true, year: true, imdbId: true, canonicalKey: true },
    });
    if (shows.length < 2) return [];

    // Union-find over shows in the SAME library.
    const parent = new Map<string, string>(shows.map((s) => [s.id, s.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const next = parent.get(x)!;
        parent.set(x, r);
        x = next;
      }
      return r;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));

    const yearsCompatible = (a: number | null, b: number | null) => a == null || b == null || a === b;

    for (let i = 0; i < shows.length; i++) {
      for (let j = i + 1; j < shows.length; j++) {
        const a = shows[i];
        const b = shows[j];
        if (a.libraryId !== b.libraryId) continue;
        const sameName = a.canonicalKey === b.canonicalKey && yearsCompatible(a.year, b.year);
        const sameId = !!a.imdbId && a.imdbId === b.imdbId;
        if (sameName || sameId) union(a.id, b.id);
      }
    }

    const groups = new Map<string, typeof shows>();
    for (const s of shows) {
      const root = find(s.id);
      const g = groups.get(root) ?? [];
      g.push(s);
      groups.set(root, g);
    }

    const families: DuplicateShowFamily[] = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;

      const stats = await Promise.all(
        members.map(async (m) => {
          const files = await this.videoFilesIn(m.path);
          return {
            showId: m.id,
            path: m.path,
            title: m.title,
            year: m.year,
            imdbId: m.imdbId,
            videoCount: files.length,
            sizeBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
          };
        }),
      );

      const keys = new Set(members.map((m) => m.canonicalKey));
      const ids = new Set(members.map((m) => m.imdbId).filter(Boolean));
      const namesAgree = keys.size === 1;
      const idsAgree = ids.size === 1 && ids.size > 0;
      const reason: DuplicateShowFamily['reason'] =
        namesAgree && idsAgree ? 'name+imdb' : namesAgree ? 'name' : 'imdb';

      families.push({
        reason,
        // Tied only by the id, with names that disagree — the mis-tagged case.
        needsReview: !namesAgree,
        suggestedCanonicalShowId: [...stats].sort((a, b) => b.videoCount - a.videoCount)[0].showId,
        members: stats.sort((a, b) => b.videoCount - a.videoCount),
      });
    }
    return families;
  }

  // --- preview / merge ------------------------------------------------------

  /** What {@link merge} would do. Touches no disk. */
  async preview(canonicalShowId: string, duplicateShowIds: string[]): Promise<MergePlan> {
    const { canonical, duplicates } = await this.loadShows(canonicalShowId, duplicateShowIds);
    const blockers: string[] = [];

    // Everything must sit inside the ops hard roots, and a duplicate folder must
    // never be a library root — deleting one would take the whole library with it.
    const libs = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    const roots = new Set(libs.map((l) => path.resolve(l.path)));
    for (const d of [canonical, ...duplicates]) {
      try {
        this.filePath.assertWithinHardRoots(d.path);
      } catch {
        blockers.push(`"${d.path}" is outside the allowed storage roots.`);
      }
    }
    for (const d of duplicates) {
      if (roots.has(path.resolve(d.path))) {
        blockers.push(`"${d.path}" is a library root, not a show folder — refusing to delete it.`);
      }
      if (path.resolve(d.path) === path.resolve(canonical.path)) {
        blockers.push('A folder cannot be merged into itself.');
      }
    }

    // Episodes the canonical folder already has, keyed by season/episode.
    const existing = await this.videoFilesIn(canonical.path);
    const haveByEp = new Map<string, VideoFile>();
    for (const f of existing) {
      const k = this.epKey(f);
      if (k && !haveByEp.has(k)) haveByEp.set(k, f);
    }

    const moves: MergeMove[] = [];
    const collisions: MergeCollision[] = [];

    for (const dup of duplicates) {
      for (const f of await this.videoFilesIn(dup.path)) {
        const k = this.epKey(f);
        const clash = k ? haveByEp.get(k) : undefined;
        if (clash) {
          // Same episode in both. Keep the bigger file — usually the better rip —
          // and send the loser to Trash rather than destroying it.
          const incomingWins = f.sizeBytes > clash.sizeBytes;
          collisions.push({
            season: f.season,
            episode: f.episode,
            incoming: f.path,
            incomingBytes: f.sizeBytes,
            existing: clash.path,
            existingBytes: clash.sizeBytes,
            winner: incomingWins ? 'incoming' : 'existing',
            trashed: incomingWins ? clash.path : f.path,
          });
          // The winner ends up in the canonical folder either way; only an
          // incoming winner has to be moved there.
          if (incomingWins) {
            moves.push({ from: f.path, to: path.join(canonical.path, path.basename(f.path)), sizeBytes: f.sizeBytes });
          }
          continue;
        }
        // No counterpart: move it into the canonical folder's root. A rescan then
        // runs the library's own organiser, which files it into `Season NN` using
        // the library's naming template — this service does not second-guess it.
        moves.push({ from: f.path, to: path.join(canonical.path, path.basename(f.path)), sizeBytes: f.sizeBytes });
        if (k) haveByEp.set(k, f); // two duplicates carrying the same episode
      }
    }

    return {
      canonical: { showId: canonical.id, path: canonical.path, title: canonical.title },
      duplicates: duplicates.map((d) => ({ showId: d.id, path: d.path, title: d.title })),
      moves,
      collisions,
      deletions: duplicates.map((d) => d.path),
      blockers,
    };
  }

  /**
   * Execute the merge: re-home every video file into the canonical folder, trash the
   * loser of each collision, then permanently delete the emptied duplicate folders.
   *
   * The delete is guarded: a folder is only removed once it holds **no video file**.
   * If anything is left behind the folder stays, and that is reported.
   */
  async merge(
    canonicalShowId: string,
    duplicateShowIds: string[],
    ctx: { userId?: string; ipAddress?: string; userAgent?: string } = {},
  ): Promise<MergeResult> {
    const plan = await this.preview(canonicalShowId, duplicateShowIds);
    if (plan.blockers.length) {
      throw new BadRequestException(`Refusing to merge: ${plan.blockers.join(' ')}`);
    }

    let trashed = 0;
    // Trash the losing side of every collision FIRST, so an incoming winner has a
    // free destination to move into.
    for (const c of plan.collisions) {
      await this.files.remove({ path: this.rel(c.trashed), permanent: false }, ctx);
      trashed++;
    }

    let moved = 0;
    for (const m of plan.moves) {
      await mkdir(path.dirname(m.to), { recursive: true });
      await this.move(m.from, m.to);
      moved++;
    }

    let deleted = 0;
    for (const dir of plan.deletions) {
      const left = await this.videoFilesIn(dir);
      if (left.length > 0) {
        this.logger.warn(
          `Not deleting "${dir}": ${left.length} video file(s) are still in it after the merge.`,
        );
        continue;
      }
      // Permanent — the media is already safe in the canonical folder, and what
      // remains is the empty shell plus its stray .nfo/artwork.
      await this.files.remove({ path: this.rel(dir), permanent: true }, ctx);
      deleted++;
    }

    // Re-point anything monitoring a merged show at the canonical one BEFORE the
    // rows go, so the FK's ON DELETE SET NULL can't quietly unbind the show.
    const rebound = (
      await this.prisma.mediaAcquisitionWatchlistItem.updateMany({
        where: { libraryShowId: { in: duplicateShowIds } },
        data: { libraryShowId: canonicalShowId },
      })
    ).count;

    await this.prisma.mediaShow.deleteMany({ where: { id: { in: duplicateShowIds } } });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.shows.merged',
      objectType: 'media_show',
      objectId: canonicalShowId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        canonicalPath: plan.canonical.path,
        mergedPaths: plan.deletions,
        moved,
        trashed,
        deleted,
        rebound,
      },
    });
    this.logger.log(
      `Merged ${duplicateShowIds.length} duplicate folder(s) into "${plan.canonical.path}": ` +
        `${moved} moved, ${trashed} trashed, ${deleted} folder(s) deleted, ${rebound} watchlist item(s) re-pointed.`,
    );

    return { ...plan, moved, trashed, deleted, rebound };
  }

  // --- helpers --------------------------------------------------------------

  private async loadShows(canonicalShowId: string, duplicateShowIds: string[]) {
    if (!duplicateShowIds?.length) throw new BadRequestException('No duplicate shows given');
    if (duplicateShowIds.includes(canonicalShowId)) {
      throw new BadRequestException('The canonical show cannot also be one of the duplicates');
    }
    const canonical = await this.prisma.mediaShow.findUnique({ where: { id: canonicalShowId } });
    if (!canonical) throw new NotFoundException('Canonical show not found');
    const duplicates = await this.prisma.mediaShow.findMany({ where: { id: { in: duplicateShowIds } } });
    if (duplicates.length !== duplicateShowIds.length) throw new NotFoundException('A duplicate show was not found');
    if (duplicates.some((d) => d.libraryId !== canonical.libraryId)) {
      throw new BadRequestException('Shows from different libraries cannot be merged');
    }
    return { canonical, duplicates };
  }

  /** `s<season>e<episode>`, or null when the file names no episode. */
  private epKey(f: VideoFile): string | null {
    return f.season != null && f.episode != null ? `s${f.season}e${f.episode}` : null;
  }

  /** Every video file under `dir`, with its season/episode and size. */
  private async videoFilesIn(dir: string): Promise<VideoFile[]> {
    const out: VideoFile[] = [];
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return; // folder gone or unreadable — nothing to report
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || e.name === '@eaDir') continue;
          await walk(p);
        } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
          const identity = parseItemIdentity(p);
          const s = await stat(p).catch(() => null);
          out.push({
            path: p,
            sizeBytes: s ? Number(s.size) : 0,
            season: identity.season ?? null,
            episode: identity.episode ?? identity.absoluteEpisode ?? null,
          });
        }
      }
    };
    await walk(dir);
    return out;
  }

  /** Absolute → root-relative, the form the file manager's operations take. */
  private rel(absPath: string): string {
    return this.filePath.safety.toRelative(absPath);
  }

  /** Rename, falling back to copy+unlink when the move crosses a filesystem. */
  private async move(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      const { copyFile, unlink } = await import('node:fs/promises');
      await copyFile(from, to);
      await unlink(from);
    }
  }
}
