import { ImdbTrigramIndexService } from './imdb-trigram-index.service';

/**
 * `exists(name, valid)` is asked twice per index: first "is it INVALID?" then
 * "is it VALID?". Drive those answers per index name so we can simulate
 * already-built / missing / left-invalid-by-an-interrupted-build.
 */
function build(state: Record<string, 'valid' | 'invalid' | 'missing'> = {}) {
  const executed: string[] = [];
  const prisma = {
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
    $queryRawUnsafe: jest.fn(async (_sql: string, name: string, valid: boolean) => {
      const s = state[name] ?? 'missing';
      const hit = valid ? s === 'valid' : s === 'invalid';
      return [{ n: BigInt(hit ? 1 : 0) }];
    }),
  };
  const svc = new ImdbTrigramIndexService(prisma as any);
  return { svc, prisma, executed };
}

const ALL = [
  'imdb_titles_primary_title_trgm_idx',
  'imdb_titles_original_title_trgm_idx',
  'imdb_akas_title_trgm_idx',
];

describe('ImdbTrigramIndexService', () => {
  it('builds every missing index CONCURRENTLY (never inside a transaction)', async () => {
    const { svc, executed } = build();
    await svc.ensureIndexes();

    expect(executed[0]).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/);
    for (const name of ALL) {
      const stmt = executed.find((s) => s.includes(name) && s.includes('CREATE INDEX'));
      expect(stmt).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
      expect(stmt).toMatch(/USING gin \(".+" gin_trgm_ops\)/);
    }
  });

  it('is a no-op when the indexes are already valid', async () => {
    const { svc, executed } = build({
      imdb_titles_primary_title_trgm_idx: 'valid',
      imdb_titles_original_title_trgm_idx: 'valid',
      imdb_akas_title_trgm_idx: 'valid',
    });
    await svc.ensureIndexes();
    expect(executed.filter((s) => s.includes('CREATE INDEX'))).toHaveLength(0);
  });

  it('drops and rebuilds an index left INVALID by an interrupted build', async () => {
    // An interrupted CONCURRENTLY build leaves the name present but unusable, and
    // IF NOT EXISTS would then skip the rebuild forever.
    const { svc, executed } = build({ imdb_titles_primary_title_trgm_idx: 'invalid' });
    await svc.ensureIndexes();

    expect(executed).toContainEqual(
      expect.stringContaining('DROP INDEX IF EXISTS "imdb_titles_primary_title_trgm_idx"'),
    );
    expect(
      executed.find(
        (s) => s.includes('CREATE INDEX') && s.includes('imdb_titles_primary_title_trgm_idx'),
      ),
    ).toBeTruthy();
  });

  it('never throws — a missing index costs speed, not correctness', async () => {
    const { svc, prisma } = build();
    prisma.$executeRawUnsafe.mockRejectedValue(new Error('permission denied'));
    await expect(svc.ensureIndexes()).resolves.toBeUndefined();
  });

  it('does not block boot (onModuleInit returns without awaiting the build)', () => {
    const { svc } = build();
    expect(svc.onModuleInit()).toBeUndefined(); // fire-and-forget, not a promise
  });
});
