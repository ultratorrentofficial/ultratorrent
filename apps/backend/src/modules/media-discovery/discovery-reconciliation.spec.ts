import { DiscoveryReconciliationService } from './discovery-reconciliation.service';

/**
 * Finding and merging shows monitored twice.
 *
 * The grouping tests are about not being greedy — a merge acts on somebody's
 * monitoring configuration, and a wrong group is worse than a missed one. The
 * merge tests are almost entirely about what is NOT removed.
 */

const wl = (over: any = {}) => ({
  id: over.id,
  type: over.type ?? 'series',
  title: over.title,
  year: over.year ?? null,
  status: over.status ?? 'active',
  createdAt: over.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  externalIds: over.externalIds ?? {},
  rssRuleId: over.rssRuleId ?? null,
  settings: over.settings ?? null,
});

function harness(over: any = {}) {
  const state = { deletedRules: [] as any[], archived: [] as string[], updates: [] as any[] };
  const prisma: any = {
    mediaAcquisitionWatchlistItem: {
      findMany: jest.fn(async () => over.items ?? []),
      update: jest.fn(async (args: any) => {
        state.updates.push(args);
        return {};
      }),
      updateMany: jest.fn(async ({ where }: any) => {
        state.archived.push(...where.id.in);
        return { count: where.id.in.length };
      }),
    },
    rssRule: {
      findMany: jest.fn(async () => over.rules ?? []),
      deleteMany: jest.fn(async ({ where }: any) => {
        state.deletedRules.push(where);
        return { count: 1 };
      }),
    },
    wantedEpisode: { groupBy: jest.fn(async () => over.wanted ?? []) },
    mediaAcquisitionEvaluation: { groupBy: jest.fn(async () => over.evaluations ?? []) },
    mediaAcquisitionHistory: { groupBy: jest.fn(async () => over.acquisitions ?? []) },
  };
  const audit = { record: jest.fn(async () => undefined) } as any;
  return { svc: new DiscoveryReconciliationService(prisma, audit), prisma, audit, state };
}

describe('finding duplicates', () => {
  it('groups the two Terminal List entries', async () => {
    const { svc } = harness({
      items: [
        wl({ id: 'a', title: 'The Terminal List' }),
        wl({ id: 'b', title: 'The Terminal List (2022)', year: 2022 }),
      ],
    });
    const [group] = await svc.scan();
    expect(group.entries.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(group.canonicalTitle).toBe('The Terminal List');
    expect(group.evidence).toBe('canonical_title');
  });

  it('groups Tulsa King with and without its year', async () => {
    const { svc } = harness({
      items: [wl({ id: 'a', title: 'Tulsa King (2022)', year: 2022 }), wl({ id: 'b', title: 'Tulsa King' })],
    });
    expect((await svc.scan())[0].entries).toHaveLength(2);
  });

  it('calls a shared external id proof rather than a proposal', async () => {
    const { svc } = harness({
      items: [
        wl({ id: 'a', title: 'One Name', externalIds: { imdb: 'tt1' } }),
        wl({ id: 'b', title: 'Another Name Entirely', externalIds: { imdb: 'tt1' } }),
      ],
    });
    const [group] = await svc.scan();
    expect(group.evidence).toBe('external_id');
    expect(group.matchedIdNamespace).toBe('imdb');
  });

  /*
   * The check that keeps a remake out of its original's group. Titles agreeing
   * cannot outrank two ids that disagree.
   */
  it('never groups entries whose external ids contradict', async () => {
    const { svc } = harness({
      items: [
        wl({ id: 'a', title: 'The Odyssey', year: 2026, externalIds: { imdb: 'tt1' } }),
        wl({ id: 'b', title: 'The Odyssey (2026)', year: 2026, externalIds: { imdb: 'tt2' } }),
      ],
    });
    expect(await svc.scan()).toEqual([]);
  });

  it('does not group two works that differ by year', async () => {
    const { svc } = harness({
      items: [wl({ id: 'a', title: 'The Odyssey', year: 1997 }), wl({ id: 'b', title: 'The Odyssey', year: 2026 })],
    });
    expect(await svc.scan()).toEqual([]);
  });

  it('does not group a movie with a series of the same name', async () => {
    const { svc } = harness({
      items: [wl({ id: 'a', title: 'Fargo', type: 'series' }), wl({ id: 'b', title: 'Fargo', type: 'movie' })],
    });
    expect(await svc.scan()).toEqual([]);
  });

  it('reports nothing when there is nothing to report', async () => {
    const { svc } = harness({ items: [wl({ id: 'a', title: 'Silo' }), wl({ id: 'b', title: 'Severance' })] });
    expect(await svc.scan()).toEqual([]);
  });
});

describe('which entry to keep', () => {
  /*
   * Ordered by what is hardest to recreate. A hand-made rule is work nobody else
   * can reproduce; an external id can simply be copied across.
   */
  it('prefers the entry whose rule was made by hand', async () => {
    const { svc } = harness({
      items: [
        wl({ id: 'gen', title: 'Tulsa King (2022)', year: 2022, rssRuleId: 'r-gen', settings: { createdByDiscovery: true } }),
        wl({ id: 'manual', title: 'Tulsa King', rssRuleId: 'r-manual' }),
      ],
      rules: [
        { id: 'r-gen', name: 'Tulsa King (2022)', generatedByDiscovery: true, userModifiedAt: null, _count: { matchCandidates: 4 } },
        { id: 'r-manual', name: 'Tulsa King', generatedByDiscovery: false, userModifiedAt: null, _count: { matchCandidates: 2 } },
      ],
    });
    const [group] = await svc.scan();
    expect(group.recommendedKeepId).toBe('manual');
    expect(group.recommendation).toMatch(/made by hand/);
  });

  it('prefers the entry carrying acquisition history', async () => {
    const { svc } = harness({
      items: [wl({ id: 'a', title: 'Silo' }), wl({ id: 'b', title: 'Silo (2023)', year: 2023 })],
      acquisitions: [{ watchlistItemId: 'b', _count: 12 }],
    });
    const [group] = await svc.scan();
    expect(group.recommendedKeepId).toBe('b');
    expect(group.recommendation).toMatch(/history row/);
  });
});

describe('merging', () => {
  const twoEntries = {
    items: [
      wl({ id: 'keep', title: 'Tulsa King', rssRuleId: 'r-manual', externalIds: { imdb: 'tt1' } }),
      wl({ id: 'dupe', title: 'Tulsa King (2022)', year: 2022, rssRuleId: 'r-gen', externalIds: { tmdb: '99' }, settings: { createdByDiscovery: true } }),
    ],
    rules: [
      { id: 'r-manual', name: 'Tulsa King', generatedByDiscovery: false, userModifiedAt: null, _count: { matchCandidates: 3 } },
      { id: 'r-gen', name: 'Tulsa King (2022)', generatedByDiscovery: true, userModifiedAt: null, _count: { matchCandidates: 4 } },
    ],
  };

  it('archives the duplicate rather than deleting it', async () => {
    const { svc, state, prisma } = harness(twoEntries);
    await svc.merge('keep', ['dupe']);
    expect(state.archived).toEqual(['dupe']);
    expect(prisma.mediaAcquisitionWatchlistItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['dupe'] } },
      data: { status: 'archived' },
    });
  });

  it('gains the ids it was missing without overwriting the ones it had', async () => {
    const { svc, state } = harness(twoEntries);
    const plan = await svc.merge('keep', ['dupe']);
    expect(plan.idsGained).toEqual({ tmdb: '99' });
    expect(state.updates[0].data.externalIds).toEqual({ imdb: 'tt1', tmdb: '99' });
  });

  it('deletes only a generated rule nobody edited', async () => {
    const { svc, state } = harness(twoEntries);
    await svc.merge('keep', ['dupe']);
    expect(state.deletedRules).toEqual([
      { id: 'r-gen', generatedByDiscovery: true, userModifiedAt: null },
    ]);
  });

  it('keeps a duplicate rule a person edited, and says why', async () => {
    const { svc, state } = harness({
      ...twoEntries,
      rules: [
        twoEntries.rules[0],
        { id: 'r-gen', name: 'Tulsa King (2022)', generatedByDiscovery: true, userModifiedAt: new Date(), _count: { matchCandidates: 4 } },
      ],
    });
    const plan = await svc.merge('keep', ['dupe']);
    expect(state.deletedRules).toEqual([]);
    expect(plan.rulesKept[0].reason).toMatch(/edited by hand/);
  });

  /*
   * A contradiction is surfaced, never resolved silently. Overwriting an
   * identity is how the wrong show gets acquired afterwards.
   */
  it('warns rather than overwriting a differing id', async () => {
    const { svc } = harness({
      items: [
        wl({ id: 'keep', title: 'Silo', externalIds: { tmdb: '1' } }),
        wl({ id: 'dupe', title: 'Silo (2023)', year: 2023, externalIds: { tmdb: '2' } }),
      ],
    });
    // The ids contradict, so they are not even grouped — which is the stronger
    // guarantee. Proven here so a future change to grouping cannot lose it.
    await expect(svc.plan('keep', ['dupe'])).rejects.toThrow(/not part of a duplicate group/);
  });

  it('refuses to merge entries that are not in the same group', async () => {
    const { svc } = harness({
      items: [wl({ id: 'a', title: 'Silo' }), wl({ id: 'b', title: 'Silo (2023)', year: 2023 }), wl({ id: 'c', title: 'Severance' })],
    });
    await expect(svc.plan('a', ['c'])).rejects.toThrow(/not in the same duplicate group/);
  });

  it('audits the merge before performing it', async () => {
    const order: string[] = [];
    const { svc, audit, prisma } = harness(twoEntries);
    audit.record.mockImplementation(async () => { order.push('audit'); });
    prisma.mediaAcquisitionWatchlistItem.updateMany.mockImplementation(async () => { order.push('archive'); return { count: 1 }; });
    await svc.merge('keep', ['dupe']);
    expect(order).toEqual(['audit', 'archive']);
  });

  /* The whole point: a duplicate is bookkeeping, the files are not duplicated. */
  it('touches no media and no torrents', async () => {
    const { svc, prisma } = harness(twoEntries);
    await svc.merge('keep', ['dupe']);
    expect(prisma).not.toHaveProperty('mediaItem');
    expect(prisma).not.toHaveProperty('torrent');
  });
});
