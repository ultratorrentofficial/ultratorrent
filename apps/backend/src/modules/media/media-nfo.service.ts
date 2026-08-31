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
  /** The series an episode belongs to - written as <showtitle>. */
  showTitle?: string | null;
  genres?: string[];
  studios?: string[];
  directors?: string[];
  writers?: string[];
  cast?: Array<{ name: string; role?: string }>;
  externalIds?: Record<string, string>;
  /** ISO date. Written as <premiered>, which is what Kodi and TMM read. */
  releaseDate?: string | null;
  tags?: string[];
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
  // <premiered> rather than <releasedate>: it is the element Kodi and
  // tinyMediaManager both read, and writing the one nobody reads is the same as
  // writing nothing.
  if (data.releaseDate) body += tag('premiered', data.releaseDate);
  for (const t of data.tags ?? []) body += tag('tag', t);
  if (type === 'season' && data.season != null) {
    body += tag('seasonnumber', data.season);
  }
  if (type === 'episode') {
    // <showtitle> is how Kodi and Plex anchor a loose episode file to its
    // series when the episode carries no id of its own.
    if (data.showTitle) body += tag('showtitle', data.showTitle);
    if (data.season != null) body += tag('season', data.season);
    if (data.episode != null) body += tag('episode', data.episode);
  }
  for (const g of data.genres ?? []) body += tag('genre', g);
  for (const s of data.studios ?? []) body += tag('studio', s);
  for (const d of data.directors ?? []) body += tag('director', d);
  for (const w of data.writers ?? []) body += tag('credits', w);
  /*
   * Episodes get NO <uniqueid>, and that is the fix for a real corruption.
   *
   * The ids held here are resolved for the SERIES, not the episode - there is
   * no episode-level id anywhere in the model. Writing them into an episode
   * NFO stamps the identical tmdb/imdb/tvdb id onto every episode of a show;
   * a scraper that keys episodes by uniqueid then collapses them all onto one
   * identity and discards the per-episode metadata. Observed in Plex: 166
   * episodes across two shows displayed as "Episode 12" despite every NFO
   * carrying the correct <title>.
   *
   * With no id the scraper falls back to <showtitle> + season/episode, which
   * is correct. A series id on an episode is worse than no id at all.
   */
  const idsFor = type === 'episode' ? {} : (data.externalIds ?? {});
  for (const [provider, id] of Object.entries(idsFor)) {
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

  /**
   * A show's own NFO, built from MediaShow rather than a MediaItem.
   *
   * A series has no file of its own, so it has no media item either — every row
   * is an episode. Generation used to run only over items, which meant a show
   * folder never received a `tvshow.nfo` unless some other tool had written one.
   * A scraper reading local data then has nothing to identify the SERIES by, and
   * falls back to the folder name: the year is lost and the match is a guess.
   *
   * This is also the one place a series id belongs. Episodes deliberately carry
   * no `uniqueid` (see buildNfoXml) precisely so that the id lives here, once,
   * on the thing it actually identifies.
   */
  private async generateForShow(showId: string, ctx: AuditContext) {
    const show = await this.prisma.mediaShow.findUnique({
      where: { id: showId },
      include: { metadata: true },
    });
    if (!show) throw new NotFoundException('Show not found');

    const md = show.metadata;
    const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
    const castArr = (v: unknown): Array<{ name: string; role?: string }> =>
      Array.isArray(v) ? (v as Array<{ name: string; role?: string }>) : [];

    const externalIds: Record<string, string> = {};
    if (show.imdbId) externalIds.imdb = show.imdbId;
    if (show.tmdbId) externalIds.tmdb = show.tmdbId;

    const data: NfoData = {
      title: md?.title ?? show.title,
      originalTitle: md?.originalTitle ?? null,
      sortTitle: md?.sortTitle ?? null,
      overview: md?.overview ?? null,
      year: md?.year ?? show.year ?? null,
      rating: md?.rating ?? null,
      certification: md?.certification ?? null,
      genres: arr(md?.genres),
      studios: arr(md?.studios),
      cast: castArr(md?.cast),
      // <premiered> on a series is the date it first aired.
      releaseDate: md?.firstAiredAt ? md.firstAiredAt.toISOString().slice(0, 10) : null,
      externalIds,
    };

    const xml = buildNfoXml('tvshow', data);
    // The stored path IS the show directory, so join rather than going through
    // nfoFilenameFor(), which expects a file and would take its parent.
    const safePath = this.filePath.assertWithinHardRoots(path.join(show.path, 'tvshow.nfo'));
    await writeFile(safePath, xml, 'utf8');

    // No MediaNfoFile row: that table's itemId is a required FK to MediaItem and
    // a show has no item. The audit entry below is the durable record.
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.nfo.generate',
      objectType: 'media_show',
      objectId: showId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { type: 'tvshow', path: safePath },
    });

    return { type: 'tvshow' as const, path: safePath, showId };
  }

  /** Generate NFO for a single item or every item in a library. */
  async generate(
    args: { itemId?: string; libraryId?: string; showId?: string },
    ctx: AuditContext = {},
  ) {
    if (args.showId) {
      const record = await this.generateForShow(args.showId, ctx);
      return { generated: 1, files: [record] };
    }

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

      /*
       * Shows as well as items. A library sweep that wrote only episode sidecars
       * left every series without a `tvshow.nfo`, which is the file a scraper
       * needs to identify the SERIES — without it the year is lost and the match
       * is made on the folder name.
       */
      const shows = await this.prisma.mediaShow.findMany({
        where: { libraryId: args.libraryId },
        select: { id: true },
      });
      for (const sh of shows) {
        try {
          files.push(await this.generateForShow(sh.id, ctx));
        } catch {
          // Same tolerance as items: one unwritable show must not stop the sweep.
        }
      }

      return { generated: files.length, files };
    }

    throw new BadRequestException('Provide itemId, showId or libraryId.');
  }
}
