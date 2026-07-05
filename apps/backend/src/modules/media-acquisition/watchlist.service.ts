import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface WatchlistInput {
  type: string;
  title: string;
  year?: number;
  externalIds?: Record<string, unknown>;
  seasonNumber?: number;
  episodeNumber?: number;
  collectionName?: string;
  status?: string;
  priority?: number;
  profileId?: string;
  targetLibraryId?: string;
  settings?: Record<string, unknown>;
}

/** Watchlist CRUD: what the user wants UltraTorrent to acquire. Audited. */
@Injectable()
export class AcquisitionWatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  list(status?: string) {
    return this.prisma.mediaAcquisitionWatchlistItem.findMany({ where: { status }, orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }] });
  }

  async get(id: string) {
    const item = await this.prisma.mediaAcquisitionWatchlistItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException(`Unknown watchlist item: ${id}`);
    return item;
  }

  async create(input: WatchlistInput, userId?: string) {
    const item = await this.prisma.mediaAcquisitionWatchlistItem.create({
      data: {
        type: input.type,
        title: input.title,
        normalizedTitle: input.title.toLowerCase().trim(),
        year: input.year,
        externalIds: (input.externalIds ?? undefined) as object | undefined,
        seasonNumber: input.seasonNumber,
        episodeNumber: input.episodeNumber,
        collectionName: input.collectionName,
        status: input.status ?? 'active',
        priority: input.priority ?? 100,
        profileId: input.profileId,
        targetLibraryId: input.targetLibraryId,
        settings: (input.settings ?? undefined) as object | undefined,
        createdBy: userId,
      },
    });
    await this.audit.record({ userId, action: 'media_acquisition.watchlist.created', objectType: 'media_acquisition_watchlist', objectId: item.id });
    this.realtime.broadcast('media_acquisition.watchlist.updated', { id: item.id, action: 'created' });
    return item;
  }

  async update(id: string, input: Partial<WatchlistInput>, userId?: string) {
    await this.get(id);
    const item = await this.prisma.mediaAcquisitionWatchlistItem.update({
      where: { id },
      data: {
        type: input.type ?? undefined,
        title: input.title ?? undefined,
        normalizedTitle: input.title ? input.title.toLowerCase().trim() : undefined,
        year: input.year === undefined ? undefined : input.year,
        seasonNumber: input.seasonNumber === undefined ? undefined : input.seasonNumber,
        episodeNumber: input.episodeNumber === undefined ? undefined : input.episodeNumber,
        collectionName: input.collectionName === undefined ? undefined : input.collectionName,
        status: input.status ?? undefined,
        priority: input.priority === undefined ? undefined : input.priority,
        profileId: input.profileId === undefined ? undefined : input.profileId,
        targetLibraryId: input.targetLibraryId === undefined ? undefined : input.targetLibraryId,
        settings: input.settings === undefined ? undefined : (input.settings as object),
      },
    });
    await this.audit.record({ userId, action: 'media_acquisition.watchlist.updated', objectType: 'media_acquisition_watchlist', objectId: id });
    this.realtime.broadcast('media_acquisition.watchlist.updated', { id, action: 'updated' });
    return item;
  }

  async remove(id: string, userId?: string) {
    await this.get(id);
    await this.prisma.mediaAcquisitionWatchlistItem.delete({ where: { id } });
    // Wanted rows are loosely coupled by id (no FK), so clean them up here.
    await this.prisma.wantedEpisode.deleteMany({ where: { watchlistItemId: id } });
    await this.prisma.wantedMovie.deleteMany({ where: { watchlistItemId: id } });
    await this.audit.record({ userId, action: 'media_acquisition.watchlist.deleted', objectType: 'media_acquisition_watchlist', objectId: id });
    this.realtime.broadcast('media_acquisition.watchlist.updated', { id, action: 'deleted' });
    return { ok: true as const };
  }
}
