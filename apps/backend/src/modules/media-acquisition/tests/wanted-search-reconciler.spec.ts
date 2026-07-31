import { WantedSearchReconciler } from '../wanted-search-reconciler.service';

function build(over: { episodeFail?: boolean; stuck?: any[]; parked?: any[] } = {}) {
  const rows = {
    wantedEpisode: [
      { id: 'e1', searchStatus: 'searching' }, // stranded by a restart
      { id: 'e2', searchStatus: 'searching' },
      { id: 'e3', searchStatus: 'no_results' }, // must be left alone
      { id: 'e4', searchStatus: 'grabbed' }, // must be left alone
      { id: 'e5', searchStatus: 'idle' },
    ],
    wantedMovie: [{ id: 'm1', searchStatus: 'searching' }],
  };
  const updateMany = (table: 'wantedEpisode' | 'wantedMovie') =>
    jest.fn(({ where, data }: any) => {
      if (over.episodeFail && table === 'wantedEpisode') return Promise.reject(new Error('db down'));
      const hit = rows[table].filter((r) => r.searchStatus === where.searchStatus);
      hit.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: hit.length });
    });
  // Dead-grab release: rows stamped `grabbed` whose torrent the PARKING system
  // has already probed repeatedly and found seederless.
  const stuck = over.stuck ?? [];
  const parked = over.parked ?? [];
  const prisma = {
    wantedEpisode: {
      updateMany: jest.fn((args: any) => {
        if (args.where?.id) {
          const row = stuck.find((r: any) => r.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return Promise.resolve({ count: row ? 1 : 0 });
        }
        return updateMany('wantedEpisode')(args);
      }),
      findMany: jest.fn(async () => stuck.filter((r: any) => r.searchStatus === 'grabbed' && r.torrentHash)),
    },
    wantedMovie: { updateMany: updateMany('wantedMovie') },
    parkedTorrent: {
      findMany: jest.fn(async ({ where }: any) =>
        parked.filter((p: any) =>
          where.hash.in.includes(p.hash) && p.probeCount >= where.probeCount.gte && p.lastSeeders === 0)),
    },
  };
  return { svc: new WantedSearchReconciler(prisma as any), prisma, rows, stuck, parked };
}

describe('WantedSearchReconciler', () => {
  it('releases rows stranded mid-search, so the sweep can pick them up again', async () => {
    const { svc, rows } = build();

    const result = await svc.onModuleInit().then(() => svc.reconcile());

    expect(rows.wantedEpisode.filter((r) => r.searchStatus === 'searching')).toHaveLength(0);
    expect(rows.wantedEpisode.find((r) => r.id === 'e1')!.searchStatus).toBe('idle');
    expect(result.episodes + result.movies).toBe(0); // already released by onModuleInit
  });

  it('resets only `searching` — never a real outcome', async () => {
    const { svc, rows } = build();

    await svc.reconcile();

    expect(rows.wantedEpisode.find((r) => r.id === 'e3')!.searchStatus).toBe('no_results');
    expect(rows.wantedEpisode.find((r) => r.id === 'e4')!.searchStatus).toBe('grabbed');
  });

  it('reports what it released', async () => {
    const { svc } = build();

    // `deadGrabs` counts episodes released because their grabbed release proved dead.
    await expect(svc.reconcile()).resolves.toEqual({ episodes: 2, movies: 1, deadGrabs: 0 });
  });

  it('reconciles movies too — the same column, the same trap', async () => {
    const { svc, rows } = build();

    await svc.reconcile();

    expect(rows.wantedMovie[0].searchStatus).toBe('idle');
  });

  it('never blocks boot when the database is unhappy', async () => {
    const { svc } = build({ episodeFail: true });

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('WantedSearchReconciler — dead grabs', () => {
  const grab = (over: Record<string, unknown> = {}): Record<string, any> => ({
    id: 'w1', searchStatus: 'grabbed', status: 'missing', torrentHash: 'h1',
    releaseTitle: 'All American S03E02 720p HEVC x265-MeGusta', deadReleases: [],
    intakeRuleId: null, ...over,
  });
  const dead = (over: Record<string, unknown> = {}) =>
    ({ hash: 'h1', probeCount: 21, lastSeeders: 0, ...over });

  it('puts an episode back in the search pool when its release is dead', async () => {
    /*
     * The leak this closes. The sweep selects only idle/no_results/failed, so a
     * row that reaches `grabbed` is never revisited — and when that torrent is
     * parked seederless it never completes either. Measured live: 369 episodes
     * stamped grabbed but still missing, 357 of them over a week old.
     */
    const stuck = [grab()];
    const { svc } = build({ stuck, parked: [dead()] });
    await svc.reconcile();

    expect(stuck[0].searchStatus).toBe('failed');
  });

  it('REMEMBERS the dead release, so the retry does not re-pick it', async () => {
    // Without this the selector ranks the same list, re-grabs the same corpse and
    // re-parks it every sweep — motion without progress.
    const stuck = [grab()];
    const { svc } = build({ stuck, parked: [dead()] });
    await svc.reconcile();

    expect(stuck[0].deadReleases).toContain('All American S03E02 720p HEVC x265-MeGusta');
  });

  it('clears the torrent trace so intake cannot match the abandoned download', async () => {
    const stuck = [grab({ intakeRuleId: 'rule-1' })];
    const { svc } = build({ stuck, parked: [dead()] });
    await svc.reconcile();

    expect(stuck[0].torrentHash).toBeNull();
    expect(stuck[0].intakeRuleId).toBeNull();
  });

  it('leaves a torrent that is merely SLOW alone', async () => {
    /*
     * Why the parking record decides and not elapsed time: a torrent probed only
     * once, or one still reporting seeders, may simply be slow. An age-based rule
     * cannot tell those apart and would reset a download about to finish.
     */
    const stuck = [grab()];
    const { svc } = build({ stuck, parked: [dead({ probeCount: 1 })] });
    await svc.reconcile();
    expect(stuck[0].searchStatus).toBe('grabbed');

    const stuck2 = [grab()];
    const b2 = build({ stuck: stuck2, parked: [dead({ lastSeeders: 4 })] });
    await b2.svc.reconcile();
    expect(stuck2[0].searchStatus).toBe('grabbed');
  });

  it('leaves a grab whose torrent is not parked at all', async () => {
    const stuck = [grab()];
    const { svc } = build({ stuck, parked: [] });
    await svc.reconcile();
    expect(stuck[0].searchStatus).toBe('grabbed');
  });

  it('does not record the same dead release twice', async () => {
    const stuck = [grab({ deadReleases: ['All American S03E02 720p HEVC x265-MeGusta'] })];
    const { svc } = build({ stuck, parked: [dead()] });
    await svc.reconcile();
    expect(stuck[0].deadReleases).toHaveLength(1);
  });
});
