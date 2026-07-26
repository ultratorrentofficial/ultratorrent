import { ISSUE_KINDS, MediaItemService, issueWhere } from './media-item.service';

describe('issueWhere', () => {
  it('covers every declared kind', () => {
    // A kind without a clause would silently return the unfiltered library.
    for (const kind of ISSUE_KINDS) {
      expect(issueWhere(kind)).toBeDefined();
      expect(Object.keys(issueWhere(kind)).length).toBeGreaterThan(0);
    }
  });

  it('expresses each issue as the condition an operator means', () => {
    expect(issueWhere('unmatched')).toEqual({ matchStatus: 'unmatched' });
    expect(issueWhere('missing_artwork')).toEqual({ artwork: { none: {} } });
    expect(issueWhere('missing_subtitles')).toEqual({ subtitles: { none: {} } });
    // Membership of a duplicate group, not a boolean nobody maintains.
    expect(issueWhere('duplicate')).toEqual({ duplicateGroupId: { not: null } });
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
      mediaItem: {
        count: jest.fn(async (args: any) => { calls.push(args); return calls.length; }),
        findMany: jest.fn(async (args: any) => { calls.push(args); return []; }),
      },
    };
    return { svc: new MediaItemService(prisma), calls, prisma };
  };

  it('narrows the listing to one issue', async () => {
    const { svc, prisma } = build();
    await svc.list({ libraryId: 'lib', issue: 'missing_artwork' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ libraryId: 'lib', artwork: { none: {} } });
  });

  it('combines an issue with a search rather than replacing it', async () => {
    const { svc, prisma } = build();
    await svc.list({ libraryId: 'lib', issue: 'unmatched', search: 'dune' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.matchStatus).toBe('unmatched');
    expect(where.title).toEqual({ contains: 'dune', mode: 'insensitive' });
  });

  it('counts each issue separately, not as one grouped pass', async () => {
    // The conditions overlap — an unmatched item usually also lacks artwork —
    // so a single GROUP BY would put each item in one bucket and under-report
    // every other issue.
    const { svc, prisma } = build();
    await svc.issueCounts('lib');
    expect(prisma.mediaItem.count).toHaveBeenCalledTimes(ISSUE_KINDS.length);
  });

  it('scopes every count to the requested library', async () => {
    const { svc, prisma } = build();
    await svc.issueCounts('lib-1');
    for (const call of prisma.mediaItem.count.mock.calls) {
      // `artwork: { none: {} }` compiles to NOT IN, which hung the dashboard at
      // ~390k artwork rows. The library filter is what keeps the row set small.
      expect(call[0].where.libraryId).toBe('lib-1');
    }
  });

  it('returns a number for every kind, including zero', async () => {
    const prisma: any = { mediaItem: { count: jest.fn(async () => 0), findMany: jest.fn() } };
    const svc = new MediaItemService(prisma);
    const counts = await svc.issueCounts('lib');
    for (const kind of ISSUE_KINDS) {
      expect(counts[kind]).toBe(0);
    }
  });
});
