import { Injectable, NotFoundException } from '@nestjs/common';
import * as path from 'node:path';
import type { MediaItem } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  parseTorrentName,
  ParsedTorrentMeta,
} from '../rss/torrent-name-parser';

export interface ManualMatchDto {
  mediaType?: string;
  title?: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
}

/** Threshold above which a parsed filename is considered a confident match. */
const MATCH_THRESHOLD = 0.5;

/**
 * Identifies scanned MediaItems by parsing their filename with the shared
 * torrent-name parser and mapping the result onto the item's fields.
 */
@Injectable()
export class MediaIdentificationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Parse the item's filename and persist the derived identity. */
  async identify(item: MediaItem | string) {
    const record =
      typeof item === 'string'
        ? await this.prisma.mediaItem.findUnique({ where: { id: item } })
        : item;
    if (!record) throw new NotFoundException('Item not found');

    const parsed = parseTorrentName(path.basename(record.path));
    const confidence = this.scoreConfidence(parsed);
    const mediaType = this.mediaTypeFromParsed(parsed, record.mediaType);
    const isEpisodic = mediaType === 'tv' || mediaType === 'anime';

    return this.prisma.mediaItem.update({
      where: { id: record.id },
      data: {
        mediaType,
        title: parsed.title ?? record.title,
        year: parsed.year ?? null,
        season: parsed.season ?? null,
        episode: parsed.episode ?? parsed.absoluteEpisode ?? null,
        confidence,
        matchStatus: confidence >= MATCH_THRESHOLD ? 'matched' : 'unmatched',
        seriesImdbId: isEpisodic ? await this.resolveSeriesImdbId(record.id) : null,
      },
    });
  }

  /**
   * Best-effort parent-series tconst for a TV/anime episode item, used by the
   * missing-episodes diff. Resolves the item's own IMDb external id: an episode
   * tconst maps to its series via `IMDbEpisode.parentTitleId`; a series tconst is
   * kept as-is. Returns null (never throws) when nothing is resolvable — the scan
   * falls back to title matching.
   */
  private async resolveSeriesImdbId(itemId: string): Promise<string | null> {
    try {
      const ext = await this.prisma.mediaExternalId.findUnique({
        where: { itemId_provider: { itemId, provider: 'imdb' } },
      });
      const tconst = ext?.externalId;
      if (!tconst) return null;
      const ep = await this.prisma.iMDbEpisode.findUnique({
        where: { episodeTitleId: tconst },
      });
      if (ep) return ep.parentTitleId;
      const title = await this.prisma.iMDbTitle.findUnique({ where: { tconst } });
      if (title && (title.titleType === 'tvSeries' || title.titleType === 'tvMiniSeries')) {
        return tconst;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Operator override — authoritative identity, always full confidence. */
  async matchManually(itemId: string, dto: ManualMatchDto) {
    const record = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!record) throw new NotFoundException('Item not found');

    const mediaType = dto.mediaType ?? record.mediaType;
    const isEpisodic = mediaType === 'tv' || mediaType === 'anime';

    return this.prisma.mediaItem.update({
      where: { id: itemId },
      data: {
        mediaType,
        title: dto.title ?? record.title,
        year: dto.year ?? record.year,
        season: dto.season ?? record.season,
        episode: dto.episode ?? record.episode,
        matchStatus: 'manual',
        confidence: 1,
        seriesImdbId: isEpisodic ? await this.resolveSeriesImdbId(itemId) : null,
      },
    });
  }

  /** Clear identification back to an unmatched state. */
  async unmatch(itemId: string) {
    const record = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!record) throw new NotFoundException('Item not found');

    return this.prisma.mediaItem.update({
      where: { id: itemId },
      data: { matchStatus: 'unmatched', confidence: 0 },
    });
  }

  private mediaTypeFromParsed(parsed: ParsedTorrentMeta, fallback: string): string {
    switch (parsed.contentType) {
      case 'tv_episode':
      case 'daily':
        return 'tv';
      case 'anime_episode':
        return 'anime';
      case 'movie':
        return 'movie';
      default:
        return fallback;
    }
  }

  /** Confidence 0..1 from the share of key fields the parser resolved. */
  private scoreConfidence(parsed: ParsedTorrentMeta): number {
    const fields = [
      parsed.title,
      parsed.year,
      parsed.season,
      parsed.episode ?? parsed.absoluteEpisode,
      parsed.resolution,
      parsed.source,
      parsed.codec,
      parsed.releaseGroup,
    ];
    const present = fields.filter((f) => f !== null && f !== undefined).length;
    return Math.round((present / fields.length) * 100) / 100;
  }
}
