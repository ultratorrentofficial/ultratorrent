import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from './media-metadata.service';

/** Rows fetched per round trip. Large enough to be cheap, small enough to stream. */
const CHUNK = 1000;

export interface ExportFilters {
  libraryId?: string;
  mediaType?: string;
  matchStatus?: string;
  search?: string;
}

/** Exactly the projection below — named so the generator is not inferred recursively. */
interface ExportRow {
  id: string; title: string; year: number | null; mediaType: string;
  season: number | null; episode: number | null; matchStatus: string;
  confidence: number; locked: boolean; createdAt: Date;
  files: Array<{
    resolution: string | null; videoCodec: string | null; hdr: string | null;
    container: string | null; size: bigint;
  }>;
  _count: { artwork: number; subtitles: number };
}

export const EXPORT_COLUMNS = [
  'id', 'title', 'year', 'mediaType', 'season', 'episode',
  'matchStatus', 'confidence', 'locked',
  'resolution', 'videoCodec', 'hdr', 'container', 'sizeBytes',
  'hasArtwork', 'subtitleCount', 'addedAt',
] as const;

/**
 * CSV of a library, in the shape the browser is showing.
 *
 * **Streamed in pages, never materialised.** The analytics CSV loads up to
 * 50 000 rows into an array and joins it; at the library sizes this workspace
 * targets that is an out-of-memory error rather than a slow response. This
 * yields chunk by chunk, so peak memory is one page regardless of library size.
 *
 * It takes the **same filters as the browser**, so an export is what the
 * operator can see rather than a different query that happens to be nearby —
 * an export that silently covers more than the screen is a disclosure bug.
 */
@Injectable()
export class MediaExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private where(f: ExportFilters): Prisma.MediaItemWhereInput {
    const where: Prisma.MediaItemWhereInput = {};
    if (f.libraryId) where.libraryId = f.libraryId;
    if (f.mediaType) where.mediaType = f.mediaType;
    if (f.matchStatus) where.matchStatus = f.matchStatus;
    if (f.search?.trim()) where.title = { contains: f.search.trim(), mode: 'insensitive' };
    return where;
  }

  /**
   * Escape one CSV field.
   *
   * A leading `=`, `+`, `-` or `@` is prefixed with a quote: spreadsheet
   * software treats such a cell as a **formula**, so a media title like
   * `=cmd|...` becomes code execution on open. Media titles are arbitrary text
   * from filenames and providers, which makes this the realistic path.
   */
  static escape(value: unknown): string {
    const raw = value == null
      ? ''
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'boolean'
          ? (value ? 'true' : 'false')
          : String(value);
    const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  }

  /**
   * Yield the CSV a chunk at a time.
   *
   * Keyset pagination on `id` rather than `skip`/`take`: an OFFSET deep into a
   * large table makes Postgres walk every skipped row, so the last page of a
   * 500 000-row export costs far more than the first. It is also stable under
   * concurrent inserts, where an offset would skip or repeat rows.
   */
  async *streamCsv(filters: ExportFilters, ctx: AuditContext): AsyncGenerator<string> {
    yield `${EXPORT_COLUMNS.join(',')}\r\n`;

    const where = this.where(filters);
    let cursor: string | null = null;
    let exported = 0;

    for (;;) {
      const page: ExportRow[] = await this.prisma.mediaItem.findMany({
        where: cursor ? { ...where, id: { gt: cursor } } : where,
        orderBy: { id: 'asc' },
        take: CHUNK,
        select: {
          id: true, title: true, year: true, mediaType: true, season: true, episode: true,
          matchStatus: true, confidence: true, locked: true, createdAt: true,
          files: {
            take: 1,
            select: { resolution: true, videoCodec: true, hdr: true, container: true, size: true },
          },
          _count: { select: { artwork: true, subtitles: true } },
        },
      });
      const rows = page;
      if (!rows.length) break;

      for (const r of rows) {
        const file = r.files[0];
        yield `${[
          r.id, r.title, r.year, r.mediaType, r.season, r.episode,
          r.matchStatus, r.confidence, r.locked,
          file?.resolution, file?.videoCodec, file?.hdr, file?.container, file?.size,
          r._count.artwork > 0, r._count.subtitles,
          r.createdAt,
        ].map(MediaExportService.escape).join(',')}\r\n`;
      }

      exported += rows.length;
      cursor = rows[rows.length - 1].id;
      if (rows.length < CHUNK) break;
    }

    // Audited after the fact, with the real count: an export is a bulk read of
    // library contents, and the trail should say how much actually left.
    await this.audit.record({
      userId: ctx.userId,
      action: 'media.export.csv',
      objectType: 'media_library',
      objectId: filters.libraryId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { rows: exported, filters },
    });
  }
}
