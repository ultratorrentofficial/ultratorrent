import { DiscoverySyncService } from './discovery-sync.service';
import { DiscoveryProviderRegistry } from './discovery-provider-registry.service';
import type { DiscoveryCapability } from '@ultratorrent/shared';
import type { RawDiscovery, ReleaseDiscoveryProvider } from './discovery-provider';

const raw = (title: string, ids: Record<string, string>, over: Partial<RawDiscovery> = {}): RawDiscovery => ({
  mediaType: 'tv',
  title,
  externalIds: ids as RawDiscovery['externalIds'],
  ...over,
});

function harness(opts: {
  providers?: ReleaseDiscoveryProvider[];
  states?: Array<{ provider: string; enabled: boolean; lastSuccessfulSync: Date | null }>;
} = {}) {
  const marks: Array<{ provider: string; data: any }> = [];
  const prisma = {
    discoveryProviderState: {
      findMany: jest.fn(async () => opts.states ?? []),
      upsert: jest.fn(async ({ where, update }: any) => {
        marks.push({ provider: where.provider, data: update });
        return {};
      }),
    },
  };
  const registry = new DiscoveryProviderRegistry();
  for (const p of opts.providers ?? []) registry.register(p);
  const persisted: any[][] = [];
  const store = {
    persist: jest.fn(async (records: any[]) => {
      persisted.push(records);
      return { created: records.length, updated: 0, failed: 0 };
    }),
  };
  const svc = new DiscoverySyncService(prisma as any, registry, store as any);
  return { svc, prisma, store, marks, persisted };
}

function provider(
  name: string,
  caps: DiscoveryCapability[],
  results: Partial<Record<DiscoveryCapability, RawDiscovery[] | Error>> = {},
): ReleaseDiscoveryProvider {
  const answer = (cap: DiscoveryCapability) => async () => {
    const r = results[cap];
    if (r instanceof Error) throw r;
    return r ?? [];
  };
  return {
    name,
    capabilities: () => caps,
    healthCheck: async () => ({ healthy: true }),
    getUpcomingMovies: answer('upcoming_movies'),
    getUpcomingSeries: answer('upcoming_series'),
    getUpcomingSeasons: answer('upcoming_seasons'),
    getReturningSeries: answer('returning_series'),
  };
}

describe('DiscoverySyncService — when it runs at all', () => {
  /*
   * A fresh install must make no third-party calls. Discovering is cheap for us
   * and not free for the provider.
   */
  it('does nothing when no provider has been enabled', async () => {
    const p = provider('tmdb', ['upcoming_series'], { upcoming_series: [raw('X', { tmdb: '1' })] });
    const { svc, store } = harness({ providers: [p], states: [] });
    await svc.tick();
    expect(store.persist).not.toHaveBeenCalled();
  });

  it('skips a provider whose catalogue is still fresh', async () => {
    const p = provider('tmdb', ['upcoming_series'], { upcoming_series: [raw('X', { tmdb: '1' })] });
    const { svc, store } = harness({
      providers: [p],
      states: [{ provider: 'tmdb', enabled: true, lastSuccessfulSync: new Date() }],
    });
    await svc.tick();
    expect(store.persist).not.toHaveBeenCalled();
  });

  it('syncs a provider that has never synced', async () => {
    const p = provider('tmdb', ['upcoming_series'], { upcoming_series: [raw('X', { tmdb: '1' })] });
    const { svc, store } = harness({
      providers: [p],
      states: [{ provider: 'tmdb', enabled: true, lastSuccessfulSync: null }],
    });
    await svc.tick();
    expect(store.persist).toHaveBeenCalled();
  });

  it('tolerates a provider that is enabled but no longer registered', async () => {
    const { svc } = harness({ providers: [], states: [{ provider: 'gone', enabled: true, lastSuccessfulSync: null }] });
    await expect(svc.tick()).resolves.toBeUndefined();
  });

  /*
   * An unhandled rejection in an @Interval takes the interval down with it, and
   * the sweep then stops forever with no sign that it has.
   */
  it('never throws out of the ticker', async () => {
    const { svc, prisma } = harness();
    prisma.discoveryProviderState.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.tick()).resolves.toBeUndefined();
  });

  it('refuses to run two syncs at once', async () => {
    const p = provider('tmdb', ['upcoming_series'], { upcoming_series: [raw('X', { tmdb: '1' })] });
    const { svc, store } = harness({ providers: [p] });
    const first = svc.syncProviders(['tmdb']);
    const second = await svc.syncProviders(['tmdb']);
    await first;
    expect(second).toEqual([]);
    expect(store.persist).toHaveBeenCalledTimes(1);
  });
});

describe('DiscoverySyncService — what a sync does', () => {
  it('asks a provider only for capabilities it declares', async () => {
    const p = provider('tvmaze', ['upcoming_series']);
    const spy = jest.spyOn(p, 'getUpcomingMovies' as never);
    const { svc } = harness({ providers: [p] });
    await svc.syncProviders(['tvmaze']);
    expect(spy).not.toHaveBeenCalled();
  });

  /*
   * A returning series is also an upcoming season, so one provider legitimately
   * reports the same show through two capabilities.
   */
  it('merges one show reported through two capabilities into a single record', async () => {
    const show = raw('Reacher', { tvmaze: '108978' });
    const p = provider('tvmaze', ['upcoming_seasons', 'returning_series'], {
      upcoming_seasons: [show],
      returning_series: [show],
    });
    const { svc, persisted } = harness({ providers: [p] });
    await svc.syncProviders(['tvmaze']);
    expect(persisted[0]).toHaveLength(1);
    expect(persisted[0][0].title).toBe('Reacher');
  });

  it('records health, counts and capabilities after a good sync', async () => {
    const p = provider('tmdb', ['upcoming_series'], { upcoming_series: [raw('A', { tmdb: '1' })] });
    const { svc, marks } = harness({ providers: [p] });
    const [outcome] = await svc.syncProviders(['tmdb']);

    expect(outcome).toMatchObject({ provider: 'tmdb', discovered: 1, created: 1 });
    const final = marks[marks.length - 1].data;
    expect(final.healthy).toBe(true);
    expect(final.itemsDiscovered).toBe(1);
    expect(final.capabilities).toEqual(['upcoming_series']);
  });
});

describe('DiscoverySyncService — failure', () => {
  /*
   * Emptying a catalogue because a network call failed would read downstream as
   * "nothing is coming out", which is a very different claim from "we could not
   * ask".
   */
  it('marks a provider unhealthy and persists NOTHING when every capability fails', async () => {
    const p = provider('tmdb', ['upcoming_series'], { upcoming_series: new Error('ECONNRESET') });
    const { svc, store, marks } = harness({ providers: [p] });
    const [outcome] = await svc.syncProviders(['tmdb']);

    expect(outcome.error).toBe('ECONNRESET');
    expect(store.persist).toHaveBeenCalledWith([]);
    const final = marks[marks.length - 1].data;
    expect(final.healthy).toBe(false);
    expect(final.lastFailureReason).toBe('ECONNRESET');
    expect(final.lastSuccessfulSync).toBeUndefined();
  });

  it('keeps what one capability returned when another fails, and still flags it', async () => {
    const p = provider('tvmaze', ['upcoming_series', 'returning_series'], {
      upcoming_series: [raw('Survivor', { tvmaze: '1' })],
      returning_series: new Error('timeout'),
    });
    const { svc, persisted, marks } = harness({ providers: [p] });
    const [outcome] = await svc.syncProviders(['tvmaze']);

    expect(persisted[0]).toHaveLength(1);
    expect(outcome.discovered).toBe(1);
    const final = marks[marks.length - 1].data;
    // Partial data is still progress, so the sync counts as successful — but the
    // failure is recorded, or a provider degrading half-way is invisible.
    expect(final.lastSuccessfulSync).toBeInstanceOf(Date);
    expect(final.healthy).toBe(false);
    expect(final.lastFailureReason).toBe('timeout');
  });

  it('does not let a bookkeeping failure fail the sync', async () => {
    const p = provider('tmdb', ['upcoming_series'], { upcoming_series: [raw('A', { tmdb: '1' })] });
    const { svc, prisma } = harness({ providers: [p] });
    prisma.discoveryProviderState.upsert.mockRejectedValue(new Error('write failed'));
    const [outcome] = await svc.syncProviders(['tmdb']);
    expect(outcome.discovered).toBe(1);
  });
});

describe('DiscoverySyncService — merging ACROSS providers', () => {
  /*
   * The regression this pins. Merging each provider's haul in isolation looked
   * equivalent and was not: the title+year join only ever fires between records
   * from DIFFERENT providers, so a per-provider merge makes that rule
   * unreachable. Measured live — 818 rows and ZERO cross-provider joins from data
   * that joins 37 shows when merged together.
   */
  it('joins one show reported by two providers into a single record', async () => {
    const tmdb = provider('tmdb', ['upcoming_series'], {
      upcoming_series: [raw('Silo', { tmdb: '125988' }, { year: 2023 })],
    });
    const tvmaze = provider('tvmaze', ['upcoming_series'], {
      upcoming_series: [raw('Silo', { tvmaze: '58444' }, { year: 2023 })],
    });
    const { svc, persisted } = harness({ providers: [tmdb, tvmaze] });
    await svc.syncProviders(['tmdb', 'tvmaze']);

    expect(persisted).toHaveLength(1); // one write pass, not one per provider
    expect(persisted[0]).toHaveLength(1);
    expect(persisted[0][0].sourceProviders.sort()).toEqual(['tmdb', 'tvmaze']);
  });

  it('credits a joined record to every provider that contributed to it', async () => {
    const tmdb = provider('tmdb', ['upcoming_series'], {
      upcoming_series: [raw('Silo', { tmdb: '1' }, { year: 2023 })],
    });
    const tvmaze = provider('tvmaze', ['upcoming_series'], {
      upcoming_series: [
        raw('Silo', { tvmaze: '2' }, { year: 2023 }),
        raw('Only On TVmaze', { tvmaze: '3' }, { year: 2026 }),
      ],
    });
    const { svc, marks } = harness({ providers: [tmdb, tvmaze] });
    const outcomes = await svc.syncProviders(['tmdb', 'tvmaze']);

    // One shared show + one TVmaze-only show = 2 distinct works.
    expect(outcomes.find((o) => o.provider === 'tmdb')!.discovered).toBe(1);
    expect(outcomes.find((o) => o.provider === 'tvmaze')!.discovered).toBe(2);
    expect(marks.filter((m) => m.data.itemsDiscovered !== undefined).length).toBe(2);
  });

  it('still keeps two same-title works apart when one provider distinguishes them', async () => {
    const tmdb = provider('tmdb', ['upcoming_series'], {
      upcoming_series: [
        raw('The Odyssey', { tmdb: '1368337' }, { year: 2026 }),
        raw('The Odyssey', { tmdb: '1698863' }, { year: 2026 }),
      ],
    });
    const { svc, persisted } = harness({ providers: [tmdb] });
    await svc.syncProviders(['tmdb']);
    expect(persisted[0]).toHaveLength(2);
    expect(persisted[0].every((m: any) => m.identityStatus === 'ambiguous')).toBe(true);
  });
});
