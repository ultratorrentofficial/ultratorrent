import { ImdbTrigramIndexService } from './imdb-trigram-index.service';

/**
 * `exists(name, valid)` is asked twice per index: first "is it INVALID?" then
 * "is it VALID?". Drive those answers per index name so we can simulate
 * already-built / missing / left-invalid-by-an-interrupted-build.
 */
function build(
  state: Record<string, 'valid' | 'invalid' | 'missing'> = {},
  opts: { activeBuildPids?: number[] } = {},
) {
  const executed: string[] = [];
  const queried: string[] = [];
  const prisma = {
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
    $queryRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => {
      queried.push(sql);
      // The shutdown path asks pg_stat_activity which builds are in flight, then
      // cancels each returned pid; the index-state path asks exists(name, valid).
      if (sql.includes('pg_stat_activity')) {
        // Postgres runs pg_cancel_backend(pid) inline; the rows come back cancelled.
        return (opts.activeBuildPids ?? []).map((pid) => ({ pid, cancelled: true }));
      }
      const [name, valid] = params as [string, boolean];
      const s = state[name] ?? 'missing';
      const hit = valid ? s === 'valid' : s === 'invalid';
      return [{ n: BigInt(hit ? 1 : 0) }];
    }),
  };
  const svc = new ImdbTrigramIndexService(prisma as any);
  return { svc, prisma, executed, queried };
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

  describe('shutdown', () => {
    it('cancels an in-flight build instead of waiting for it', async () => {
      // Without this, PrismaService.$disconnect() blocks on the CONCURRENTLY build
      // for the rest of its run (~8min measured) and systemd SIGKILLs the process.
      const { svc, prisma, queried } = build({}, { activeBuildPids: [4242] });
      svc.onModuleInit();
      await svc.onModuleDestroy();

      const lookup = queried.find((s) => s.includes('pg_stat_activity'));
      expect(lookup).toMatch(/CREATE INDEX CONCURRENTLY%/);
      expect(lookup).toMatch(/pid <> pg_backend_pid\(\)/); // never cancel ourselves
      expect(lookup).toMatch(/datname = current_database\(\)/);
      // The cancel must happen server-side in this same statement. Reading the pid back
      // and passing it to pg_cancel_backend($1) fails live with 42883, because Prisma
      // marshals the number as int8 and only the int4 overload exists — a mocked client
      // cannot catch that, so at least pin the shape that avoids it.
      expect(lookup).toMatch(/pg_cancel_backend\(pid\)/);
      expect(queried.some((s) => /pg_cancel_backend\(\$1\)/.test(s))).toBe(false);
    });

    it('cancels nothing when no build is in flight', async () => {
      // The statement is always issued; with nothing matching it cancels zero rows.
      const { svc, queried } = build({}, { activeBuildPids: [] });
      svc.onModuleInit();
      await expect(svc.onModuleDestroy()).resolves.toBeUndefined();

      const lookup = queried.find((s) => s.includes('pg_stat_activity'));
      expect(lookup).toBeTruthy();
    });

    it('never starts another index once shutdown has begun', async () => {
      const { svc, executed } = build();
      // Trip the shutdown flag as the first build starts; the loop must then stop
      // rather than kick off the remaining multi-minute builds.
      const prismaAny = svc as any;
      const original = prismaAny.prisma.$executeRawUnsafe;
      prismaAny.prisma.$executeRawUnsafe = jest.fn(async (sql: string) => {
        if (sql.includes('CREATE INDEX')) prismaAny.shuttingDown = true;
        return original(sql);
      });

      await svc.ensureIndexes();
      expect(executed.filter((s) => s.includes('CREATE INDEX'))).toHaveLength(1);
    });

    it('does not throw when the cancel itself fails', async () => {
      const { svc, prisma } = build({}, { activeBuildPids: [1] });
      svc.onModuleInit();
      prisma.$queryRawUnsafe.mockRejectedValue(new Error('connection closed'));

      await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
