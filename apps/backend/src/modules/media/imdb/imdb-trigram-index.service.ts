import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

/**
 * The GIN trigram indexes that make case-insensitive IMDb title lookups
 * index-backed. Identifiers are compile-time constants — never user input — so
 * they are safe to interpolate into DDL (which cannot be parameterised).
 */
const TRIGRAM_INDEXES = [
  { name: 'imdb_titles_primary_title_trgm_idx', table: 'imdb_titles', column: 'primaryTitle' },
  { name: 'imdb_titles_original_title_trgm_idx', table: 'imdb_titles', column: 'originalTitle' },
  { name: 'imdb_akas_title_trgm_idx', table: 'imdb_akas', column: 'title' },
] as const;

/**
 * Builds the IMDb trigram indexes **at runtime, concurrently, off the boot path**.
 *
 * Why not a migration? Prisma renders `mode: 'insensitive'` as ILIKE, which cannot
 * use a btree index — on the 8.9M-row catalogue that made every title lookup a
 * whole-table scan (47.8s per call, measured live) and starved concurrent work.
 * The fix is a GIN `gin_trgm_ops` index, but building one on a fully-imported
 * catalogue takes minutes and a plain `CREATE INDEX` holds a lock. Inside a
 * migration that blocks the deploy — and if the build is killed mid-flight Prisma
 * marks the migration failed (P3009) and the app then refuses to boot at all (a
 * real outage we hit). `CREATE INDEX CONCURRENTLY` also cannot run inside a
 * transaction, so it could never live in a Prisma migration regardless.
 *
 * So: fire-and-forget on boot. The app serves normally while the index builds in
 * the background; a fresh install builds them instantly (empty catalogue) and an
 * existing one back-fills them without downtime. Idempotent — a no-op once built.
 */
@Injectable()
export class ImdbTrigramIndexService implements OnModuleInit {
  private readonly logger = new Logger(ImdbTrigramIndexService.name);

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    // Deliberately NOT awaited: a multi-minute index build must never delay boot.
    void this.ensureIndexes();
  }

  async ensureIndexes(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');

      for (const idx of TRIGRAM_INDEXES) {
        // A CONCURRENTLY build that is interrupted leaves the index behind but
        // marked INVALID: the planner ignores it, yet `IF NOT EXISTS` sees the name
        // and would skip the rebuild forever. Drop it so we rebuild cleanly.
        if (await this.isInvalid(idx.name)) {
          this.logger.warn(`Dropping invalid index ${idx.name} (a previous build was interrupted)`);
          await this.prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${idx.name}"`);
        }
        if (await this.isValid(idx.name)) continue; // already built — no-op

        const started = Date.now();
        this.logger.log(`Building ${idx.name} concurrently (this can take minutes; the app stays up)…`);
        await this.prisma.$executeRawUnsafe(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${idx.name}" ` +
            `ON "${idx.table}" USING gin ("${idx.column}" gin_trgm_ops)`,
        );
        this.logger.log(`Built ${idx.name} in ${Math.round((Date.now() - started) / 1000)}s`);
      }
    } catch (err) {
      // Best-effort: a missing index only costs speed, never correctness, and must
      // never take the service down.
      this.logger.warn(`Could not ensure IMDb trigram indexes: ${(err as Error).message}`);
    }
  }

  private async isValid(name: string): Promise<boolean> {
    return this.exists(name, true);
  }

  private async isInvalid(name: string): Promise<boolean> {
    return this.exists(name, false);
  }

  private async exists(name: string, valid: boolean): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = $1 AND i.indisvalid = $2`,
      name,
      valid,
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }
}
