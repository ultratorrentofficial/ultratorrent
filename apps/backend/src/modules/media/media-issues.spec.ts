import { ISSUE_KINDS, MediaItemService, issueWhere, needsAntiJoin } from './media-item.service';

describe('issueWhere', () => {
  it('handles every declared kind by one path or the other', () => {
    // A kind with neither a clause nor an anti-join would silently return the
    // whole library as "issues".
    for (const kind of ISSUE_KINDS) {
      const handled = needsAntiJoin(kind) || Object.keys(issueWhere(kind)).length > 0;
      expect(handled).toBe(true);
    }
  });

  it('expresses the cheap issues as indexed predicates', () => {
    expect(issueWhere('unmatched')).toEqual({ matchStatus: 'unmatched' });
    // Membership of a duplicate group, not a boolean nobody maintains.
    expect(issueWhere('duplicate')).toEqual({ duplicateGroupId: { not: null } });
  });

  it('returns NO clause for the relation-absence issues', () => {
    /*
     * Prisma's `{ none: {} }` compiles to NOT IN, which Postgres cannot satisfy
     * from the index on itemId. Measured on a live 25,312-item library it did
     * not finish inside two minutes, while the NOT EXISTS anti-join took 337ms.
     * Returning {} here means a caller cannot reintroduce the slow clause by
     * accident — the anti-join path is the only way to filter these.
     */
    expect(issueWhere('missing_artwork')).toEqual({});
    expect(issueWhere('missing_subtitles')).toEqual({});
    expect(needsAntiJoin('missing_artwork')).toBe(true);
    expect(needsAntiJoin('missing_subtitles')).toBe(true);
    expect(needsAntiJoin('unmatched')).toBe(false);
    expect(needsAntiJoin('duplicate')).toBe(false);
  });

  it('never emits a NOT IN relation filter for any kind', () => {
    for (const kind of ISSUE_KINDS) {
      expect(JSON.stringify(issueWhere(kind))).not.toContain('none');
    }
  });

  it('excludes issues that cannot be decided from the database', () => {
    // "Missing file" and "broken artwork" need to stat disk or decode an image.
    // Reporting them from a list query would either lie or make browsing wait
    // on I/O; they belong to a scan.
    expect(ISSUE_KINDS).not.toContain('missing_file' as never);
    expect(ISSUE_KINDS).not.toContain('broken_artwork' as never);
  });
});

describe('MediaItemService issue filtering', () => {
  const build = () => {
    const calls: any[] = [];
    const prisma: any = {
      $queryRawUnsafe: jest.fn(async (sql: string) =>
        sql.includes('COUNT(*)') ? [{ count: 0n }] : [],
      ),
      mediaItem: {
        count: jest.fn(async (args: any) => { calls.push(args); return calls.length; }),
        findMany: jest.fn(async (args: any) => { calls.push(args); return []; }),
      },
    };
    return { svc: new MediaItemService(prisma), calls, prisma };
  };

  it('narrows the listing to one cheap issue via Prisma', async () => {
    const { svc, prisma } = build();
    await svc.list({ libraryId: 'lib', issue: 'unmatched' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ libraryId: 'lib', matchStatus: 'unmatched' });
  });

  it('routes a relation-absence issue through the raw anti-join', async () => {
    const { svc, prisma } = build();
    prisma.$queryRawUnsafe = jest.fn(async (sql: string) =>
      sql.includes('COUNT(*)') ? [{ count: 2n }] : [{ id: 'a' }, { id: 'b' }],
    );
    const out: any = await svc.list({ libraryId: 'lib', issue: 'missing_artwork' });

    const sqls = prisma.$queryRawUnsafe.mock.calls.map((c: any[]) => c[0]);
    expect(sqls.some((q: string) => q.includes('NOT EXISTS'))).toBe(true);
    expect(sqls.every((q: string) => !q.includes('NOT IN'))).toBe(true);
    // Prisma then loads only that page's ids, with relations.
    expect(prisma.mediaItem.findMany.mock.calls[0][0].where.id).toEqual({ in: ['a', 'b'] });
    expect(out.total).toBe(2);
  });

  it('skips the second query when the anti-join page is empty', async () => {
    const { svc, prisma } = build();
    prisma.$queryRawUnsafe = jest.fn(async (sql: string) =>
      sql.includes('COUNT(*)') ? [{ count: 0n }] : [],
    );
    const out: any = await svc.list({ libraryId: 'lib', issue: 'missing_subtitles' });
    expect(out.items).toEqual([]);
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it('combines an issue with a search rather than replacing it', async () => {
    const { svc, prisma } = build();
    await svc.list({ libraryId: 'lib', issue: 'unmatched', search: 'dune' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.matchStatus).toBe('unmatched');
    expect(where.title).toEqual({ contains: 'dune', mode: 'insensitive' });
  });

  it('counts relation-absence issues with an anti-join, not NOT IN', async () => {
    const { svc, prisma } = build();
    prisma.$queryRawUnsafe = jest.fn(async () => [{ count: 7n }]);
    const counts = await svc.issueCounts('lib');
    const sqls = prisma.$queryRawUnsafe.mock.calls.map((c: any[]) => c[0]);
    expect(sqls).toHaveLength(2); // artwork + subtitles
    for (const q of sqls) {
      expect(q).toContain('NOT EXISTS');
      expect(q).not.toContain('NOT IN');
    }
    expect(counts.missing_artwork).toBe(7);
  });

  it('counts each issue separately, not as one grouped pass', async () => {
    // The conditions overlap — an unmatched item usually also lacks artwork —
    // so a single GROUP BY would put each item in one bucket and under-report
    // every other issue.
    const { svc, prisma } = build();
    await svc.issueCounts('lib');
    // Two through Prisma, two through the anti-join — still one per issue.
    expect(prisma.mediaItem.count).toHaveBeenCalledTimes(2);
  });

  it('scopes every count to the requested library', async () => {
    const { svc, prisma } = build();
    await svc.issueCounts('lib-1');
    for (const call of prisma.mediaItem.count.mock.calls) {
      expect(call[0].where.libraryId).toBe('lib-1');
    }
    for (const call of prisma.$queryRawUnsafe.mock.calls) {
      // Bound as a parameter, never interpolated.
      expect(call[1]).toBe('lib-1');
    }
  });

  it('returns a number for every kind, including zero', async () => {
    const prisma: any = {
      $queryRawUnsafe: jest.fn(async () => [{ count: 0n }]),
      mediaItem: { count: jest.fn(async () => 0), findMany: jest.fn() },
    };
    const svc = new MediaItemService(prisma);
    const counts = await svc.issueCounts('lib');
    for (const kind of ISSUE_KINDS) {
      expect(counts[kind]).toBe(0);
    }
  });
});
