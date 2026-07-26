import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MediaHealthService } from './media-health.service';

/**
 * The Media Manager dashboard.
 *
 * It hung indefinitely in production once the artwork table reached ~390k rows.
 * The counts are cheap to get wrong in a way nothing catches: `tsc` is happy,
 * and a unit test against a handful of mock rows is fast whichever SQL is
 * generated. It only fails at real scale, as a page that never loads.
 */
describe('MediaHealthService — dashboard counts', () => {
  const build = (over: unknown[] = []) => {
    const results = [
      [{ mediaType: 'movie', _count: { _all: 12 } }, { mediaType: 'episode', _count: { _all: 30 } }],
      42,          // total
      3,           // unmatched
      2,           // lowConfidence
      [{ count: 26949n }], // missingArtwork  — raw rows, bigint
      [{ count: 26949n }], // missingSubtitles
      5,           // recentlyAdded
      1,           // duplicateGroups
      4,           // failedJobs
      ...over,
    ];
    const prisma: any = {
      $transaction: jest.fn(async () => results),
      mediaLibrary: { findMany: jest.fn(async () => []) },
      $queryRaw: jest.fn(),
      mediaItem: { count: jest.fn(), groupBy: jest.fn() },
      mediaDuplicateGroup: { count: jest.fn() },
      mediaProcessingJob: { count: jest.fn() },
    };
    return { svc: new MediaHealthService(prisma), prisma };
  };

  it('returns plain numbers, not bigints', async () => {
    const { svc } = build();
    const out: any = await svc.health();
    // A bigint throws on JSON.stringify — the response would 500 rather than
    // render, which is a different broken page from the one this replaced.
    expect(typeof out.missingArtwork).toBe('number');
    expect(typeof out.missingSubtitles).toBe('number');
    expect(out.missingArtwork).toBe(26949);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('reports zero rather than NaN when a count comes back empty', async () => {
    const { svc, prisma } = build();
    prisma.$transaction.mockResolvedValueOnce([
      [], 0, 0, 0, [], [], 0, 0, 0,
    ]);
    const out: any = await svc.health();
    expect(out.missingArtwork).toBe(0);
    expect(out.missingSubtitles).toBe(0);
  });

  it('still aggregates the per-type breakdown', async () => {
    const { svc } = build();
    const out: any = await svc.health();
    expect(out.byMediaType).toEqual({ movie: 12, episode: 30 });
    expect(out.total).toBe(42);
  });

  /**
   * A structural guard, because the behavioural difference is invisible at test
   * scale. Prisma's `{ artwork: { none: {} } }` compiles to `NOT IN (subquery)`,
   * which Postgres cannot satisfy from the index on `itemId` — three-valued
   * logic over a nullable column forces it to materialise the subquery per row.
   * Measured on the live dataset: unbounded (180s+, never completed) versus
   * ~0.5s for the anti-join.
   */
  it('uses an anti-join rather than Prisma\'s NOT IN form', () => {
    const src = readFileSync(join(__dirname, 'media-health.service.ts'), 'utf8');
    expect(src).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM media_artwork/i);
    expect(src).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM media_subtitles/i);
    // Matched against the call form, not the words: the comment above the fix
    // quotes the Prisma expression it replaced.
    expect(src).not.toMatch(/mediaItem\.count\(\{\s*where:\s*\{\s*(artwork|subtitles):/);
  });
});
