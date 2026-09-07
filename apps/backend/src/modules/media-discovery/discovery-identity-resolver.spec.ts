import { DiscoveryIdentityResolverService } from './discovery-identity-resolver.service';

/**
 * The regression suite for the duplicates that shipped.
 *
 * "The Terminal List" and "The Terminal List (2022)" were monitored twice, as
 * were "Tulsa King" and "Tulsa King (2022)". Each test here names a specific way
 * the old code failed to notice a show it was already managing.
 */

function harness(over: any = {}) {
  const prisma: any = {
    mediaAcquisitionWatchlistItem: {
      findFirst: jest.fn(async ({ where }: any) => {
        const rows: any[] = over.watchlist ?? [];
        if (where.externalIds) {
          const [ns] = where.externalIds.path;
          return (
            rows.find((r) => r.type === where.type && r.externalIds?.[ns] === where.externalIds.equals) ?? null
          );
        }
        return null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const rows: any[] = (over.watchlist ?? []).filter((r: any) => r.type === where.type);
        const exact: string[] = where.OR?.[0]?.normalizedTitle?.in ?? [];
        const contains: string = where.OR?.[1]?.normalizedTitle?.contains ?? '';
        return rows.filter(
          (r) =>
            exact.includes(r.normalizedTitle) ||
            (contains && r.normalizedTitle.includes(contains)),
        );
      }),
    },
    rssRule: {
      findUnique: jest.fn(async ({ where }: any) => (over.rules ?? []).find((r: any) => r.id === where.id) ?? null),
      findFirst: jest.fn(async () => over.generatedRule ?? null),
      findMany: jest.fn(async ({ where }: any) => {
        const needle = (where.name?.contains ?? '').toLowerCase();
        return (over.rules ?? []).filter((r: any) => r.name.toLowerCase().includes(needle));
      }),
    },
    mediaExternalId: { findMany: jest.fn(async () => over.links ?? []) },
  };
  return { svc: new DiscoveryIdentityResolverService(prisma), prisma };
}

/** A watchlist row as the table actually stores it: raw lowercased title. */
const wl = (title: string, over: any = {}) => ({
  id: over.id ?? 'wl1',
  // The real query always scopes by type; a movie must never find a series row.
  type: over.type ?? 'series',
  status: over.status ?? 'active',
  rssRuleId: over.rssRuleId ?? null,
  title,
  year: over.year ?? null,
  normalizedTitle: title.toLowerCase().trim(),
  externalIds: over.externalIds ?? null,
});

const rule = (name: string, over: any = {}) => ({
  id: over.id ?? 'r1',
  name,
  generatedByDiscovery: over.generatedByDiscovery ?? false,
  userModifiedAt: over.userModifiedAt ?? null,
});

describe('the reported duplicates', () => {
  /*
   * THE bug. A hand-added entry carries no external ids, so the id lookup finds
   * nothing and the title path decides — and it used to compare
   * "the terminal list (2022)" against "the terminal list".
   */
  it('matches a discovered "The Terminal List (2022)" to an existing "The Terminal List"', async () => {
    const { svc } = harness({ watchlist: [wl('The Terminal List')], rules: [rule('The Terminal List')] });
    const r = await svc.resolve({
      mediaType: 'tv', title: 'The Terminal List (2022)', year: 2022, externalIds: { tmdb: '119051' },
    });
    expect(r.state).toBe('already_monitored');
    expect(r.matchedBy).toBe('canonical_title');
    expect(r.watchlistItem?.id).toBe('wl1');
  });

  it('matches a discovered "Tulsa King" to an existing "Tulsa King (2022)"', async () => {
    const { svc } = harness({ watchlist: [wl('Tulsa King (2022)', { year: 2022 })] });
    const r = await svc.resolve({ mediaType: 'tv', title: 'Tulsa King', year: 2022, externalIds: {} });
    expect(r.state).toBe('monitoring_incomplete');
    expect(r.watchlistItem?.id).toBe('wl1');
  });

  it('matches regardless of provider capitalisation and punctuation', async () => {
    const { svc } = harness({ watchlist: [wl('The Terminal List')] });
    for (const title of ['THE TERMINAL LIST', 'The.Terminal.List.2022', 'the terminal list (2022)']) {
      const r = await svc.resolve({ mediaType: 'tv', title, year: 2022, externalIds: {} });
      expect(r.state).not.toBe('none');
    }
  });

  /*
   * An id match must end the search — it is proof, and it is the only thing that
   * still works when the two titles genuinely differ (a localised name, a
   * renamed show).
   */
  it('prefers an external id over any title comparison', async () => {
    const { svc } = harness({
      watchlist: [wl('Completely Different Name', { externalIds: { imdb: 'tt1' } })],
    });
    const r = await svc.resolve({ mediaType: 'tv', title: 'Silo', year: 2023, externalIds: { imdb: 'tt1' } });
    expect(r.matchedBy).toBe('external_id');
    expect(r.matchedIdNamespace).toBe('imdb');
  });

  it('does not fuse two works that share a title but not a year', async () => {
    const { svc } = harness({ watchlist: [wl('The Odyssey (1997)', { year: 1997 })] });
    const r = await svc.resolve({ mediaType: 'movie', title: 'The Odyssey', year: 2026, externalIds: {} });
    expect(r.state).toBe('none');
  });

  /*
   * Numbers that are part of a title must not be read as years, or unrelated
   * shows merge into one monitored identity.
   */
  it('does not fuse Blade Runner 2049 with Blade Runner', async () => {
    const { svc } = harness({ watchlist: [wl('Blade Runner', { year: 1982 })] });
    const r = await svc.resolve({ mediaType: 'movie', title: 'Blade Runner 2049', year: 2017, externalIds: {} });
    expect(r.state).toBe('none');
  });

  it('keeps a movie and a series of the same name apart', async () => {
    const { svc } = harness({ watchlist: [wl('Fargo')] });
    const r = await svc.resolve({ mediaType: 'movie', title: 'Fargo', year: 1996, externalIds: {} });
    // The watchlist row is a series; a movie query never asks for it.
    expect(r.watchlistItem).toBeNull();
  });
});

describe('rule identity', () => {
  it('finds a hand-made rule whose name differs only by its year', async () => {
    const { svc } = harness({ rules: [rule('Tulsa King', { id: 'manual-1' })] });
    const r = await svc.resolve({ mediaType: 'tv', title: 'Tulsa King', year: 2022, externalIds: {} });
    expect(r.rssRule?.id).toBe('manual-1');
    expect(r.rssRule?.generatedByDiscovery).toBe(false);
    expect(r.state).toBe('monitoring_incomplete');
  });

  it('reports a rule a person edited so it is never treated as generated', async () => {
    const { svc } = harness({
      rules: [rule('Silo (2023)', { generatedByDiscovery: true, userModifiedAt: new Date() })],
    });
    const r = await svc.resolve({ mediaType: 'tv', title: 'Silo', year: 2023, externalIds: {} });
    expect(r.rssRule?.userModifiedAt).not.toBeNull();
  });
});

describe('existing state', () => {
  it('is already_monitored only when both halves exist', async () => {
    const { svc } = harness({
      watchlist: [wl('Silo', { rssRuleId: 'r1' })],
      rules: [rule('Silo')],
    });
    expect((await svc.resolve({ mediaType: 'tv', title: 'Silo', year: 2023, externalIds: {} })).state)
      .toBe('already_monitored');
  });

  it('is exists_not_monitored when only the library has it', async () => {
    const { svc } = harness({ links: [{ itemId: 'mi1' }, { itemId: 'mi2' }] });
    const r = await svc.resolve({ mediaType: 'tv', title: 'Silo', year: 2023, externalIds: { tmdb: '1' } });
    expect(r.state).toBe('exists_not_monitored');
    expect(r.libraryItemIds).toEqual(['mi1', 'mi2']);
  });

  /*
   * Library matching is external-id only, here for the same reason as in
   * removal: claiming somebody owns a show they do not would suppress a title
   * they actually wanted.
   */
  it('does not claim library ownership without an external id', async () => {
    const { svc, prisma } = harness({ links: [{ itemId: 'mi1' }] });
    const r = await svc.resolve({ mediaType: 'tv', title: 'Silo', year: 2023, externalIds: {} });
    expect(prisma.mediaExternalId.findMany).not.toHaveBeenCalled();
    expect(r.libraryItemIds).toEqual([]);
  });

  it('is none for a genuinely new title, which is the only case that may create', async () => {
    const { svc } = harness();
    const r = await svc.resolve({ mediaType: 'tv', title: 'Brand New Show', year: 2026, externalIds: { tmdb: '9' } });
    expect(r.state).toBe('none');
    expect(r.detail).toMatch(/Not present/);
  });
});
