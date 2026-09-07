import { DiscoveryRemovalService } from './discovery-removal.service';

/**
 * Removing a discovered title.
 *
 * The tests that matter here are the ones about what is NOT removed. A cascade
 * that deletes too much is not a bug you find in review — it is a bug you find
 * when somebody's library is gone.
 */

const MEDIA = {
  id: 'dm1',
  dedupeKey: 'tmdb:tv:99',
  title: 'Silo',
  year: 2023,
  mediaType: 'tv',
  externalIds: { imdb: 'tt14688458', tmdb: '125988' },
  watchlistItemId: 'wl1',
  _count: { evaluations: 3, releaseDates: 2 },
};

function harness(over: any = {}) {
  const state = {
    deletedRules: [] as string[],
    deletedMedia: [] as string[],
    watchlistUpdates: [] as any[],
    suppressions: [] as any[],
    bulkDeleteCalls: [] as any[],
  };
  const prisma: any = {
    discoveredMedia: {
      findUnique: jest.fn(async () => over.media ?? MEDIA),
      delete: jest.fn(async ({ where }: any) => {
        state.deletedMedia.push(where.id);
        return {};
      }),
    },
    rssRule: {
      findMany: jest.fn(async () => over.rules ?? []),
      delete: jest.fn(async ({ where }: any) => {
        state.deletedRules.push(where.id);
        return {};
      }),
    },
    mediaAcquisitionWatchlistItem: {
      findUnique: jest.fn(async () => over.watchlist ?? { id: 'wl1', title: 'Silo', status: 'active' }),
      update: jest.fn(async (args: any) => {
        state.watchlistUpdates.push(args);
        return {};
      }),
    },
    mediaExternalId: { findMany: jest.fn(async () => over.links ?? []) },
    mediaItem: { findMany: jest.fn(async () => over.items ?? []) },
    discoverySuppression: {
      upsert: jest.fn(async (args: any) => {
        state.suppressions.push(args);
        return {};
      }),
      findUnique: jest.fn(async () => over.suppression ?? null),
      delete: jest.fn(async () => ({})),
    },
  };
  const audit = { record: jest.fn(async () => undefined) } as any;
  const mediaBulk = {
    deleteFiles: jest.fn(async (ids: string[], ctx: any, opts: any) => {
      state.bulkDeleteCalls.push({ ids, opts });
      return { jobId: 'job-1' };
    }),
  } as any;
  return { svc: new DiscoveryRemovalService(prisma, audit, mediaBulk), prisma, audit, mediaBulk, state };
}

describe('removal plan', () => {
  it('separates a generated rule from one a person edited', async () => {
    const { svc } = harness({
      rules: [
        { id: 'r1', name: 'Silo', userModifiedAt: null },
        { id: 'r2', name: 'Silo 4K', userModifiedAt: new Date() },
      ],
    });
    const plan = await svc.plan('dm1');
    expect(plan.monitoring.rule?.id).toBe('r1');
    expect(plan.monitoring.userModifiedRule?.id).toBe('r2');
  });

  /*
   * The load-bearing safety property.
   *
   * Two films genuinely share a title and year, and a library item matched that
   * way and then deleted is gone. Only an external id is proof.
   */
  it('refuses to identify library media without an external id', async () => {
    const { svc, prisma } = harness({ media: { ...MEDIA, externalIds: {} } });
    const plan = await svc.plan('dm1');
    expect(plan.library.unmatchedReason).toBe('no_external_ids');
    expect(plan.library.items).toEqual([]);
    // It must not have gone looking by any other means.
    expect(prisma.mediaExternalId.findMany).not.toHaveBeenCalled();
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it('matches library media through external ids', async () => {
    const { svc } = harness({
      links: [{ itemId: 'mi1' }, { itemId: 'mi2' }, { itemId: 'mi1' }],
      items: [
        { id: 'mi1', title: 'S01E01', path: '/tv/Silo/S01E01.mkv' },
        { id: 'mi2', title: 'S01E02', path: '/tv/Silo/S01E02.mkv' },
      ],
    });
    const plan = await svc.plan('dm1');
    expect(plan.library.items).toHaveLength(2);
    expect(plan.library.unmatchedReason).toBeNull();
  });
});

describe('removal scopes', () => {
  it('catalog scope touches no rule, no watchlist entry and no file', async () => {
    const { svc, state, mediaBulk } = harness({
      rules: [{ id: 'r1', name: 'Silo', userModifiedAt: null }],
      links: [{ itemId: 'mi1' }],
      items: [{ id: 'mi1', title: 'S01E01', path: '/tv/Silo/S01E01.mkv' }],
    });
    const result = await svc.remove('dm1', { scope: 'catalog' });
    expect(state.deletedRules).toEqual([]);
    expect(state.watchlistUpdates).toEqual([]);
    expect(mediaBulk.deleteFiles).not.toHaveBeenCalled();
    expect(result.removed.catalogRow).toBe(true);
  });

  it('monitoring scope deletes the rule and archives the watchlist entry, but no files', async () => {
    const { svc, state, mediaBulk } = harness({
      rules: [{ id: 'r1', name: 'Silo', userModifiedAt: null }],
      links: [{ itemId: 'mi1' }],
      items: [{ id: 'mi1', title: 'S01E01', path: '/tv/Silo/S01E01.mkv' }],
    });
    await svc.remove('dm1', { scope: 'monitoring' });
    expect(state.deletedRules).toEqual(['r1']);
    expect(state.watchlistUpdates[0].data).toEqual({ status: 'archived' });
    expect(mediaBulk.deleteFiles).not.toHaveBeenCalled();
  });

  /*
   * A rule stops being discovery's the moment a person edits it. Deleting it
   * here would discard work the operator did, to tidy up after a template.
   */
  it('never deletes a rule a person edited, and says so', async () => {
    const { svc, state } = harness({
      rules: [{ id: 'r2', name: 'Silo 4K', userModifiedAt: new Date() }],
    });
    const result = await svc.remove('dm1', { scope: 'library' });
    expect(state.deletedRules).toEqual([]);
    expect(result.skipped.join(' ')).toMatch(/edited by hand/);
  });

  it('library scope delegates file removal rather than deleting anything itself', async () => {
    const { svc, mediaBulk } = harness({
      links: [{ itemId: 'mi1' }, { itemId: 'mi2' }],
      items: [
        { id: 'mi1', title: 'S01E01', path: '/tv/Silo/S01E01.mkv' },
        { id: 'mi2', title: 'S01E02', path: '/tv/Silo/S01E02.mkv' },
      ],
    });
    const result = await svc.remove('dm1', { scope: 'library', torrentAction: 'stop_and_delete' });
    expect(mediaBulk.deleteFiles).toHaveBeenCalledTimes(1);
    expect(mediaBulk.deleteFiles.mock.calls[0][0]).toEqual(['mi1', 'mi2']);
    expect(mediaBulk.deleteFiles.mock.calls[0][2]).toEqual({ torrentAction: 'stop_and_delete' });
    expect(result.removed.libraryItems).toBe(2);
  });

  it('deletes no files at library scope when identity is unproven', async () => {
    const { svc, mediaBulk } = harness({ media: { ...MEDIA, externalIds: {} } });
    const result = await svc.remove('dm1', { scope: 'library', torrentAction: 'stop_and_delete' });
    expect(mediaBulk.deleteFiles).not.toHaveBeenCalled();
    expect(result.skipped.join(' ')).toMatch(/no external id/);
  });

  /*
   * The audit row is written BEFORE anything is destroyed. Written afterwards, a
   * crash mid-delete takes the only account of what was attempted with it.
   */
  it('audits the request before acting on it', async () => {
    const order: string[] = [];
    const { svc, audit, mediaBulk } = harness({
      links: [{ itemId: 'mi1' }],
      items: [{ id: 'mi1', title: 'S01E01', path: '/x.mkv' }],
    });
    audit.record.mockImplementation(async () => {
      order.push('audit');
    });
    mediaBulk.deleteFiles.mockImplementation(async () => {
      order.push('delete');
      return { jobId: 'j' };
    });
    await svc.remove('dm1', { scope: 'library' });
    expect(order).toEqual(['audit', 'delete']);
  });
});

describe('suppression', () => {
  /*
   * Without this the catalogue rebuilds the row within six hours and the
   * deletion reads as a bug rather than a decision.
   */
  it('records the identity so the next sync cannot resurrect it', async () => {
    const { svc, state } = harness();
    await svc.remove('dm1', { scope: 'catalog' });
    expect(state.suppressions[0].where).toEqual({ dedupeKey: 'tmdb:tv:99' });
    expect(state.suppressions[0].create.reason).toBe('manual');
    expect(state.deletedMedia).toEqual(['dm1']);
  });

  /*
   * A person's deletion outranks an automatic retraction reaching the same
   * conclusion later — otherwise a sweep quietly downgrades a decision somebody
   * made, and un-suppressing behaves differently than they expect.
   */
  it('does not let an automatic retraction downgrade a manual removal', async () => {
    const { svc, state } = harness();
    await svc.suppress('dm1', 'retracted');
    expect(state.suppressions[0].update).toEqual({});
    await svc.suppress('dm1', 'manual', 'user-1');
    expect(state.suppressions[1].update).toEqual({ reason: 'manual', suppressedBy: 'user-1' });
  });
});
