import { WantedSearchReconciler } from '../wanted-search-reconciler.service';

function build(over: { episodeFail?: boolean } = {}) {
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
  const prisma = {
    wantedEpisode: { updateMany: updateMany('wantedEpisode') },
    wantedMovie: { updateMany: updateMany('wantedMovie') },
  };
  return { svc: new WantedSearchReconciler(prisma as any), prisma, rows };
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

    await expect(svc.reconcile()).resolves.toEqual({ episodes: 2, movies: 1 });
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
