import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ItemFilters {
  mediaType?: string;
  matchStatus?: string;
  libraryId?: string;
}

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

  list(filters: ItemFilters) {
    const where: Prisma.MediaItemWhereInput = {};
    if (filters.mediaType) where.mediaType = filters.mediaType;
    if (filters.matchStatus) where.matchStatus = filters.matchStatus;
    if (filters.libraryId) where.libraryId = filters.libraryId;
    return this.prisma.mediaItem.findMany({
      where,
      orderBy: [{ title: 'asc' }, { createdAt: 'asc' }],
      include: { files: true },
    });
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
