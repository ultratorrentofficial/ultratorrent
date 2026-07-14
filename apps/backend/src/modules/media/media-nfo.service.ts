import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from './media-metadata.service';

export type NfoType = 'movie' | 'tvshow' | 'season' | 'episode';

export interface NfoData {
  title?: string | null;
  originalTitle?: string | null;
  sortTitle?: string | null;
  overview?: string | null;
  year?: number | null;
  runtime?: number | null;
  rating?: number | null;
  certification?: string | null;
  season?: number | null;
  episode?: number | null;
  genres?: string[];
  studios?: string[];
  directors?: string[];
  writers?: string[];
  cast?: Array<{ name: string; role?: string }>;
  externalIds?: Record<string, string>;
}

/** Escape a value for inclusion in XML text/attribute content. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tag(name: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  return `  <${name}>${esc(value)}</${name}>\n`;
}

/**
 * Build a Kodi-style NFO XML document for a media item. Pure — exported for
 * unit testing. The root element matches the NFO type Kodi expects.
 */
export function buildNfoXml(type: NfoType, data: NfoData): string {
  const root =
    type === 'movie'
      ? 'movie'
      : type === 'tvshow'
        ? 'tvshow'
        : type === 'season'
          ? 'season'
          : 'episodedetails';

  let body = '';
  body += tag('title', data.title);
  if (data.originalTitle) body += tag('originaltitle', data.originalTitle);
  if (data.sortTitle) body += tag('sorttitle', data.sortTitle);
  if (data.rating != null) body += tag('rating', data.rating);
  if (data.year != null) body += tag('year', data.year);
  body += tag('plot', data.overview);
  if (data.runtime != null) body += tag('runtime', data.runtime);
  if (data.certification) body += tag('mpaa', data.certification);
  if (type === 'season' && data.season != null) {
    body += tag('seasonnumber', data.season);
  }
  if (type === 'episode') {
    if (data.season != null) body += tag('season', data.season);
    if (data.episode != null) body += tag('episode', data.episode);
  }
  for (const g of data.genres ?? []) body += tag('genre', g);
  for (const s of data.studios ?? []) body += tag('studio', s);
  for (const d of data.directors ?? []) body += tag('director', d);
  for (const w of data.writers ?? []) body += tag('credits', w);
  for (const [provider, id] of Object.entries(data.externalIds ?? {})) {
    if (!id) continue;
    const isDefault = provider === 'tmdb' || provider === 'imdb';
    body += `  <uniqueid type="${esc(provider)}"${isDefault ? ' default="true"' : ''}>${esc(id)}</uniqueid>\n`;
  }
  for (const actor of data.cast ?? []) {
    body += '  <actor>\n';
    body += `    <name>${esc(actor.name)}</name>\n`;
    if (actor.role) body += `    <role>${esc(actor.role)}</role>\n`;
    body += '  </actor>\n';
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${root}>\n${body}</${root}>\n`;
}

/** The NFO filename Kodi expects next to a video file. */
export function nfoFilenameFor(type: NfoType, videoPath: string): string {
  if (type === 'movie' || type === 'episode') {
    return videoPath.replace(/\.[^.]+$/, '') + '.nfo';
  }
  // tvshow / season NFOs live in the item's directory.
  const dir = path.dirname(videoPath);
  return path.join(dir, type === 'tvshow' ? 'tvshow.nfo' : 'season.nfo');
}

/**
 * Generates Kodi-style NFO sidecars from stored MediaMetadata and records each
 * as a MediaNfoFile. Honours the per-library `nfoEnabled` flag and writes only
 * inside the ops hard roots.
 */
@Injectable()
export class MediaNfoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
    private readonly audit: AuditService,
  ) {}

  private nfoTypeForItem(mediaType: string, hasEpisode: boolean): NfoType {
    if (mediaType === 'movie') return 'movie';
    if (hasEpisode) return 'episode';
    return 'tvshow';
  }

  private buildDataFromItem(item: {
    title: string;
    sortTitle: string | null;
    year: number | null;
    season: number | null;
    episode: number | null;
    metadata: {
      title: string | null;
      originalTitle: string | null;
      sortTitle: string | null;
      overview: string | null;
      year: number | null;
      runtime: number | null;
      rating: number | null;
      certification: string | null;
      genres: unknown;
      studios: unknown;
      directors: unknown;
      writers: unknown;
      cast: unknown;
    } | null;
    externalIds: Array<{ provider: string; externalId: string }>;
  }): NfoData {
    const md = item.metadata;
    const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
    const castArr = (v: unknown): Array<{ name: string; role?: string }> =>
      Array.isArray(v) ? (v as Array<{ name: string; role?: string }>) : [];
    return {
      title: md?.title ?? item.title,
      originalTitle: md?.originalTitle ?? null,
      sortTitle: md?.sortTitle ?? item.sortTitle ?? null,
      overview: md?.overview ?? null,
      year: md?.year ?? item.year ?? null,
      runtime: md?.runtime ?? null,
      rating: md?.rating ?? null,
      certification: md?.certification ?? null,
      season: item.season,
      episode: item.episode,
      genres: arr(md?.genres),
      studios: arr(md?.studios),
      directors: arr(md?.directors),
      writers: arr(md?.writers),
      cast: castArr(md?.cast),
      externalIds: Object.fromEntries(
        item.externalIds.map((e) => [e.provider, e.externalId]),
      ),
    };
  }

  private async generateForItem(itemId: string, ctx: AuditContext) {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: { metadata: true, externalIds: true, library: true, files: true },
    });
    if (!item) throw new NotFoundException('Item not found');

    const type = this.nfoTypeForItem(item.mediaType, item.episode != null);
    const data = this.buildDataFromItem(item);
    const xml = buildNfoXml(type, data);

    const videoPath = item.files[0]?.path ?? item.path;
    const nfoPath = nfoFilenameFor(type, videoPath);
    const safePath = this.filePath.assertWithinHardRoots(nfoPath);

    await writeFile(safePath, xml, 'utf8');

    const record = await this.prisma.mediaNfoFile.create({
      data: { itemId, type, path: safePath },
    });

    await this.audit.record({
      userId: ctx.userId,
      action: 'media.nfo.generate',
      objectType: 'media_item',
      objectId: itemId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { type, path: safePath },
    });

    return record;
  }

  /** Generate NFO for a single item or every item in a library. */
  async generate(
    args: { itemId?: string; libraryId?: string },
    ctx: AuditContext = {},
  ) {
    if (args.itemId) {
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: args.itemId },
        include: { library: true },
      });
      if (!item) throw new NotFoundException('Item not found');
      if (item.library && item.library.nfoEnabled === false) {
        throw new BadRequestException('NFO generation is disabled for this library.');
      }
      // Writing an NFO overwrites whatever is on disk — including one another
      // tool authored. A locked item's sidecars are exactly what the operator
      // asked us not to touch.
      if (item.locked) {
        throw new ConflictException('Item is locked — unlock it to overwrite its NFO');
      }
      const record = await this.generateForItem(args.itemId, ctx);
      return { generated: 1, files: [record] };
    }

    if (args.libraryId) {
      const library = await this.prisma.mediaLibrary.findUnique({
        where: { id: args.libraryId },
      });
      if (!library) throw new NotFoundException('Library not found');
      if (!library.nfoEnabled) {
        throw new BadRequestException('NFO generation is disabled for this library.');
      }
      const items = await this.prisma.mediaItem.findMany({
        where: { libraryId: args.libraryId, locked: false },
        select: { id: true },
      });
      const files = [];
      for (const it of items) {
        try {
          files.push(await this.generateForItem(it.id, ctx));
        } catch {
          // Skip items that cannot be written (e.g. path outside roots).
        }
      }
      return { generated: files.length, files };
    }

    throw new BadRequestException('Provide either itemId or libraryId.');
  }
}
