import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { pageOf, parsePage } from '../../common/pagination';
import type { ListDuplicatesDto } from './dto/duplicates.dto';
import { recommend } from './duplicate-recommendation';

/** Reasons two items are considered duplicates, in descending confidence. */
export type DuplicateReason =
  | 'external_id'
  | 'show_season_episode'
  | 'title_year'
  | 'similar_filename';

export interface DuplicateItemLike {
  id: string;
  mediaType: string;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  externalIds?: Array<{ provider: string; externalId: string }>;
  files?: Array<{
    resolution: string | null;
    videoCodec: string | null;
    size: bigint | number;
  }>;
}

/** Normalise a title for comparison: lowercase, strip punctuation/spacing. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/['`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The season/episode marker for an item: the structured `season`/`episode`
 * columns, else an `SxxEyy` parsed from the raw title (unidentified episodes keep
 * it in their filename). '' when neither is present. Pure — exported for testing.
 */
export function episodeMarker(item: DuplicateItemLike): string {
  if (item.season != null || item.episode != null) {
    return `:s${item.season ?? 'x'}:e${item.episode ?? 'x'}`;
  }
  const m = /\bs(\d{1,2})[ ._-]?e(\d{1,3})\b/i.exec(item.title);
  return m ? `:s${Number(m[1])}:e${Number(m[2])}` : '';
}

const RES_RANK: Record<string, number> = {
  '2160p': 5,
  '1080p': 4,
  '1080i': 3,
  '720p': 2,
  '480p': 1,
};
const CODEC_RANK: Record<string, number> = { AV1: 4, x265: 3, x264: 2, XviD: 1 };

/** A comparable quality score for an item from its best file. Pure. */
export function qualityScore(item: DuplicateItemLike): number {
  let best = 0;
  for (const f of item.files ?? []) {
    const res = f.resolution ? (RES_RANK[f.resolution] ?? 0) : 0;
    const codec = f.videoCodec ? (CODEC_RANK[f.videoCodec] ?? 0) : 0;
    const score = res * 10 + codec;
    if (score > best) best = score;
  }
  return best;
}

/**
 * Compute the grouping keys for an item across all duplicate strategies. Pure —
 * exported for unit testing. Each key is prefixed with its reason so keys from
 * different strategies never collide.
 */
export function duplicateKeys(item: DuplicateItemLike): Array<{
  reason: DuplicateReason;
  key: string;
}> {
  const keys: Array<{ reason: DuplicateReason; key: string }> = [];
  const normTitle = normalizeTitle(item.title);
  const isMovie = !item.mediaType || item.mediaType === 'movie';
  const epMarker = episodeMarker(item);

  // (c) external id — the strongest signal for MOVIES (entity-level ids). For
  // TV it is unreliable: providers store series-level ids on episode rows, and
  // some data even repeats one id across *different* shows. So for non-movies we
  // scope the external-id key by the show title AND the episode number, so a bad
  // shared id can never collapse distinct episodes/shows, while two files of the
  // same episode still match.
  for (const ext of item.externalIds ?? []) {
    const scope = isMovie ? '' : `:${normTitle}${epMarker}`;
    keys.push({ reason: 'external_id', key: `external_id:${ext.provider}:${ext.externalId}${scope}` });
  }

  // (b) show + season + episode.
  if (item.season != null && item.episode != null) {
    keys.push({
      reason: 'show_season_episode',
      key: `sse:${normTitle}:s${item.season}:e${item.episode}`,
    });
  }

  // (a) title + year (movies / shows without episode markers).
  if (item.season == null && item.episode == null) {
    keys.push({
      reason: 'title_year',
      key: `ty:${normTitle}:${item.year ?? 'na'}`,
    });
  }

  // (d) similar filename — a fallback signal, but it must stay as specific as the
  // primary keys: scoped to the episode for shows, and to the YEAR for movies, so
  // different episodes of a series AND different films that share a title (e.g.
  // Aladdin 1992 vs 2019) are never grouped together.
  if (normTitle) {
    const discriminator = epMarker || `:${item.year ?? 'na'}`;
    keys.push({ reason: 'similar_filename', key: `fn:${normTitle}${discriminator}` });
  }

  return keys;
}

const REASON_PRIORITY: Record<DuplicateReason, number> = {
  external_id: 0,
  show_season_episode: 1,
  title_year: 2,
  similar_filename: 3,
};

interface DetectedGroup {
  reason: DuplicateReason;
  itemIds: string[];
  /**
   * The bucket key that produced this group — a stable identity for the group across
   * scans. Detection previously deleted every group and recreated it, so ids changed
   * on every run and a human decision ("not a duplicate") had nothing durable to
   * attach to. Carrying the key out of the pure grouping step is what lets the
   * persistence layer upsert instead of delete-and-recreate.
   */
  key: string;
}

/**
 * Pure grouping: assign each item to at most one duplicate group, preferring
 * the highest-confidence reason. Exported for unit testing.
 */
export function detectDuplicateGroups(items: DuplicateItemLike[]): DetectedGroup[] {
  // Bucket items by every key they produce.
  const buckets = new Map<string, { reason: DuplicateReason; ids: string[] }>();
  for (const item of items) {
    for (const { reason, key } of duplicateKeys(item)) {
      const b = buckets.get(key) ?? { reason, ids: [] };
      b.ids.push(item.id);
      buckets.set(key, b);
    }
  }

  // Keep only buckets with >1 distinct item, ordered by reason priority. The key is
  // carried through so the group keeps one identity across scans.
  const candidates = [...buckets.entries()]
    .map(([key, b]) => ({ key, reason: b.reason, ids: [...new Set(b.ids)] }))
    .filter((b) => b.ids.length > 1)
    .sort(
      (a, b) =>
        REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason] || a.key.localeCompare(b.key),
    );

  const assigned = new Set<string>();
  const groups: DetectedGroup[] = [];
  for (const cand of candidates) {
    const fresh = cand.ids.filter((id) => !assigned.has(id));
    if (fresh.length < 2) continue;
    for (const id of fresh) assigned.add(id);
    groups.push({ reason: cand.reason, itemIds: fresh, key: cand.key });
  }
  return groups;
}

/**
 * Detects duplicate MediaItems and persists them into MediaDuplicateGroup rows,
 * exposing a quality comparison so operators can pick the copy to keep.
 */
@Injectable()
export class MediaDuplicateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Re-run duplicate detection across the whole library set. */
  async detect() {
    const items = await this.prisma.mediaItem.findMany({
      include: { externalIds: true, files: true },
    });

    const byId = items;
    const groups = detectDuplicateGroups(
      items.map((i) => ({
        id: i.id,
        mediaType: i.mediaType,
        title: i.title,
        year: i.year,
        season: i.season,
        episode: i.episode,
        externalIds: i.externalIds,
        files: i.files,
      })),
    );

    // Detach every item first so an item that is no longer duplicated is released,
    // but DO NOT delete the groups: a group carries human decisions (ignored, with a
    // reason and an author; resolved, with a timestamp) and those must outlive a
    // rescan. This used to be `deleteMany({})` followed by `create()` per group,
    // which changed every group's id on every run — so "this is not a duplicate" was
    // impossible to persist, and an interrupted run stranded member-less rows.
    await this.prisma.mediaItem.updateMany({
      where: { duplicateGroupId: { not: null } },
      data: { duplicateGroupId: null },
    });

    const seen: string[] = [];
    for (const group of groups) {
      // Keyed on the detection signal, so the same real-world group keeps one
      // identity across scans. `version` is bumped on every re-detection: a
      // resolution previewed against an older version is refused rather than applied
      // to a membership the operator never approved.
      const row = await this.prisma.mediaDuplicateGroup.upsert({
        where: { groupKey: group.key },
        create: { groupKey: group.key, reason: group.reason, groupType: 'file' },
        update: { reason: group.reason, version: { increment: 1 } },
      });
      seen.push(row.id);
      await this.prisma.mediaItem.updateMany({
        where: { id: { in: group.itemIds } },
        data: { duplicateGroupId: row.id },
      });

      // Score the group now, so the list, the filters and the review queue all read
      // the same stored judgement rather than each recomputing it per request.
      const members = byId.filter((i) => group.itemIds.includes(i.id));
      const rec = recommend(
        members.map((i) => ({
          id: i.id,
          title: i.title,
          year: i.year,
          season: i.season,
          episode: i.episode,
          path: i.path,
          modifiedAt: i.updatedAt,
          externalIds: i.externalIds?.map((e) => ({ provider: e.provider, externalId: e.externalId })) ?? [],
          file: i.files?.[0]
            ? {
                size: Number(i.files[0].size),
                height: i.files[0].height,
                width: i.files[0].width,
                bitrateKbps: i.files[0].bitrateKbps,
                durationSec: i.files[0].durationSec,
                audioChannels: i.files[0].audioChannels,
                resolution: i.files[0].resolution,
                videoCodec: i.files[0].videoCodec,
              }
            : null,
        })),
      );

      await this.prisma.mediaDuplicateGroup.update({
        where: { id: row.id },
        data: {
          confidence: rec.confidence,
          requiresReview: rec.requiresReview,
          potentialSavingsBytes: BigInt(rec.potentialSavingsBytes),
          recommendedItemId: rec.keepId,
          recommendation: { verdicts: rec.verdicts } as object,
          warnings: rec.warnings as unknown as object,
        },
      });

      // Candidate rows carry per-membership state (rank, why it lost) and snapshot
      // path/size, so a resolution stays auditable after the item row is gone.
      await this.prisma.mediaDuplicateCandidate.deleteMany({ where: { groupId: row.id } });
      await this.prisma.mediaDuplicateCandidate.createMany({
        data: rec.verdicts.map((v) => {
          const m = members.find((x) => x.id === v.id)!;
          return {
            groupId: row.id,
            itemId: v.id,
            path: m.path,
            fileSize: BigInt(m.files?.[0] ? Number(m.files[0].size) : 0),
            qualityScore: v.score,
            recommendationRank: v.rank,
            recommendationReasons: v.reasons as unknown as object,
          };
        }),
      });
    }

    // Groups detection no longer produces are dropped — UNLESS a human touched them.
    // An ignored group is retained precisely so the same false positive does not come
    // back; a resolved one is retained as history.
    await this.prisma.mediaDuplicateGroup.deleteMany({
      where: { id: { notIn: seen.length ? seen : ['\u0000'] }, status: 'open' },
    });

    return this.list();
  }

  /** List current duplicate groups (paginated) with a per-item quality comparison. */
  async list(page?: string, pageSize?: string, query: ListDuplicatesDto = {}) {
    const params = parsePage(page ?? query.page, pageSize ?? query.pageSize, 25);
    const where = this.groupWhere(query);
    const [total, groups] = await Promise.all([
      this.prisma.mediaDuplicateGroup.count({ where }),
      this.prisma.mediaDuplicateGroup.findMany({
        where,
        include: { items: { include: { files: true, externalIds: true } } },
        orderBy: this.groupOrder(query.sort),
        skip: params.skip,
        take: params.take,
      }),
    ]);

    const items = groups.map((g) => {
      const scored = g.items.map((item) => {
        const score = qualityScore({
          id: item.id,
          mediaType: item.mediaType,
          title: item.title,
          year: item.year,
          season: item.season,
          episode: item.episode,
          files: item.files,
        });
        const totalSize = item.files.reduce(
          (acc, f) => acc + Number(f.size),
          0,
        );
        return {
          id: item.id,
          title: item.title,
          year: item.year,
          season: item.season,
          episode: item.episode,
          libraryId: item.libraryId,
          path: item.path,
          qualityScore: score,
          totalSize,
          bestResolution: item.files
            .map((f) => f.resolution)
            .filter(Boolean)[0] ?? null,
          bestCodec: item.files.map((f) => f.videoCodec).filter(Boolean)[0] ?? null,
        };
      });
      // Highest quality first; the top row is the suggested "keep".
      scored.sort((a, b) => b.qualityScore - a.qualityScore || b.totalSize - a.totalSize);
      return {
        id: g.id,
        reason: g.reason,
        groupType: g.groupType,
        status: g.status,
        confidence: g.confidence,
        requiresReview: g.requiresReview,
        potentialSavingsBytes: Number(g.potentialSavingsBytes),
        version: g.version,
        ignoredReason: g.ignoredReason,
        createdAt: g.createdAt,
        suggestedKeepId: scored[0]?.id ?? null,
        items: scored,
      };
    });

    // Applied after the page is fetched because neither is a column: `files_desc`
    // counts a relation and `title` lives on the member items. Both therefore order
    // WITHIN the page, which is honest for a page-at-a-time list and keeps
    // pagination stable; the column orderings above cover the rest.
    if (query.sort === 'files_desc') items.sort((a, b) => b.items.length - a.items.length);
    if (query.sort === 'title') {
      items.sort((a, b) => (a.items[0]?.title ?? '').localeCompare(b.items[0]?.title ?? ''));
    }
    return pageOf(items, total, params);
  }

  // --- Duplicate Center -----------------------------------------------------

  /**
   * Counts for the Duplicate Center landing screen.
   *
   * Every figure is a single aggregate rather than a page of rows loaded and counted
   * in JS — the old list path pulled whole groups with their items, files and
   * external ids just to render a table, which does not survive a library of tens of
   * thousands of files.
   */
  async overview() {
    const [byStatus, byType, byReason, review, savings, lastGroup, resolutions] =
      await Promise.all([
        this.prisma.mediaDuplicateGroup.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.mediaDuplicateGroup.groupBy({ by: ['groupType'], _count: { _all: true } }),
        this.prisma.mediaDuplicateGroup.groupBy({ by: ['reason'], _count: { _all: true } }),
        this.prisma.mediaDuplicateGroup.count({ where: { status: 'open', requiresReview: true } }),
        this.prisma.mediaDuplicateGroup.aggregate({
          where: { status: 'open' },
          _sum: { potentialSavingsBytes: true },
        }),
        this.prisma.mediaDuplicateGroup.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        this.prisma.mediaDuplicateResolution.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);

    const count = (rows: Array<{ _count: { _all: number } }>, key: string, field: string) =>
      rows.find((r) => (r as unknown as Record<string, unknown>)[field] === key)?._count._all ?? 0;

    return {
      groups: {
        total: byStatus.reduce((a, r) => a + r._count._all, 0),
        open: count(byStatus, 'open', 'status'),
        ignored: count(byStatus, 'ignored', 'status'),
        resolved: count(byStatus, 'resolved', 'status'),
      },
      needsReview: review,
      byType: {
        file: count(byType, 'file', 'groupType'),
        showFolder: count(byType, 'show_folder', 'groupType'),
      },
      byReason: Object.fromEntries(byReason.map((r) => [r.reason, r._count._all])),
      // Potential reclaim is only meaningful once candidates carry sizes, which the
      // recommendation engine fills in. Reported as 0 rather than guessed.
      potentialSavingsBytes: Number(savings._sum.potentialSavingsBytes ?? 0),
      lastDetectedAt: lastGroup?.createdAt ?? null,
      resolutions: Object.fromEntries(resolutions.map((r) => [r.status, r._count._all])),
    };
  }

  /** Build the Prisma filter for a Duplicate Center query. */
  private groupWhere(query: ListDuplicatesDto): Prisma.MediaDuplicateGroupWhereInput {
    const where: Prisma.MediaDuplicateGroupWhereInput = {};
    // Default to OPEN. A landing screen that silently includes resolved and ignored
    // groups is how an operator loses faith in the counts.
    where.status = query.status ?? 'open';
    if (query.groupType) where.groupType = query.groupType;
    if (query.reason) where.reason = query.reason;
    if (query.requiresReview === 'true') where.requiresReview = true;

    // Item-level filters reach through the membership, so a library or media-type
    // filter means "this group has a member there" rather than dropping the group.
    const item: Prisma.MediaItemWhereInput = {};
    if (query.libraryId) item.libraryId = query.libraryId;
    if (query.mediaType) item.mediaType = query.mediaType;
    const q = query.q?.trim();
    if (q) {
      item.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { path: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (Object.keys(item).length) where.items = { some: item };
    return where;
  }

  /** Translate a sort token into a Prisma ordering. */
  private groupOrder(sort?: string): Prisma.MediaDuplicateGroupOrderByWithRelationInput[] {
    switch (sort) {
      case 'savings_desc':
        return [{ potentialSavingsBytes: 'desc' }, { createdAt: 'desc' }];
      case 'confidence_desc':
        return [{ confidence: 'desc' }, { createdAt: 'desc' }];
      case 'confidence_asc':
        return [{ confidence: 'asc' }, { createdAt: 'desc' }];
      case 'recent':
        return [{ createdAt: 'desc' }];
      case 'oldest':
        return [{ createdAt: 'asc' }];
      case 'files_desc':
      case 'title':
        // Neither is expressible as a column ordering (one counts a relation, the
        // other lives on the member items). Sorted in the handler; the stable
        // createdAt ordering keeps pagination deterministic underneath.
        return [{ createdAt: 'desc' }];
      case 'needs_review':
      default:
        // The default view: what needs a decision, biggest reclaim first.
        return [{ requiresReview: 'desc' }, { potentialSavingsBytes: 'desc' }, { createdAt: 'desc' }];
    }
  }

  /** One group with everything the comparison view needs. */
  async get(groupId: string) {
    const g = await this.prisma.mediaDuplicateGroup.findUnique({
      where: { id: groupId },
      include: { items: { include: { files: true, externalIds: true, library: { select: { id: true, name: true } } } } },
    });
    if (!g) throw new NotFoundException('Duplicate group not found');

    const candidates = g.items.map((item) => {
      const f = item.files[0];
      return {
        id: item.id,
        title: item.title,
        year: item.year,
        season: item.season,
        episode: item.episode,
        mediaType: item.mediaType,
        matchStatus: item.matchStatus,
        libraryId: item.libraryId,
        libraryName: item.library?.name ?? null,
        path: item.path,
        addedAt: item.createdAt,
        modifiedAt: item.updatedAt,
        externalIds: item.externalIds.map((e) => ({ provider: e.provider, externalId: e.externalId })),
        totalSize: item.files.reduce((acc, x) => acc + Number(x.size), 0),
        qualityScore: qualityScore({
          id: item.id,
          mediaType: item.mediaType,
          title: item.title,
          year: item.year,
          season: item.season,
          episode: item.episode,
          files: item.files,
        }),
        // Split deliberately. The parsed fields come from the FILENAME and are mostly
        // null on a renamed library (measured: 96% of files had no videoCodec, 100%
        // no hdr) because the renamer strips those tokens. Presenting them beside
        // measured values as if equally trustworthy is how a comparison view ends up
        // full of blanks that look like missing data rather than absent evidence.
        parsed: {
          container: f?.container ?? null,
          resolution: f?.resolution ?? null,
          videoCodec: f?.videoCodec ?? null,
          audioCodec: f?.audioCodec ?? null,
          hdr: f?.hdr ?? null,
          releaseGroup: f?.releaseGroup ?? null,
          quality: f?.quality ?? null,
          language: f?.language ?? null,
        },
        measured: {
          width: f?.width ?? null,
          height: f?.height ?? null,
          bitrateKbps: f?.bitrateKbps ?? null,
          durationSec: f?.durationSec ?? null,
          audioChannels: f?.audioChannels ?? null,
          frameRate: f?.frameRate ?? null,
        },
      };
    });
    candidates.sort((a, b) => b.qualityScore - a.qualityScore || b.totalSize - a.totalSize);

    return {
      id: g.id,
      groupKey: g.groupKey,
      groupType: g.groupType,
      reason: g.reason,
      status: g.status,
      confidence: g.confidence,
      requiresReview: g.requiresReview,
      version: g.version,
      potentialSavingsBytes: Number(g.potentialSavingsBytes),
      recommendedItemId: g.recommendedItemId,
      recommendation: g.recommendation,
      warnings: g.warnings,
      ignoredReason: g.ignoredReason,
      ignoredAt: g.ignoredAt,
      resolvedAt: g.resolvedAt,
      createdAt: g.createdAt,
      // Until the recommendation engine lands, the suggestion is the top-scored
      // candidate — the same rule the old page used, surfaced honestly as a
      // suggestion rather than dressed up as a recommendation with reasons.
      suggestedKeepId: candidates[0]?.id ?? null,
      candidates,
    };
  }

  /**
   * Mark a group "not a duplicate". Survives rescans by design: detection only
   * deletes groups whose status is still `open`.
   */
  async ignore(groupId: string, reason: string | undefined, userId?: string) {
    await this.getOrThrow(groupId);
    return this.prisma.mediaDuplicateGroup.update({
      where: { id: groupId },
      data: {
        status: 'ignored',
        ignoredReason: reason?.trim() || null,
        ignoredById: userId ?? null,
        ignoredAt: new Date(),
      },
    });
  }

  /** Put an ignored or resolved group back in front of the operator. */
  async reopen(groupId: string) {
    await this.getOrThrow(groupId);
    return this.prisma.mediaDuplicateGroup.update({
      where: { id: groupId },
      data: {
        status: 'open',
        ignoredReason: null,
        ignoredById: null,
        ignoredAt: null,
        resolvedById: null,
        resolvedAt: null,
      },
    });
  }

  private async getOrThrow(groupId: string) {
    const g = await this.prisma.mediaDuplicateGroup.findUnique({ where: { id: groupId } });
    if (!g) throw new NotFoundException('Duplicate group not found');
    return g;
  }
}
