import { DiscoveryStoreService } from './discovery-store.service';
import { mergeDiscoveries } from './discovery-identity';
import type { RawDiscovery } from './discovery-provider';

const merged = (provider: string, over: Partial<RawDiscovery>) =>
  mergeDiscoveries([{ provider, raw: { mediaType: 'tv', title: 'Silo', externalIds: {}, ...over } }])[0];

/** In-memory stand-in for the two tables the store writes. */
function fakePrisma(rows: any[] = []) {
  const dates: any[] = [];
  const suppressed: { dedupeKey: string }[] = [];
  return {
    rows,
    dates,
    discoveredMedia: {
      findFirst: jest.fn(async ({ where }: any) => {
        const keys: string[] = where.OR[0].dedupeKey.in;
        const idFilters = where.OR.slice(1);
        return (
          rows.find((r) => {
            if (r.mediaType !== where.mediaType) return false;
            if (keys.includes(r.dedupeKey)) return true;
            return idFilters.some((f: any) => {
              const [ns] = f.externalIds.path;
              return r.externalIds?.[ns] === f.externalIds.equals;
            });
          }) ?? null
        );
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `row${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
    discoveredMediaReleaseDate: {
      findFirst: jest.fn(async ({ where }: any) =>
        dates.find(
          (d) =>
            d.discoveredMediaId === where.discoveredMediaId &&
            d.releaseType === where.releaseType &&
            d.region === where.region &&
            d.source === where.source,
        ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        dates.push({ id: `d${dates.length + 1}`, ...data });
        return data;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(dates.find((d) => d.id === where.id), data);
      }),
    },
    discoverySuppression: {
      findMany: jest.fn(async () => suppressed),
    },
    /** Test hook: identities a person removed. */
    __suppress: (...keys: string[]) => suppressed.push(...keys.map((dedupeKey) => ({ dedupeKey }))),
  };
}

describe('DiscoveryStoreService — the moving key', () => {
  /*
   * THE trap this service exists for. A TVmaze-only show is keyed `tvmaze:1234`.
   * When TMDB later reports it with an IMDb id the canonical key becomes
   * `imdb:tt…`, and a lookup by canonical key alone would find nothing and insert
   * a SECOND row for a show already stored. The two would then drift, each
   * collecting half the providers.
   */
  it('finds a stored row by an alternate key when the canonical key has moved', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);

    await store.persist([merged('tvmaze', { externalIds: { tvmaze: '1234' } })]);
    expect(p.rows[0].dedupeKey).toBe('tvmaze:1234');

    // TMDB now contributes an IMDb id: the canonical key is imdb, but tvmaze:1234
    // is still among the alternates.
    const result = await store.persist([
      merged('tmdb', { externalIds: { tvmaze: '1234', imdb: 'tt5', tmdb: '9' } }),
    ]);

    expect(p.rows).toHaveLength(1);
    expect(result).toEqual({ created: 0, updated: 1, failed: 0, suppressed: 0 });
  });

  /*
   * The direction alternate keys CANNOT cover: the stored row is keyed by the
   * strong id, and the incoming record knows only the weak one. Matching on the
   * stored externalIds is what catches it.
   */
  it('finds a stored row by an external id even when no key overlaps', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);

    await store.persist([merged('tmdb', { externalIds: { imdb: 'tt5', tvmaze: '1234' } })]);
    expect(p.rows[0].dedupeKey).toBe('imdb:tt5');

    await store.persist([merged('tvmaze', { externalIds: { tvmaze: '1234' } })]);
    expect(p.rows).toHaveLength(1);
  });

  it('does not rewrite the stored dedupeKey when a stronger id arrives', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);
    await store.persist([merged('tvmaze', { externalIds: { tvmaze: '1234' } })]);
    await store.persist([merged('tmdb', { externalIds: { tvmaze: '1234', imdb: 'tt5' } })]);
    // Renaming a row's identity mid-life gains nothing and risks colliding with
    // the unique constraint against a different row.
    expect(p.rows[0].dedupeKey).toBe('tvmaze:1234');
  });

  it('keeps two genuinely different works apart', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);
    await store.persist([merged('tmdb', { externalIds: { tmdb: '1368337' } })]);
    await store.persist([merged('tmdb', { externalIds: { tmdb: '1698863' } })]);
    expect(p.rows).toHaveLength(2);
  });

  it('does not confuse a film and a series sharing a TMDB number', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);
    await store.persist([merged('tmdb', { mediaType: 'movie', externalIds: { tmdb: '55' } })]);
    await store.persist([merged('tmdb', { mediaType: 'tv', externalIds: { tmdb: '55' } })]);
    expect(p.rows).toHaveLength(2);
  });
});

describe('DiscoveryStoreService — accumulating rather than replacing', () => {
  /*
   * A provider being quiet is not a provider retracting. A sync where only TVmaze
   * answered must not erase the TMDB id a previous sync learned.
   */
  it('keeps an id a previous sync learned when this sync does not report it', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);
    await store.persist([merged('tmdb', { externalIds: { imdb: 'tt5', tmdb: '9' } })]);
    await store.persist([merged('tvmaze', { externalIds: { imdb: 'tt5', tvmaze: '1' } })]);

    expect(p.rows[0].externalIds).toEqual({ imdb: 'tt5', tmdb: '9', tvmaze: '1' });
    expect(p.rows[0].sourceProviders.sort()).toEqual(['tmdb', 'tvmaze']);
  });

  it('updates a provider’s own date rather than adding a second row for it', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);
    const withDate = (date: string) =>
      merged('tmdb', {
        externalIds: { imdb: 'tt5' },
        releaseDates: [{ releaseType: 'digital', date, region: 'US', confidence: 0.9 }],
      });

    await store.persist([withDate('2026-10-01')]);
    await store.persist([withDate('2026-10-08')]);

    expect(p.dates).toHaveLength(1);
    expect(p.dates[0].date).toEqual(new Date('2026-10-08'));
  });

  /*
   * Postgres treats NULLs as DISTINCT in a unique constraint, so a region-less
   * date can never collide with itself — an upsert would insert a fresh row every
   * sync and the table would grow without bound.
   */
  it('does not duplicate a region-less date on every sync', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);
    const noRegion = merged('tvmaze', {
      externalIds: { tvmaze: '1' },
      releaseDates: [{ releaseType: 'episode_air', date: '2026-10-01', confidence: 0.7 }],
    });

    await store.persist([noRegion]);
    await store.persist([noRegion]);
    await store.persist([noRegion]);

    expect(p.dates).toHaveLength(1);
  });

  it('keeps two providers’ dates side by side rather than collapsing them', async () => {
    const p = fakePrisma();
    const store = new DiscoveryStoreService(p as any);
    await store.persist([
      mergeDiscoveries([
        { provider: 'tmdb', raw: { mediaType: 'tv', title: 'S', externalIds: { imdb: 'tt5' }, releaseDates: [{ releaseType: 'streaming', date: '2026-10-01', confidence: 0.9 }] } },
        { provider: 'tvmaze', raw: { mediaType: 'tv', title: 'S', externalIds: { imdb: 'tt5' }, releaseDates: [{ releaseType: 'streaming', date: '2026-10-03', confidence: 0.7 }] } },
      ])[0],
    ]);
    expect(p.dates.map((d) => d.source).sort()).toEqual(['tmdb', 'tvmaze']);
  });
});

describe('DiscoveryStoreService — resilience', () => {
  it('one bad record does not abandon the rest of the sync', async () => {
    const p = fakePrisma();
    p.discoveredMedia.create.mockRejectedValueOnce(new Error('constraint'));
    const store = new DiscoveryStoreService(p as any);

    const result = await store.persist([
      merged('tmdb', { externalIds: { tmdb: '1' } }),
      merged('tmdb', { externalIds: { tmdb: '2' } }),
    ]);
    expect(result).toEqual({ created: 1, updated: 0, failed: 1, suppressed: 0 });
  });
});

/**
 * A removed title must stay removed.
 *
 * The catalogue is rebuilt from upstream every six hours. Without a suppression
 * check here, deleting a title is undone by the next refresh under the same
 * dedupe key — and a deletion that silently reverses itself reads as a bug
 * rather than a decision.
 */
describe('DiscoveryStoreService — suppressed titles', () => {
  it('does not re-create a title that was removed', async () => {
    const p = fakePrisma();
    const record = merged('tmdb', { externalIds: { tmdb: '125988' } });
    (p as any).__suppress(record.dedupeKey);

    const result = await new DiscoveryStoreService(p as any).persist([record]);
    expect(result.created).toBe(0);
    expect(result.suppressed).toBe(1);
    expect(p.rows).toEqual([]);
    expect(p.discoveredMedia.create).not.toHaveBeenCalled();
  });

  /*
   * The key a title arrives under moves as providers report better ids, and
   * `findExisting` already matches on alternates for exactly that reason.
   * Checking only the canonical key would let a suppressed title walk straight
   * back in the moment a provider promoted a different id to strongest.
   */
  it('honours a suppression recorded against an alternate key', async () => {
    const p = fakePrisma();
    const record = merged('tmdb', { externalIds: { tmdb: '125988', imdb: 'tt14688458' } });
    const alternate = record.alternateKeys[0] ?? record.dedupeKey;
    (p as any).__suppress(alternate);

    const result = await new DiscoveryStoreService(p as any).persist([record]);
    expect(result.suppressed).toBe(1);
    expect(p.rows).toEqual([]);
  });

  it('still stores everything that is not suppressed', async () => {
    const p = fakePrisma();
    const wanted = merged('tmdb', { title: 'Silo', externalIds: { tmdb: '1' } });
    const unwanted = merged('tmdb', { title: 'Gone', externalIds: { tmdb: '2' } });
    (p as any).__suppress(unwanted.dedupeKey);

    const result = await new DiscoveryStoreService(p as any).persist([wanted, unwanted]);
    expect(result.created).toBe(1);
    expect(result.suppressed).toBe(1);
    expect(p.rows.map((r: any) => r.title)).toEqual(['Silo']);
  });
});
