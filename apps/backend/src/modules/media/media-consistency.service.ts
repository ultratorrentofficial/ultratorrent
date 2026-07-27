import { Injectable, Logger } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Rows examined per round trip. Bounded so a 500k library never lands in memory. */
const CHUNK = 2000;

export interface ConsistencyReport {
  libraryId: string;
  checked: number;
  /** Rows whose file is not on disk — a move that did not update the record. */
  missingFiles: Array<{ id: string; path: string; kind: string }>;
  /** Totals per record type, so a spike points at the subsystem that caused it. */
  byKind: Record<string, number>;
  truncated: boolean;
}

/** Exactly the projection below — named so the paged loop is not inferred recursively. */
interface CheckRow {
  id: string;
  path: string;
  files: Array<{ id: string; path: string }>;
  subtitles: Array<{ id: string; path: string }>;
  nfoFiles: Array<{ id: string; path: string }>;
  artwork: Array<{ id: string; localPath: string | null }>;
}

/** How many offenders to name before reporting a count only. */
const MAX_REPORTED = 500;

/**
 * Does the database still describe what is on disk?
 *
 * Staleness is a *code* property — a transaction that moves a file without
 * updating its records — so the honest way to talk about it is to measure it
 * rather than assume either direction. This answers "how bad is it", which is
 * the question that decides whether a repair is warranted at all.
 *
 * It reads; it never repairs. A checker that silently fixed things would hide
 * the very defect it exists to reveal, and the fix for a stale row is not
 * always "delete it" — a moved file wants relinking, a genuinely deleted one
 * wants pruning, and only a human knows which happened.
 *
 * All five path-bearing records are checked, not just `MediaItem`: everything in
 * a media folder belongs to the item it accompanies, so a subtitle row pointing
 * at nothing is the same class of defect as an item row pointing at nothing.
 */
@Injectable()
export class MediaConsistencyService {
  private readonly logger = new Logger(MediaConsistencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async exists(p: string): Promise<boolean> {
    return !!(await stat(p).catch(() => null));
  }

  async check(libraryId: string): Promise<ConsistencyReport> {
    const report: ConsistencyReport = {
      libraryId,
      checked: 0,
      missingFiles: [],
      byKind: {},
      truncated: false,
    };

    const note = (kind: string, id: string, path: string) => {
      report.byKind[kind] = (report.byKind[kind] ?? 0) + 1;
      if (report.missingFiles.length < MAX_REPORTED) {
        report.missingFiles.push({ id, path, kind });
      } else {
        // Named up to a bound, counted beyond it. A response holding half a
        // million paths helps nobody and would not survive serialization.
        report.truncated = true;
      }
    };

    // Items and their files, paged by keyset so a large library never lands in
    // memory at once.
    let cursor: string | null = null;
    for (;;) {
      const rows: CheckRow[] = await this.prisma.mediaItem.findMany({
        where: cursor ? { libraryId, id: { gt: cursor } } : { libraryId },
        orderBy: { id: 'asc' },
        take: CHUNK,
        select: {
          id: true, path: true,
          files: { select: { id: true, path: true } },
          subtitles: { select: { id: true, path: true } },
          nfoFiles: { select: { id: true, path: true } },
          artwork: { select: { id: true, localPath: true } },
        },
      });
      if (!rows.length) break;

      for (const row of rows) {
        report.checked += 1;
        if (!(await this.exists(row.path))) note('item', row.id, row.path);
        for (const f of row.files) {
          if (!(await this.exists(f.path))) note('file', f.id, f.path);
        }
        for (const s of row.subtitles) {
          if (!(await this.exists(s.path))) note('subtitle', s.id, s.path);
        }
        for (const n of row.nfoFiles) {
          if (!(await this.exists(n.path))) note('nfo', n.id, n.path);
        }
        for (const a of row.artwork) {
          // Provider artwork has a URL and no local file; only stored art has a
          // path to verify, so a null is correct rather than missing.
          if (a.localPath && !(await this.exists(a.localPath))) note('artwork', a.id, a.localPath);
        }
      }

      cursor = rows[rows.length - 1].id;
      if (rows.length < CHUNK) break;
    }

    const total = Object.values(report.byKind).reduce((a, b) => a + b, 0);
    if (total) {
      this.logger.warn(
        `Consistency check on ${libraryId}: ${total} record(s) point at files that do not exist.`,
      );
    }
    return report;
  }
}
