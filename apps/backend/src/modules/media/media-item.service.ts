import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ItemFilters {
  mediaType?: string;
  matchStatus?: string;
  libraryId?: string;
  search?: string;
  /** Exact show title — used to fetch one series' episodes for the grouped TV view. */
  title?: string;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;
/** Media types presented as collapsible Show → Season → Episode groups. */
const TV_TYPES = ['tv', 'anime', 'episode'];

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
    if (filters.title) where.title = filters.title; // exact — one show's episodes
    else if (filters.search?.trim()) where.title = { contains: filters.search.trim(), mode: 'insensitive' };

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE));

    const [total, items] = await Promise.all([
      this.prisma.mediaItem.count({ where }),
      this.prisma.mediaItem.findMany({
        where,
        orderBy: [{ title: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          files: true,
          metadata: true,
          externalIds: true,
          artwork: { where: { type: 'poster' }, orderBy: { selected: 'desc' }, take: 1 },
        },
      }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * Paginated TV browser: episodes grouped by show. Returns one row per distinct
   * show title (with season/episode counts, year, last-added and a poster) so the
   * UI can render a collapsed Show → Season → Episode tree, expanding each show
   * on demand via `list({ title })`. Movies keep the flat `list()`.
   */
  async series(filters: ItemFilters) {
    const where: Prisma.MediaItemWhereInput = { mediaType: { in: TV_TYPES } };
    if (filters.mediaType) where.mediaType = filters.mediaType;
    if (filters.matchStatus) where.matchStatus = filters.matchStatus;
    if (filters.libraryId) where.libraryId = filters.libraryId;
    if (filters.search?.trim()) where.title = { contains: filters.search.trim(), mode: 'insensitive' };

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.pageSize ?? 30));

    // All distinct shows (title + episode count + year + last-added). At library
    // scale this is ~hundreds–low-thousands of groups, so paginate in memory.
    const groups = await this.prisma.mediaItem.groupBy({
      by: ['title'],
      where,
      _count: { _all: true },
      _max: { createdAt: true },
      _min: { year: true },
      orderBy: { title: 'asc' },
    });
    const total = groups.length;
    const pageGroups = groups.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    const titles = pageGroups.map((g) => g.title);

    // Season counts + a poster, only for the shows on this page.
    const [seasonGroups, posterRows] = await Promise.all([
      titles.length
        ? this.prisma.mediaItem.groupBy({ by: ['title', 'season'], where: { ...where, title: { in: titles } }, _count: { _all: true } })
        : Promise.resolve([]),
      titles.length
        ? this.prisma.mediaItem.findMany({
            where: { ...where, title: { in: titles }, artwork: { some: { type: 'poster' } } },
            select: { title: true, artwork: { where: { type: 'poster' }, orderBy: { selected: 'desc' }, take: 1, select: { id: true, url: true, localPath: true, type: true, selected: true } } },
          })
        : Promise.resolve([]),
    ]);

    const seasonsByTitle = new Map<string, Set<number | null>>();
    for (const sg of seasonGroups) {
      if (!seasonsByTitle.has(sg.title)) seasonsByTitle.set(sg.title, new Set());
      seasonsByTitle.get(sg.title)!.add(sg.season);
    }
    const posterByTitle = new Map<string, unknown>();
    for (const r of posterRows) if (!posterByTitle.has(r.title) && r.artwork[0]) posterByTitle.set(r.title, r.artwork[0]);

    const items = pageGroups.map((g) => ({
      title: g.title,
      year: g._min.year,
      episodeCount: g._count._all,
      seasonCount: seasonsByTitle.get(g.title)?.size ?? 0,
      lastAddedAt: g._max.createdAt,
      poster: posterByTitle.get(g.title) ?? null,
    }));
    return { items, total, page, pageSize };
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
    await this.get(id);
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
}
