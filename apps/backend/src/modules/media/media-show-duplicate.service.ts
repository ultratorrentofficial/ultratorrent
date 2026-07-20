import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readdir, rename, stat, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { FilesService } from '../files/files.service';
import { AuditService } from '../audit/audit.service';
import { VIDEO_EXT } from './media-scanner.service';
import { parseItemIdentity } from './media-identification.service';
import { showCanonicalKey } from './series-grouping';
import { LANG_TAG, SUBTITLE_EXT } from './media-renamer';

/** Companion files, split by what losing them would cost. */
export interface SidecarCounts {
  /** Content. Losing one loses a translation that may exist nowhere else. */
  subtitles: number;
  /** Describes a video; worthless once the video is gone. */
  nfo: number;
  artwork: number;
  other: number;
}

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
  /** `S02E01`, sorted. Files whose name carries no episode are not listed. */
  episodes: string[];
  /** Episodes this folder has that no other folder in the family has. */
  uniqueEpisodes: string[];
  sidecars: SidecarCounts;
  /** Watchlist items pointing at this folder's show row. */
  watchlistCount: number;
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
  /**
   * Why review is required, or null when it is not. `metadata_conflict` is the
   * external-ID-only case above — the UI labels it "Metadata Conflict — Manual
   * Review Required", and merging one requires an explicit acknowledgement.
   */
  reviewReason: 'metadata_conflict' | null;
  /** Episodes present in more than one folder — the merge will have to choose. */
  collidingEpisodes: string[];
  /** The member with the most video files — a suggestion, never applied on its own. */
  suggestedCanonicalShowId: string;
  members: DuplicateShowMember[];
}

/**
 * A bounded page of families.
 *
 * The response used to be a bare unbounded array, and building each entry walks
 * every member folder recursively. So the candidate set is computed from rows in
 * memory (cheap) and only the page being returned touches disk (not cheap) —
 * `total` still reports how many families exist.
 */
export interface DuplicateShowPage {
  families: DuplicateShowFamily[];
  total: number;
  limit: number;
  truncated: boolean;
}

/** Families returned when the caller does not ask for a specific number. */
const DEFAULT_FAMILIES = 25;
/** Hard ceiling — each family costs a recursive directory walk per member. */
const MAX_FAMILIES = 100;

/** One file that would move into the canonical folder. */
export interface MergeMove {
  from: string;
  to: string;
  sizeBytes: number;
  /** `sidecar`/`rescued_subtitle` files ride along with the video they belong to. */
  kind: 'video' | 'sidecar' | 'rescued_subtitle';
}

/** The same episode present in more than one folder. One copy survives. */
export interface MergeCollision {
  /** `s2e1` — the key a manual choice is made against. */
  key: string;
  season: number | null;
  episode: number | null;
  incoming: string;
  incomingBytes: number;
  existing: string;
  existingBytes: number;
  winner: 'incoming' | 'existing';
  /** True when the operator picked the winner rather than the size rule. */
  chosenByOperator: boolean;
  /** The file that loses — moved to Trash, never destroyed outright. */
  trashed: string;
}

/** A subtitle rescued off a losing copy because its language exists nowhere else. */
export interface RescuedSubtitle {
  from: string;
  to: string;
  language: string | null;
}

export interface MergePlan {
  /** The stored plan. `merge` takes this and nothing else. */
  planId: string;
  canonical: { showId: string; path: string; title: string };
  duplicates: Array<{ showId: string; path: string; title: string }>;
  moves: MergeMove[];
  collisions: MergeCollision[];
  /**
   * Subtitles that only existed beside a copy being removed. They are carried into
   * the canonical folder and renamed to sit beside the surviving video, because the
   * folder they live in is about to be deleted — leaving them would destroy them.
   */
  rescuedSubtitles: RescuedSubtitle[];
  /** Watchlist items that will be re-pointed at the canonical show. */
  watchlistRepoint: number;
  /** Duplicate show folders that will be sent to Trash once emptied of media. */
  deletions: string[];
  /** Anything that makes the merge unsafe. Non-empty → `merge` refuses. */
  blockers: string[];
  /** Safe, but the operator should know. Never blocks. */
  warnings: string[];
  /** Bytes reclaimed by trashing collision losers. Moves free nothing. */
  expectedFreedBytes: number;
}

export interface MergeResult {
  planId: string;
  status: 'completed' | 'partial' | 'failed';
  canonical: { showId: string; path: string; title: string };
  moved: number;
  trashed: number;
  rescued: number;
  deleted: number;
  skipped: number;
  failed: number;
  /** Watchlist items re-pointed from a merged show to the canonical one. */
  rebound: number;
  reclaimedBytes: number;
  /** The library to rescan — the caller runs it; this service does not scan. */
  libraryId: string;
}

/** One journalled step of a merge. Order in the array is execution order. */
type PlannedShowAction =
  | { type: 'trash'; sourcePath: string; size: number; note: string }
  | { type: 'move'; sourcePath: string; destinationPath: string; size: number; kind: MergeMove['kind'] }
  | { type: 'repoint_watchlist'; showIds: string[]; canonicalShowId: string }
  | { type: 'delete_empty_dir'; sourcePath: string };

interface StoredShowMergePlan {
  canonical: MergePlan['canonical'];
  duplicates: MergePlan['duplicates'];
  duplicateShowIds: string[];
  libraryId: string;
  actions: PlannedShowAction[];
  blockers: string[];
}

interface VideoFile {
  path: string;
  sizeBytes: number;
  season: number | null;
  episode: number | null;
}

const ARTWORK_EXT = new Set(['.jpg', '.jpeg', '.png', '.tbn', '.webp']);

export interface ShowMergeContext {
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface PreviewMergeInput {
  canonicalShowId: string;
  duplicateShowIds: string[];
  /**
   * `s2e1` → the absolute path to KEEP. Overrides the largest-file rule for that
   * episode, which is a heuristic and sometimes wrong (a bloated upscale beats a
   * clean 1080p on size alone).
   */
  collisionChoices?: Record<string, string>;
  /**
   * Required to plan a family whose folders are tied together only by an external
   * ID. Never merge solely because of a suspicious external ID — without this the
   * plan carries a blocker.
   */
  acknowledgeMetadataConflict?: boolean;
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
 * Nothing here is automatic. Detection only reports; the operator chooses which path
 * is the real one, previews every move and deletion, and confirms.
 *
 * Three properties this is built around, each the fix for a defect the redesign
 * review recorded against the previous implementation:
 *
 * 1. **The plan that executes is the plan that was approved.** `preview` persists
 *    the plan; `merge` takes a plan id and runs the stored actions. It used to
 *    recompute the plan at execute time, so anything that changed on disk between
 *    the operator reading the preview and pressing confirm silently changed what
 *    ran. A show family has no `version` to pin to, so the plan is pinned to a
 *    fingerprint of every input file's path and size.
 *
 * 2. **Sidecars ride with their video.** The old merge moved video files only and
 *    then *permanently* deleted the duplicate folder — which destroyed every `.srt`
 *    in it. Subtitles are content, not metadata: a language that exists nowhere else
 *    is rescued onto the surviving copy rather than deleted with the folder.
 *
 * 3. **Folders go to Trash, not to `rm`.** The media is already safe in the
 *    canonical folder by then, but "already safe" is a belief about a filesystem
 *    operation that just happened, and Trash costs nothing to be wrong about.
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
  async detect(libraryId?: string, limit = DEFAULT_FAMILIES): Promise<DuplicateShowPage> {
    const shows = await this.prisma.mediaShow.findMany({
      where: libraryId ? { libraryId } : undefined,
      select: { id: true, libraryId: true, path: true, title: true, year: true, imdbId: true, canonicalKey: true },
    });
    if (shows.length < 2) return { families: [], total: 0, limit, truncated: false };

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

    // Bucket by the two things that can tie folders together, then compare only
    // within a bucket. The previous pass compared every show against every other
    // show — 665 shows on a live host is 220k comparisons, and a 10k-show library
    // would be 50M for a relation that only ever holds between same-key or same-id
    // folders.
    const byName = new Map<string, typeof shows>();
    const byImdb = new Map<string, typeof shows>();
    for (const s of shows) {
      const nameKey = `${s.libraryId} ${s.canonicalKey}`;
      byName.set(nameKey, [...(byName.get(nameKey) ?? []), s]);
      if (s.imdbId) {
        const idKey = `${s.libraryId} ${s.imdbId}`;
        byImdb.set(idKey, [...(byImdb.get(idKey) ?? []), s]);
      }
    }

    // Same canonical key, but only where the years do not contradict each other —
    // `Dark Matter (2015)` and `Dark Matter (2024)` share a bucket and must still
    // not be joined.
    for (const bucket of byName.values()) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          if (yearsCompatible(bucket[i].year, bucket[j].year)) union(bucket[i].id, bucket[j].id);
        }
      }
    }
    // A shared IMDb id joins unconditionally — and is flagged downstream.
    for (const bucket of byImdb.values()) {
      for (let i = 1; i < bucket.length; i++) union(bucket[0].id, bucket[i].id);
    }

    const grouped = new Map<string, typeof shows>();
    for (const s of shows) {
      const root = find(s.id);
      const g = grouped.get(root) ?? [];
      g.push(s);
      grouped.set(root, g);
    }

    // Grouping is cheap (it reads rows already in memory); walking a folder is not
    // — it is a recursive readdir + a stat per file, per member. So the candidate
    // set is decided FIRST and only the page being returned touches disk. Ordered
    // by folder count so the messiest families surface before the cap bites.
    const candidates = [...grouped.values()]
      .filter((g) => g.length > 1)
      .sort((a, b) => b.length - a.length);
    const total = candidates.length;
    const page = candidates.slice(0, Math.max(1, Math.min(limit, MAX_FAMILIES)));

    // Watchlist linkage for every candidate at once, rather than a query per folder.
    const candidateIds = page.flatMap((g) => g.map((s) => s.id));
    const watchCounts = new Map<string, number>();
    if (candidateIds.length) {
      const rows = await this.prisma.mediaAcquisitionWatchlistItem.groupBy({
        by: ['libraryShowId'],
        where: { libraryShowId: { in: candidateIds } },
        _count: { _all: true },
      });
      for (const r of rows as Array<{ libraryShowId: string | null; _count: { _all: number } }>) {
        if (r.libraryShowId) watchCounts.set(r.libraryShowId, r._count._all);
      }
    }

    const families: DuplicateShowFamily[] = [];
    for (const members of page) {
      const scanned = await Promise.all(
        members.map(async (m) => {
          const files = await this.videoFilesIn(m.path);
          return {
            show: m,
            files,
            sidecars: await this.sidecarCountsIn(m.path),
            episodes: [...new Set(files.map((f) => this.epKey(f)).filter((k): k is string => !!k))],
          };
        }),
      );

      // An episode is "unique" to a folder when no OTHER folder in the family has
      // it — the count that tells an operator how much this folder actually adds.
      const seenIn = new Map<string, number>();
      for (const s of scanned) for (const k of s.episodes) seenIn.set(k, (seenIn.get(k) ?? 0) + 1);

      const stats: DuplicateShowMember[] = scanned.map((s) => ({
        showId: s.show.id,
        path: s.show.path,
        title: s.show.title,
        year: s.show.year,
        imdbId: s.show.imdbId,
        videoCount: s.files.length,
        sizeBytes: s.files.reduce((n, f) => n + f.sizeBytes, 0),
        episodes: s.episodes.slice().sort(),
        uniqueEpisodes: s.episodes.filter((k) => seenIn.get(k) === 1).sort(),
        sidecars: s.sidecars,
        watchlistCount: watchCounts.get(s.show.id) ?? 0,
      }));

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
        reviewReason: namesAgree ? null : 'metadata_conflict',
        collidingEpisodes: [...seenIn.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort(),
        suggestedCanonicalShowId: [...stats].sort((a, b) => b.videoCount - a.videoCount)[0].showId,
        members: stats.sort((a, b) => b.videoCount - a.videoCount),
      });
    }
    return { families, total, limit, truncated: total > families.length };
  }

  // --- preview --------------------------------------------------------------

  /**
   * Build and persist a merge plan. Touches no disk.
   *
   * Returns the full plan for the operator to read AND a `planId`; {@link merge}
   * accepts only the id, so what runs is what was displayed and a caller cannot
   * hand-craft a list of files to move and delete.
   */
  async preview(input: PreviewMergeInput, ctx: ShowMergeContext = {}): Promise<MergePlan> {
    const { canonical, duplicates } = await this.loadShows(input.canonicalShowId, input.duplicateShowIds);
    const blockers: string[] = [];
    const warnings: string[] = [];

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

    // Never merge solely because of a suspicious external ID. Folder names that
    // disagree mean one mis-tagged item may be all that ties these together, so the
    // operator has to say out loud that they have checked.
    const keys = new Set([canonical, ...duplicates].map((s) => s.canonicalKey || showCanonicalKey(s.title)));
    if (keys.size > 1 && !input.acknowledgeMetadataConflict) {
      blockers.push(
        'Metadata Conflict — Manual Review Required: these folders are named differently and are tied ' +
          'together only by a shared external ID. Confirm they are the same show before merging.',
      );
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
    const rescuedSubtitles: RescuedSubtitle[] = [];
    const trashActions: Array<{ sourcePath: string; size: number; note: string }> = [];

    // Two files may not target the same name in the canonical folder, and nothing
    // may land on a file that is already there. Both are silent overwrites — i.e.
    // data loss — so they block rather than resolve themselves.
    const claimed = new Map<string, string>();
    const claim = async (dest: string, from: string): Promise<boolean> => {
      const prior = claimed.get(dest);
      if (prior) {
        blockers.push(
          `"${path.basename(dest)}" would be written twice in the canonical folder — by "${prior}" and "${from}". ` +
            'Rename or remove one before merging.',
        );
        return false;
      }
      const onDisk = await stat(dest).then(() => true).catch(() => false);
      if (onDisk) {
        blockers.push(
          `"${dest}" already exists and is not a recognised duplicate of "${from}". Refusing to overwrite it.`,
        );
        return false;
      }
      claimed.set(dest, from);
      return true;
    };

    for (const dup of duplicates) {
      for (const f of await this.videoFilesIn(dup.path)) {
        const k = this.epKey(f);
        const clash = k ? haveByEp.get(k) : undefined;

        if (clash && k) {
          // Same episode in both. The bigger file usually wins — but the operator
          // can override, because size is a proxy for quality and a poor one.
          const choice = input.collisionChoices?.[k];
          const chosenByOperator =
            !!choice && (path.resolve(choice) === path.resolve(f.path) || path.resolve(choice) === path.resolve(clash.path));
          if (choice && !chosenByOperator) {
            blockers.push(`The chosen copy for ${k.toUpperCase()} is not one of that episode's files.`);
            continue;
          }
          const incomingWins = chosenByOperator
            ? path.resolve(choice!) === path.resolve(f.path)
            : f.sizeBytes > clash.sizeBytes;

          const winner = incomingWins ? f : clash;
          const loser = incomingWins ? clash : f;
          collisions.push({
            key: k,
            season: f.season,
            episode: f.episode,
            incoming: f.path,
            incomingBytes: f.sizeBytes,
            existing: clash.path,
            existingBytes: clash.sizeBytes,
            winner: incomingWins ? 'incoming' : 'existing',
            chosenByOperator,
            trashed: loser.path,
          });

          // Where the winner ends up — the destination a rescued subtitle has to
          // sit beside.
          const winnerFinal = incomingWins ? path.join(canonical.path, path.basename(f.path)) : clash.path;
          if (incomingWins) {
            if (await claim(winnerFinal, f.path)) {
              moves.push({ from: f.path, to: winnerFinal, sizeBytes: f.sizeBytes, kind: 'video' });
              // The winner replaces the loser for any later duplicate carrying the
              // same episode.
              haveByEp.set(k, { ...f, path: winnerFinal });
            }
          }

          const rescued = await this.planLoserSidecars(loser.path, winnerFinal, trashActions, claim);
          rescuedSubtitles.push(...rescued);
          for (const r of rescued) {
            moves.push({ from: r.from, to: r.to, sizeBytes: 0, kind: 'rescued_subtitle' });
          }
          trashActions.push({ sourcePath: loser.path, size: loser.sizeBytes, note: `collision loser for ${k}` });
          continue;
        }

        // No counterpart: move it into the canonical folder's root, with everything
        // named after it. A rescan then runs the library's own organiser, which
        // files it into `Season NN` using the library's naming template — this
        // service does not second-guess it.
        const dest = path.join(canonical.path, path.basename(f.path));
        if (!(await claim(dest, f.path))) continue;
        moves.push({ from: f.path, to: dest, sizeBytes: f.sizeBytes, kind: 'video' });
        for (const sc of await this.sidecarsOf(f.path)) {
          const scDest = path.join(canonical.path, path.basename(sc));
          if (!(await claim(scDest, sc))) continue;
          const st = await stat(sc).catch(() => null);
          moves.push({ from: sc, to: scDest, sizeBytes: st?.size ?? 0, kind: 'sidecar' });
        }
        if (k) haveByEp.set(k, { ...f, path: dest }); // two duplicates carrying the same episode
      }
    }

    if (rescuedSubtitles.length) {
      warnings.push(
        `${rescuedSubtitles.length} subtitle(s) exist only beside a copy being removed and will be carried over ` +
          `to the kept copy: ${rescuedSubtitles.map((r) => path.basename(r.from)).join(', ')}`,
      );
    }

    const watchlistRepoint = await this.prisma.mediaAcquisitionWatchlistItem.count({
      where: { libraryShowId: { in: input.duplicateShowIds } },
    });

    // Order matters: trash the losers first so an incoming winner has a free
    // destination, then move, then re-point, then remove the emptied shells.
    const actions: PlannedShowAction[] = [
      ...trashActions.map((t) => ({ type: 'trash' as const, ...t })),
      ...moves.map((m) => ({
        type: 'move' as const,
        sourcePath: m.from,
        destinationPath: m.to,
        size: m.sizeBytes,
        kind: m.kind,
      })),
      {
        type: 'repoint_watchlist' as const,
        showIds: input.duplicateShowIds,
        canonicalShowId: input.canonicalShowId,
      },
      ...duplicates.map((d) => ({ type: 'delete_empty_dir' as const, sourcePath: d.path })),
    ];

    const stored: StoredShowMergePlan = {
      canonical: { showId: canonical.id, path: canonical.path, title: canonical.title },
      duplicates: duplicates.map((d) => ({ showId: d.id, path: d.path, title: d.title })),
      duplicateShowIds: input.duplicateShowIds,
      libraryId: canonical.libraryId,
      actions,
      blockers,
    };
    const expectedFreedBytes = trashActions.reduce((n, t) => n + t.size, 0);

    const row = await this.prisma.mediaDuplicateResolution.create({
      data: {
        scope: 'show_merge',
        status: 'pending',
        canonicalShowId: canonical.id,
        inputFingerprint: await this.fingerprint([canonical.path, ...duplicates.map((d) => d.path)]),
        preview: stored as unknown as object,
        expectedSavingsBytes: BigInt(expectedFreedBytes),
        createdById: ctx.userId ?? null,
      },
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.shows.merge_preview',
      objectType: 'media_show',
      objectId: canonical.id,
      result: blockers.length ? 'failure' : 'success',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        planId: row.id,
        canonicalPath: canonical.path,
        duplicatePaths: duplicates.map((d) => d.path),
        moves: moves.length,
        collisions: collisions.length,
        rescuedSubtitles: rescuedSubtitles.length,
        blockers: blockers.length,
      },
    });

    return {
      planId: row.id,
      canonical: stored.canonical,
      duplicates: stored.duplicates,
      moves,
      collisions,
      rescuedSubtitles,
      watchlistRepoint,
      deletions: duplicates.map((d) => d.path),
      blockers,
      warnings,
      expectedFreedBytes,
    };
  }

  // --- merge ----------------------------------------------------------------

  /**
   * Execute a previously previewed plan.
   *
   * Reads the stored plan rather than accepting one from the client, refuses a stale
   * plan, revalidates every path immediately before touching it, and journals each
   * step before attempting it — a database transaction cannot roll back a file that
   * has already moved.
   */
  async merge(planId: string, ctx: ShowMergeContext = {}): Promise<MergeResult> {
    const row = await this.prisma.mediaDuplicateResolution.findUnique({ where: { id: planId } });
    if (!row || row.scope !== 'show_merge') throw new NotFoundException('Merge plan not found');
    if (row.status !== 'pending') throw new ConflictException(`This plan is already ${row.status}.`);

    const plan = row.preview as unknown as StoredShowMergePlan | null;
    if (!plan) throw new BadRequestException('This plan has no stored preview.');
    if (plan.blockers?.length) {
      throw new BadRequestException(`Refusing to merge: ${plan.blockers.join(' ')}`);
    }

    // A show family has no version column, so the disk is the version. Anything
    // added, removed or resized in any of these folders since the preview means the
    // operator approved a plan that no longer describes reality.
    const now = await this.fingerprint([plan.canonical.path, ...plan.duplicates.map((d) => d.path)]);
    if (now !== row.inputFingerprint) {
      await this.prisma.mediaDuplicateResolution.update({
        where: { id: planId },
        data: { status: 'failed', failedAt: new Date(), errorSummary: 'stale_plan' },
      });
      throw new ConflictException(
        'These folders changed since the preview was generated. Review the merge again before running it.',
      );
    }

    await this.prisma.mediaDuplicateResolution.update({
      where: { id: planId },
      data: { status: 'running', startedAt: new Date() },
    });

    const libs = await this.prisma.mediaLibrary.findMany({ select: { path: true } });
    const roots = new Set(libs.map((l) => path.resolve(l.path)));

    let moved = 0;
    let trashed = 0;
    let rescued = 0;
    let deleted = 0;
    let skipped = 0;
    let failed = 0;
    let reclaimed = 0;
    let rebound = 0;

    for (const action of plan.actions) {
      // Journal BEFORE the filesystem step: a crash between here and the next write
      // leaves a `running` row naming exactly what was in flight.
      const journal = await this.prisma.mediaDuplicateResolutionAction.create({
        data: {
          resolutionId: planId,
          actionType: action.type,
          status: 'running',
          sourcePath: 'sourcePath' in action ? action.sourcePath : null,
          destinationPath: action.type === 'move' ? action.destinationPath : null,
          metadata: action as unknown as object,
        },
      });
      const finish = (status: string, errorMessage?: string) =>
        this.prisma.mediaDuplicateResolutionAction.update({
          where: { id: journal.id },
          data: { status, errorMessage: errorMessage ?? null },
        });

      try {
        if (action.type === 'repoint_watchlist') {
          // Re-point anything monitoring a merged show at the canonical one BEFORE
          // the rows go, so the FK's ON DELETE SET NULL can't quietly unbind it.
          rebound = (
            await this.prisma.mediaAcquisitionWatchlistItem.updateMany({
              where: { libraryShowId: { in: action.showIds } },
              data: { libraryShowId: action.canonicalShowId },
            })
          ).count;
          await finish('completed');
          continue;
        }

        if (action.type === 'delete_empty_dir') {
          this.filePath.assertWithinHardRoots(action.sourcePath);
          if (roots.has(path.resolve(action.sourcePath))) {
            throw new Error('refusing to delete a library root');
          }
          // Only once the folder holds no media AND no subtitle. Artwork and .nfo
          // are regenerable; a video or a translation is not.
          const left = await this.mediaFilesLeftIn(action.sourcePath);
          if (left.length) {
            await finish('skipped', `${left.length} media file(s) still present: ${left.slice(0, 3).map((p) => path.basename(p)).join(', ')}`);
            this.logger.warn(`Not deleting "${action.sourcePath}": ${left.length} media file(s) remain.`);
            skipped++;
            continue;
          }
          // Trash, not `rm`. The media is already in the canonical folder — but
          // "already" is a belief about an operation that just happened.
          await this.files.remove({ path: this.rel(action.sourcePath), permanent: false }, ctx);
          deleted++;
          await finish('completed');
          continue;
        }

        // Both remaining types touch a source file. Revalidate against the world as
        // it is NOW, not as the preview described it.
        this.filePath.assertWithinHardRoots(action.sourcePath);
        if (roots.has(path.resolve(action.sourcePath))) {
          throw new Error('refusing to touch a library root');
        }
        const st = await stat(action.sourcePath).catch(() => null);
        if (!st?.isFile()) {
          await finish('skipped', 'file no longer exists');
          skipped++;
          continue;
        }

        if (action.type === 'trash') {
          // A size change means the file was replaced or is still being written.
          // The operator approved trashing a specific file, not whatever now sits
          // at that path.
          if (action.size > 0 && st.size !== action.size) {
            await finish('skipped', `size changed since preview (${action.size} → ${st.size})`);
            skipped++;
            continue;
          }
          await this.files.remove({ path: this.rel(action.sourcePath), permanent: false }, ctx);
          reclaimed += st.size;
          trashed++;
          await finish('completed');
          continue;
        }

        // move
        this.filePath.assertWithinHardRoots(action.destinationPath);
        const destExists = await stat(action.destinationPath).then(() => true).catch(() => false);
        if (destExists) {
          await finish('skipped', 'destination already exists — refusing to overwrite');
          skipped++;
          continue;
        }
        await mkdir(path.dirname(action.destinationPath), { recursive: true });
        await this.move(action.sourcePath, action.destinationPath);
        if (action.kind === 'rescued_subtitle') rescued++;
        moved++;
        await finish('completed');
      } catch (err) {
        failed++;
        this.logger.warn(`Show merge step (${action.type}) failed: ${(err as Error).message}`);
        await finish('failed', (err as Error).message);
      }
    }

    // The show rows go only if their folders are actually gone. Deleting a row whose
    // folder survived would hide the folder from the next detection pass, leaving a
    // duplicate nobody can see.
    let rowsDeleted = 0;
    if (deleted === plan.duplicates.length) {
      rowsDeleted = (
        await this.prisma.mediaShow.deleteMany({ where: { id: { in: plan.duplicateShowIds } } })
      ).count;
    }

    const status: MergeResult['status'] = failed > 0 ? (moved + trashed > 0 ? 'partial' : 'failed') : 'completed';
    await this.prisma.mediaDuplicateResolution.update({
      where: { id: planId },
      data: {
        status,
        actualSavingsBytes: BigInt(reclaimed),
        completedAt: status === 'failed' ? null : new Date(),
        failedAt: status === 'failed' ? new Date() : null,
        errorSummary: failed ? `${failed} step(s) failed` : null,
      },
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.shows.merged',
      objectType: 'media_show',
      objectId: plan.canonical.showId,
      result: status === 'completed' ? 'success' : 'failure',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: {
        planId,
        status,
        canonicalPath: plan.canonical.path,
        mergedPaths: plan.duplicates.map((d) => d.path),
        moved,
        trashed,
        rescued,
        deleted,
        skipped,
        failed,
        rebound,
        rowsDeleted,
      },
    });
    this.logger.log(
      `Merged ${plan.duplicates.length} duplicate folder(s) into "${plan.canonical.path}" (${status}): ` +
        `${moved} moved, ${trashed} trashed, ${rescued} subtitle(s) rescued, ${deleted} folder(s) trashed, ` +
        `${skipped} skipped, ${failed} failed, ${rebound} watchlist item(s) re-pointed.`,
    );

    return {
      planId,
      status,
      canonical: plan.canonical,
      moved,
      trashed,
      rescued,
      deleted,
      skipped,
      failed,
      rebound,
      reclaimedBytes: reclaimed,
      libraryId: plan.libraryId,
    };
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

  /**
   * The losing copy's companions: trash what merely describes it, rescue what does
   * not exist anywhere else.
   *
   * A `.nfo` or `-thumb.jpg` describes a specific video and is worthless once that
   * video is gone. A subtitle is content — and the folder it lives in is about to be
   * deleted, so leaving it in place (what the file-level cleanup does) would destroy
   * it here. Any language the winner does not already have is carried over and
   * renamed to sit beside the winner, which is what makes a player find it.
   */
  private async planLoserSidecars(
    loserPath: string,
    winnerFinalPath: string,
    trashActions: Array<{ sourcePath: string; size: number; note: string }>,
    claim: (dest: string, from: string) => Promise<boolean>,
  ): Promise<RescuedSubtitle[]> {
    const winnerDir = path.dirname(winnerFinalPath);
    const winnerStem = path.basename(winnerFinalPath, path.extname(winnerFinalPath));
    const loserStem = path.basename(loserPath, path.extname(loserPath));

    const winnerLangs = new Set(
      (await this.sidecarsOf(winnerFinalPath))
        .filter((f) => SUBTITLE_EXT.has(path.extname(f).toLowerCase()))
        .map((f) => this.subtitleLanguage(f)),
    );

    const rescued: RescuedSubtitle[] = [];
    for (const sc of await this.sidecarsOf(loserPath)) {
      const ext = path.extname(sc).toLowerCase();
      if (SUBTITLE_EXT.has(ext)) {
        const lang = this.subtitleLanguage(sc);
        if (!winnerLangs.has(lang)) {
          // Keep the marker that follows the stem (`.por`, `-forced`) so the
          // rescued file stays distinguishable from the winner's own subtitles.
          const suffix = path.basename(sc, path.extname(sc)).slice(loserStem.length);
          const dest = path.join(winnerDir, `${winnerStem}${suffix}${path.extname(sc)}`);
          if (await claim(dest, sc)) {
            rescued.push({ from: sc, to: dest, language: lang });
            winnerLangs.add(lang);
          }
          continue;
        }
      }
      const st = await stat(sc).catch(() => null);
      if (!st?.isFile()) continue;
      trashActions.push({ sourcePath: sc, size: st.size, note: `sidecar of ${path.basename(loserPath)}` });
    }
    return rescued;
  }

  /**
   * Files named after `videoPath` that belong to it: `.nfo`, `-thumb.jpg`,
   * `.en.srt`. Matched STRUCTURALLY — basename plus an optional `-`/`.` suffix —
   * the same rule the renamer's sidecar pass and the file-level duplicate cleanup
   * use, so all three agree about what belongs to what. That rule is also what keeps
   * SHOW-LEVEL files out: `poster.jpg`, `tvshow.nfo` and `theme.mp3` are named after
   * the FOLDER, not the episode, so they never match and are never moved or trashed.
   */
  private async sidecarsOf(videoPath: string): Promise<string[]> {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries
      .filter((name) => {
        const full = path.join(dir, name);
        if (full === videoPath) return false;
        if (VIDEO_EXT.has(path.extname(name).toLowerCase())) return false;
        const stem = path.basename(name, path.extname(name));
        if (!stem.startsWith(base)) return false;
        const suffix = stem.slice(base.length);
        // Same name, or the video's name plus a marker. A bare extra character means
        // a DIFFERENT file ("Episode 2" vs "Episode 20").
        return suffix === '' || /^[-.]/.test(suffix);
      })
      .map((name) => path.join(dir, name));
  }

  /** `foo.por.srt` → `por`. Null when the name carries no language tag. */
  private subtitleLanguage(p: string): string | null {
    const stem = path.basename(p, path.extname(p));
    const m = LANG_TAG.exec(stem);
    return m ? m[1].toLowerCase() : null;
  }

  /** `s<season>e<episode>`, or null when the file names no episode. */
  private epKey(f: VideoFile): string | null {
    return f.season != null && f.episode != null ? `s${f.season}e${f.episode}` : null;
  }

  /**
   * A digest of every file's path and size under these folders.
   *
   * Stands in for the `version` column a show family does not have. Size is included
   * because a same-named file of a different size is a different file, and that is
   * exactly the substitution a plan must not run blind into.
   */
  private async fingerprint(dirs: string[]): Promise<string> {
    const parts: string[] = [];
    for (const dir of [...dirs].sort()) {
      for (const f of await this.allFilesIn(dir)) parts.push(`${f.path} ${f.size}`);
    }
    return createHash('sha256').update(parts.sort().join('\n')).digest('hex');
  }

  /** Every video file under `dir`, with its season/episode and size. */
  private async videoFilesIn(dir: string): Promise<VideoFile[]> {
    const out: VideoFile[] = [];
    for (const f of await this.allFilesIn(dir)) {
      if (!VIDEO_EXT.has(path.extname(f.path).toLowerCase())) continue;
      const identity = parseItemIdentity(f.path);
      out.push({
        path: f.path,
        sizeBytes: f.size,
        season: identity.season ?? null,
        episode: identity.episode ?? identity.absoluteEpisode ?? null,
      });
    }
    return out;
  }

  /** Videos and subtitles still under `dir` — the things worth refusing to delete over. */
  private async mediaFilesLeftIn(dir: string): Promise<string[]> {
    return (await this.allFilesIn(dir))
      .map((f) => f.path)
      .filter((p) => {
        const ext = path.extname(p).toLowerCase();
        return VIDEO_EXT.has(ext) || SUBTITLE_EXT.has(ext);
      });
  }

  private async sidecarCountsIn(dir: string): Promise<SidecarCounts> {
    const counts: SidecarCounts = { subtitles: 0, nfo: 0, artwork: 0, other: 0 };
    for (const f of await this.allFilesIn(dir)) {
      const ext = path.extname(f.path).toLowerCase();
      if (VIDEO_EXT.has(ext)) continue;
      if (SUBTITLE_EXT.has(ext)) counts.subtitles++;
      else if (ext === '.nfo') counts.nfo++;
      else if (ARTWORK_EXT.has(ext)) counts.artwork++;
      else counts.other++;
    }
    return counts;
  }

  /** Every file under `dir`, dot-directories and Synology's `@eaDir` excluded. */
  private async allFilesIn(dir: string): Promise<Array<{ path: string; size: number }>> {
    const out: Array<{ path: string; size: number }> = [];
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
        } else if (!e.name.startsWith('.')) {
          const s = await stat(p).catch(() => null);
          out.push({ path: p, size: s ? Number(s.size) : 0 });
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
