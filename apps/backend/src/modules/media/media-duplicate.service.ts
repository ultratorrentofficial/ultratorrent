import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { pageOf, parsePage } from '../../common/pagination';

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

  // Episode discriminator: distinct episodes of a show must NEVER share a key,
  // even when they carry a series-level external id (e.g. the same TVDB series
  // number on every episode) or an identical show title. Applied to every
  // strategy so an episodic item's keys always include its season/episode.
  const epSuffix =
    item.season != null || item.episode != null
      ? `:s${item.season ?? 'x'}:e${item.episode ?? 'x'}`
      : '';

  // (c) external id — strongest signal (but still episode-scoped for episodes,
  // because providers store series-level ids on episode rows).
  for (const ext of item.externalIds ?? []) {
    keys.push({ reason: 'external_id', key: `external_id:${ext.provider}:${ext.externalId}${epSuffix}` });
  }

  const normTitle = normalizeTitle(item.title);

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
    const discriminator = epSuffix || `:${item.year ?? 'na'}`;
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

  // Keep only buckets with >1 distinct item, ordered by reason priority.
  const candidates = [...buckets.values()]
    .map((b) => ({ reason: b.reason, ids: [...new Set(b.ids)] }))
    .filter((b) => b.ids.length > 1)
    .sort((a, b) => REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason]);

  const assigned = new Set<string>();
  const groups: DetectedGroup[] = [];
  for (const cand of candidates) {
    const fresh = cand.ids.filter((id) => !assigned.has(id));
    if (fresh.length < 2) continue;
    for (const id of fresh) assigned.add(id);
    groups.push({ reason: cand.reason, itemIds: fresh });
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

    // Reset prior grouping.
    await this.prisma.mediaItem.updateMany({
      where: { duplicateGroupId: { not: null } },
      data: { duplicateGroupId: null },
    });
    await this.prisma.mediaDuplicateGroup.deleteMany({});

    for (const group of groups) {
      const created = await this.prisma.mediaDuplicateGroup.create({
        data: { reason: group.reason },
      });
      await this.prisma.mediaItem.updateMany({
        where: { id: { in: group.itemIds } },
        data: { duplicateGroupId: created.id },
      });
    }

    return this.list();
  }

  /** List current duplicate groups (paginated) with a per-item quality comparison. */
  async list(page?: string, pageSize?: string) {
    const params = parsePage(page, pageSize, 25);
    const [total, groups] = await Promise.all([
      this.prisma.mediaDuplicateGroup.count(),
      this.prisma.mediaDuplicateGroup.findMany({
        include: { items: { include: { files: true, externalIds: true } } },
        orderBy: { createdAt: 'desc' },
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
        createdAt: g.createdAt,
        suggestedKeepId: scored[0]?.id ?? null,
        items: scored,
      };
    });
    return pageOf(items, total, params);
  }
}
