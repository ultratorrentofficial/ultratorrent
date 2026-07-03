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
      },
    });
  }

  /** Operator override — authoritative identity, always full confidence. */
  async matchManually(itemId: string, dto: ManualMatchDto) {
    const record = await this.prisma.mediaItem.findUnique({ where: { id: itemId } });
    if (!record) throw new NotFoundException('Item not found');

    return this.prisma.mediaItem.update({
      where: { id: itemId },
      data: {
        mediaType: dto.mediaType ?? record.mediaType,
        title: dto.title ?? record.title,
        year: dto.year ?? record.year,
        season: dto.season ?? record.season,
        episode: dto.episode ?? record.episode,
        matchStatus: 'manual',
        confidence: 1,
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
