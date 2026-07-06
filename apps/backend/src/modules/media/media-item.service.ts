import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ItemFilters {
  mediaType?: string;
  matchStatus?: string;
  libraryId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

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
    if (filters.search?.trim()) where.title = { contains: filters.search.trim(), mode: 'insensitive' };

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
