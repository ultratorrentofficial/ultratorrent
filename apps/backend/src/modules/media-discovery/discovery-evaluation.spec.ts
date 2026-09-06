import { DiscoveryEvaluationService } from './discovery-evaluation.service';

const NOW = new Date('2026-09-06T12:00:00Z');
const soon = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

const TEMPLATE: any = {
  id: 'dt1',
  name: 'Premium TV',
  enabled: true,
  mediaType: 'any',
  upcomingWindowDays: 90,
  regions: [],
  languages: [],
  networks: [],
  streamingServices: [],
  studios: [],
  releaseTypes: [],
  autoMonitorCategories: ['Sci-Fi'],
  notifyOnlyCategories: ['Drama'],
  ignoreCategories: ['Reality'],
  blockedFromAutoCategories: [],
  categoryMatchMode: 'ANY',
  minimumConfidence: 0.8,
  autoAddLimitPerDay: 10,
  autoAddLimitPerWeek: 30,
  storageProfileId: null,
  acquisitionTemplateId: null,
  pathTemplate: null,
  createIntakeDirectory: false,
};

const row = (id: string, over: any = {}) => ({
  id,
  mediaType: 'tv',
  title: `Show ${id}`,
  year: 2026,
  genres: ['Sci-Fi'],
  originalLanguage: 'en',
  countries: ['US'],
  network: null,
  streamingService: null,
  studio: null,
  popularity: 90,
  rating: 8,
  voteCount: 500,
  identityStatus: 'resolved',
  confidence: 1,
  externalIds: { imdb: `tt${id}` },
  releaseDates: [{ releaseType: 'series_premiere', date: soon(10), region: 'US' }],
  ...over,
});

function harness(opts: { rows?: any[]; remaining?: number; watchlistFails?: boolean; ruleFails?: boolean; ruleReason?: string } = {}) {
  const evaluations: any[] = [];
  const stamps: any[] = [];
  const prisma: any = {
    discoveryTemplate: { findMany: jest.fn(async () => [TEMPLATE]) },
    discoveredMedia: {
      findMany: jest.fn(async () => opts.rows ?? [row('a')]),
      update: jest.fn(async ({ data }: any) => {
        stamps.push(data);
        return {};
      }),
    },
    discoveryEvaluation: {
      create: jest.fn(async ({ data }: any) => {
        evaluations.push(data);
        return {};
      }),
    },
    storageProfile: { findUnique: jest.fn(async () => null) },
    acquisitionRuleTemplate: { findUnique: jest.fn(async () => null) },
  };
  const budget = {
    state: jest.fn(async () => ({
      perDay: 10, perWeek: 30, usedToday: 0, usedThisWeek: 0,
      remainingToday: opts.remaining ?? 10,
      remainingThisWeek: opts.remaining ?? 30,
      exhausted: (opts.remaining ?? 10) <= 0,
    })),
  };
  const watchlist = {
    linkOrCreate: jest.fn(async () => {
      if (opts.watchlistFails) throw new Error('watchlist exploded');
      return { watchlistItemId: 'w1', outcome: 'created' };
    }),
  };
  const rules = {
    generate: jest.fn(async () => {
      if (opts.ruleFails) throw new Error('rule exploded');
      return { ruleId: 'r1', outcome: 'created', ...(opts.ruleReason ? { reason: opts.ruleReason } : {}) };
    }),
  };
  const intake = { provision: jest.fn(async () => ({ ok: true, detail: 'created', path: '/x' })) };

  return {
    svc: new DiscoveryEvaluationService(prisma, budget as any, watchlist as any, rules as any, intake as any),
    prisma, budget, watchlist, rules, intake, evaluations, stamps,
  };
}

describe('running a template', () => {
  it('auto-monitors a qualifying title: watchlist, rule, evaluation, stamp', async () => {
    const h = harness();
    const [out] = await h.svc.runAll(NOW);

    expect(out).toMatchObject({ templateId: 'dt1', examined: 1, monitored: 1, failed: 0 });
    expect(h.watchlist.linkOrCreate).toHaveBeenCalled();
    expect(h.rules.generate).toHaveBeenCalled();
    expect(h.evaluations[0]).toMatchObject({ decision: 'auto_monitor', watchlistItemId: 'w1', rssRuleId: 'r1' });
    expect(h.stamps[0]).toMatchObject({ discoveryStatus: 'monitored', decision: 'auto_monitor' });
  });

  it('records a notify without touching the watchlist or the rules', async () => {
    const h = harness({ rows: [row('a', { genres: ['Drama'] })] });
    const [out] = await h.svc.runAll(NOW);

    expect(out.decisions.notify).toBe(1);
    expect(h.watchlist.linkOrCreate).not.toHaveBeenCalled();
    expect(h.rules.generate).not.toHaveBeenCalled();
    expect(h.stamps[0].discoveryStatus).toBe('notified');
  });

  it('records an ignore', async () => {
    const h = harness({ rows: [row('a', { genres: ['Reality'] })] });
    await h.svc.runAll(NOW);
    expect(h.evaluations[0].decision).toBe('ignore');
    expect(h.stamps[0].discoveryStatus).toBe('ignored');
  });

  /*
   * Skipping the write starves the sweep. The "already decided" filter is
   * `evaluations: { none: … }`, so a title with no row is re-fetched every tick
   * and consumes the page budget forever — measured live, a second pass
   * re-examined the same 500 rows, 407 of them not applicable.
   *
   * So the evaluation is recorded, and the TITLE is left alone: its status stays
   * `new` and it never appears in the inbox as though this template judged it.
   */
  it('records the evaluation but does not touch a title it has no opinion about', async () => {
    const h = harness({ rows: [row('a', { releaseDates: [] })] });
    const [out] = await h.svc.runAll(NOW);

    expect(out.decisions.not_applicable).toBe(1);
    expect(h.evaluations).toHaveLength(1);
    expect(h.stamps).toEqual([]);
  });

  it('makes progress: a title evaluated once is not re-fetched', async () => {
    const h = harness();
    await h.svc.runAll(NOW);
    // Every examined title now has a row for this template, so the same filter
    // excludes it next time.
    expect(h.evaluations).toHaveLength(1);
    expect(h.prisma.discoveredMedia.findMany.mock.calls[0][0].where).toEqual({
      evaluations: { none: { templateId: 'dt1' } },
    });
  });

  it('only evaluates titles this template has not decided about', async () => {
    const h = harness();
    await h.svc.runAll(NOW);
    expect(h.prisma.discoveredMedia.findMany.mock.calls[0][0].where).toEqual({
      evaluations: { none: { templateId: 'dt1' } },
    });
  });

  it('does not evaluate a disabled template', async () => {
    const h = harness();
    await h.svc.runAll(NOW);
    expect(h.prisma.discoveryTemplate.findMany).toHaveBeenCalledWith({ where: { enabled: true } });
  });
});

describe('failure never disappears', () => {
  /*
   * The watchlist entry is what causes acquisition. Without it there is no
   * monitoring, so the title belongs in review however confidently it was decided.
   */
  it('holds a title for review when the watchlist entry could not be created', async () => {
    const h = harness({ watchlistFails: true });
    const [out] = await h.svc.runAll(NOW);

    expect(out.monitored).toBe(0);
    expect(out.failed).toBe(1);
    expect(h.stamps[0].discoveryStatus).toBe('needs_review');
    expect(h.evaluations[0].failureReason).toMatch(/watchlist exploded/);
  });

  /*
   * A rule carries preferences; the entry causes acquisition. Rolling back a
   * correct entry because a convenience failed would be losing the useful half.
   */
  it('keeps a monitored title when rule generation fails, and says so', async () => {
    const h = harness({ ruleFails: true });
    const [out] = await h.svc.runAll(NOW);

    expect(out.monitored).toBe(1);
    expect(h.stamps[0].discoveryStatus).toBe('monitored');
    expect(h.evaluations[0].failureReason).toMatch(/Rule generation failed/);
  });

  it('surfaces a skipped rule reason rather than swallowing it', async () => {
    const h = harness({ ruleReason: 'A rule named "Show a (2026)" already exists' });
    await h.svc.runAll(NOW);
    expect(h.evaluations[0].failureReason).toMatch(/already exists/);
  });
});

describe('the budget', () => {
  /*
   * Read once, spent locally: a single pass must not out-race its own cap by
   * re-reading a count that has not been written yet.
   */
  it('stops auto-monitoring once the allowance runs out mid-pass', async () => {
    const h = harness({ rows: [row('a'), row('b'), row('c')], remaining: 2 });
    const [out] = await h.svc.runAll(NOW);

    expect(out.monitored).toBe(2);
    expect(out.decisions.needs_review).toBe(1);
    expect(h.evaluations[2].reason).toMatch(/Automatic-add threshold reached/);
  });

  it('reads the budget once per template, not once per title', async () => {
    const h = harness({ rows: [row('a'), row('b'), row('c')] });
    await h.svc.runAll(NOW);
    // Three titles, one template, one budget read — re-reading per title would
    // return a count that has not been written yet and let the pass overshoot.
    expect(h.budget.state).toHaveBeenCalledTimes(1);
  });

  it('does not spend budget on a title whose monitoring failed', async () => {
    const h = harness({ rows: [row('a'), row('b')], remaining: 1, watchlistFails: true });
    const [out] = await h.svc.runAll(NOW);
    // Neither succeeded, so the second was still evaluated with budget available.
    expect(out.failed).toBe(2);
    expect(out.decisions.needs_review).toBe(0);
  });
});

describe('the ticker', () => {
  it('never throws', async () => {
    const h = harness();
    h.prisma.discoveryTemplate.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(h.svc.tick()).resolves.toBeUndefined();
  });

  it('refuses to run two passes at once', async () => {
    const h = harness();
    const first = h.svc.runAll(NOW);
    const second = await h.svc.runAll(NOW);
    await first;
    expect(second).toEqual([]);
  });
});
