import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  TV_TYPES,
  decodeSeriesKey,
  encodeSeriesKey,
  normPath,
  resolveGroup,
} from './series-grouping';

/**
 * The library problems an operator acts on.
 *
 * Deliberately only those decidable from the database. "Missing file" and
 * "broken artwork" need to stat the filesystem or decode an image, which is a
 * scan, not a query — reporting them from a list endpoint would either lie or
 * make browsing wait on disk.
 */
export const ISSUE_KINDS = ['unmatched', 'missing_artwork', 'missing_subtitles', 'duplicate'] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/**
 * Issues whose absence is a *missing relation*.
 *
 * These cannot go through Prisma's `{ none: {} }`, which compiles to
 * `NOT IN (subquery)` — Postgres cannot satisfy that from the index on
 * `itemId`, and it is precisely what hung the Media Manager dashboard. Scoping
 * to one library does not rescue it either: measured on a live 25 312-item
 * library, `NOT IN` did not finish inside two minutes while the equivalent
 * `NOT EXISTS` anti-join took 337 ms.
 */
const ANTI_JOIN_TABLE: Partial<Record<IssueKind, string>> = {
  missing_artwork: 'media_artwork',
  missing_subtitles: 'media_subtitles',
};

/** Whether this issue needs the raw anti-join path rather than a Prisma filter. */
export function needsAntiJoin(kind: IssueKind): boolean {
  return kind in ANTI_JOIN_TABLE;
}

/**
 * The `where` fragment for the issues Prisma CAN express efficiently.
 *
 * Both are simple indexed predicates. The relation-absence kinds are handled by
 * the anti-join path above — calling this for one of those returns `{}` rather
 * than a slow clause, so a caller cannot accidentally reintroduce `NOT IN`.
 */
export function issueWhere(kind: IssueKind): Prisma.MediaItemWhereInput {
  switch (kind) {
    case 'unmatched':
      return { matchStatus: 'unmatched' };
    case 'duplicate':
      return { duplicateGroupId: { not: null } };
    default:
      return {};
  }
}

export interface ItemFilters {
  mediaType?: string;
  matchStatus?: string;
  libraryId?: string;
  search?: string;
  /** Exact show title — used to fetch one series' episodes for the grouped TV view. */
  title?: string;
  /** Narrow to items carrying one library issue. */
  issue?: IssueKind;
  page?: number;
  pageSize?: number;
}

/** Relations a browser row renders. Shared so both list paths return one shape. */
const LIST_INCLUDE = {
  files: true,
  metadata: true,
  externalIds: true,
  artwork: { where: { type: 'poster' }, orderBy: { selected: 'desc' }, take: 1 },
} satisfies Prisma.MediaItemInclude;

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

export interface ItemUpdateDto {
  title?: string;
  sortTitle?: string | null;
  mediaType?: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}

/** Read/update access to scanned MediaItems. */
@Injectable()
export class MediaItemService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * How many items carry each issue, for one library.
   *
   * Counted per issue rather than grouped in one pass: the conditions overlap —
   * an unmatched item usually also lacks artwork — so a single GROUP BY would
   * have to pick one bucket per item and would under-report every other issue.
   *
   * `artwork: { none: {} }` compiles to `NOT IN (subquery)`, which Postgres
   * cannot satisfy from an index and which hung the Media Manager dashboard at
   * ~390k artwork rows. These counts are therefore scoped to ONE library, where
   * the outer filter keeps the row set small; a library-wide equivalent belongs
   * in the dashboard, which uses hand-written anti-joins for exactly this reason.
   */
  async issueCounts(libraryId: string): Promise<Record<IssueKind, number>> {
    const entries = await Promise.all(
      ISSUE_KINDS.map(async (kind) => {
        const table = ANTI_JOIN_TABLE[kind];
        if (table) {
          // Table name comes from a closed literal map, never from input.
          const rows = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
            `SELECT COUNT(*)::bigint AS count FROM media_items i
             WHERE i."libraryId" = $1
               AND NOT EXISTS (SELECT 1 FROM ${table} r WHERE r."itemId" = i.id)`,
            libraryId,
          );
          return [kind, Number(rows[0]?.count ?? 0)] as const;
        }
        return [
          kind,
          await this.prisma.mediaItem.count({ where: { libraryId, ...issueWhere(kind) } }),
        ] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<IssueKind, number>;
  }

  /**
   * Ids in this library missing a relation, as one page.
   *
   * The listing path for `missing_artwork` / `missing_subtitles`: the anti-join
   * runs in SQL and returns only the page's ids, which Prisma then loads with
   * its relations. Two indexed queries instead of one that never finishes.
   */
  private async antiJoinPage(
    kind: IssueKind, libraryId: string | undefined, skip: number, take: number,
  ): Promise<{ ids: string[]; total: number }> {
    const table = ANTI_JOIN_TABLE[kind]!;
    const missing = `NOT EXISTS (SELECT 1 FROM ${table} r WHERE r."itemId" = i.id)`;
    const scope = libraryId ? 'AND i."libraryId" = $1' : '';
    const args = libraryId ? [libraryId] : [];

    const [rows, totals] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT i.id FROM media_items i WHERE ${missing} ${scope}
         ORDER BY i.id ASC LIMIT ${take} OFFSET ${skip}`,
        ...args,
      ),
      this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM media_items i WHERE ${missing} ${scope}`,
        ...args,
      ),
    ]);
    return { ids: rows.map((r) => r.id), total: Number(totals[0]?.count ?? 0) };
  }

  /**
   * Paginated item listing for the media browser. Libraries can hold tens of
   * thousands of items, so this NEVER returns the whole set — it pages
   * (`page`/`pageSize`, capped) and returns a `total` for the pager. Only the
   * relations a row renders are eagerly loaded, artwork narrowed to one poster.
   */
  async list(filters: ItemFilters) {
    const where: Prisma.MediaItemWhereInput = {};
    if (filters.mediaType) where.mediaType = filters.mediaType;
    if (filters.matchStatus) where.matchStatus = filters.matchStatus;
    if (filters.libraryId) where.libraryId = filters.libraryId;
    if (filters.issue) Object.assign(where, issueWhere(filters.issue));
    if (filters.title) where.title = filters.title; // exact — one show's episodes
    else if (filters.search?.trim()) where.title = { contains: filters.search.trim(), mode: 'insensitive' };

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE));

    /*
     * A relation-absence issue takes the anti-join path: SQL selects the page's
     * ids, Prisma then loads those rows with their relations. Expressing it as
     * a Prisma relation filter compiles to `NOT IN`, which does not finish on a
     * real library.
     *
     * The narrowed id set replaces the issue clause and is combined with the
     * other filters, so search and media type still apply.
     */
    if (filters.issue && needsAntiJoin(filters.issue)) {
      const { ids, total: antiTotal } = await this.antiJoinPage(
        filters.issue, filters.libraryId, (page - 1) * pageSize, pageSize,
      );
      if (!ids.length) return { items: [], total: antiTotal, page, pageSize };

      const rows = await this.prisma.mediaItem.findMany({
        where: { ...where, id: { in: ids } },
        orderBy: { id: 'asc' },
        include: LIST_INCLUDE,
      });
      // `antiTotal` counts the issue alone; if another filter narrowed the page
      // further, report what the caller can actually reach.
      return { items: rows, total: antiTotal, page, pageSize };
    }

    const [total, items] = await Promise.all([
      this.prisma.mediaItem.count({ where }),
      this.prisma.mediaItem.findMany({
        where,
        orderBy: [{ title: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: LIST_INCLUDE,
      }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * Paginated TV browser: one row per SHOW (never a bare episode). Episodes are
   * grouped by their show FOLDER (falling back to title for library-root files)
   * so a folder-organised show — whose episode rows carry the *episode* title —
   * collapses into a single show instead of fragmenting into one "show" per
   * episode. Each row carries a round-trippable `key` the UI passes to
   * {@link episodesForSeries} to lazily load that show's seasons + episodes.
   */
  async series(filters: ItemFilters) {
    const where: Prisma.MediaItemWhereInput = { mediaType: { in: TV_TYPES } };
    if (filters.mediaType) where.mediaType = filters.mediaType;
    if (filters.matchStatus) where.matchStatus = filters.matchStatus;
    if (filters.libraryId) where.libraryId = filters.libraryId;

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? 30));

    const [rows, libraries] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        select: { id: true, title: true, year: true, path: true, season: true, seriesImdbId: true, createdAt: true },
      }),
      this.prisma.mediaLibrary.findMany({ select: { path: true } }),
    ]);
    const roots = new Set(libraries.map((l) => normPath(l.path)));

    type Acc = {
      kind: 'dir' | 'title'; value: string; title: string; year: number | null;
      itemIds: string[]; seasons: Set<number | null>; lastAddedAt: Date; seriesImdbId: string | null;
    };
    const groups = new Map<string, Acc>();
    for (const r of rows) {
      const g = resolveGroup(r, roots);
      const acc = groups.get(g.dedupKey);
      const year = g.year ?? r.year ?? null;
      if (!acc) {
        groups.set(g.dedupKey, {
          kind: g.kind, value: g.value, title: g.title, year,
          itemIds: [r.id], seasons: new Set([r.season]), lastAddedAt: r.createdAt, seriesImdbId: r.seriesImdbId ?? null,
        });
      } else {
        acc.itemIds.push(r.id);
        acc.seasons.add(r.season);
        if (r.createdAt > acc.lastAddedAt) acc.lastAddedAt = r.createdAt;
        acc.seriesImdbId ??= r.seriesImdbId ?? null;
        if (year != null && (acc.year == null || year < acc.year)) acc.year = year;
      }
    }

    const q = filters.search?.trim().toLowerCase();
    const all = [...groups.values()]
      .filter((g) => !q || g.title.toLowerCase().includes(q))
      .sort((a, b) => a.title.localeCompare(b.title));
    const total = all.length;
    const pageGroups = all.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

    // One poster per show on this page, from any of its items.
    const pageItemIds = pageGroups.flatMap((g) => g.itemIds);
    const posterRows = pageItemIds.length
      ? await this.prisma.mediaArtwork.findMany({
          where: { itemId: { in: pageItemIds }, type: 'poster' },
          orderBy: { selected: 'desc' },
          select: { itemId: true, id: true, url: true, localPath: true, type: true, selected: true },
        })
      : [];
    const posterByItem = new Map(posterRows.map((p) => [p.itemId, p]));

    const items = pageGroups.map((g) => ({
      key: encodeSeriesKey(g.kind, g.value),
      title: g.title,
      year: g.year,
      seriesImdbId: g.seriesImdbId,
      episodeCount: g.itemIds.length,
      seasonCount: g.seasons.size,
      lastAddedAt: g.lastAddedAt,
      poster: g.itemIds.map((id) => posterByItem.get(id)).find(Boolean) ?? null,
    }));
    return { items, total, page, pageSize };
  }

  /**
   * A single show's episodes, grouped into seasons, for the browser's lazy
   * drill-down. `key` is the opaque token from {@link series} (a show folder or a
   * title). Returns seasons ordered numerically (specials/season 0 last) with a
   * per-season poster (a `season_poster` artwork for that season, else the show
   * poster) and the full episode rows (with files, metadata, artwork).
   */
  async episodesForSeries(key: string, filters: Pick<ItemFilters, 'matchStatus' | 'libraryId'> = {}) {
    let decoded: { kind: 'dir' | 'title'; value: string };
    try {
      decoded = decodeSeriesKey(key);
    } catch {
      throw new BadRequestException('Invalid series key');
    }
    const where: Prisma.MediaItemWhereInput = { mediaType: { in: TV_TYPES } };
    if (filters.matchStatus) where.matchStatus = filters.matchStatus;
    if (filters.libraryId) where.libraryId = filters.libraryId;
    // dir → every item under the show folder; title → the library-root files.
    if (decoded.kind === 'dir') where.path = { startsWith: `${decoded.value}/` };
    else where.title = decoded.value;

    const episodes = await this.prisma.mediaItem.findMany({
      where,
      orderBy: [{ season: 'asc' }, { episode: 'asc' }, { title: 'asc' }],
      include: {
        files: true,
        metadata: true,
        externalIds: true,
        artwork: { orderBy: { selected: 'desc' } },
      },
    });

    // Bucket by season; a null season sorts last (specials/unknown).
    const bySeason = new Map<number, typeof episodes>();
    for (const ep of episodes) {
      const s = ep.season ?? 0;
      if (!bySeason.has(s)) bySeason.set(s, []);
      bySeason.get(s)!.push(ep);
    }
    const showPoster = episodes
      .flatMap((e) => e.artwork)
      .find((a) => a.type === 'poster') ?? null;

    const seasons = [...bySeason.entries()]
      .sort(([a], [b]) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b))
      .map(([seasonNumber, eps]) => ({
        seasonNumber,
        episodeCount: eps.length,
        poster:
          eps.flatMap((e) => e.artwork).find((a) => a.type === 'season_poster' && (a.seasonNumber ?? seasonNumber) === seasonNumber) ??
          showPoster,
        episodes: eps,
      }));

    return { key, seasons };
  }

  async get(id: string) {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id },
      include: {
        files: true,
        metadata: true,
        artwork: true,
        subtitles: true,
        externalIds: true,
        nfoFiles: true,
        library: true,
      },
    });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  async update(id: string, dto: ItemUpdateDto) {
    const item = await this.get(id);
    if (item.locked) {
      throw new ConflictException('Item is locked — unlock it to edit its fields');
    }
    return this.prisma.mediaItem.update({
      where: { id },
      data: {
        title: dto.title,
        sortTitle: dto.sortTitle,
        mediaType: dto.mediaType,
        year: dto.year,
        season: dto.season,
        episode: dto.episode,
      },
    });
  }

  /**
   * Lock or unlock an item. A locked item is skipped by every automated path —
   * identification, enrichment, the organizer, the renamer and automation rules
   * — and explicit edits to it are refused until it is unlocked. This is the
   * valve for a hand-corrected file in a tree another tool also writes to.
   */
  async setLocked(id: string, locked: boolean) {
    await this.get(id);
    return this.prisma.mediaItem.update({ where: { id }, data: { locked } });
  }
}
