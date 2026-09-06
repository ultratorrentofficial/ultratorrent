import { DiscoveryBudgetService } from './discovery-budget.service';

const NOW = new Date('2026-09-06T12:00:00Z');
const LIMITS = { autoAddLimitPerDay: 10, autoAddLimitPerWeek: 30 };

/**
 * A stub that answers `count` from a list of timestamped additions, applying the
 * same `where` the service builds — so the window arithmetic is really exercised
 * rather than mocked away.
 */
function harness(additions: Array<{ at: Date; acted?: boolean; templateId?: string }>) {
  const rows = additions.map((a) => ({
    at: a.at,
    acted: a.acted ?? true,
    templateId: a.templateId ?? 'dt1',
  }));
  const prisma = {
    discoveryEvaluation: {
      count: jest.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            r.templateId === where.templateId &&
            r.at >= where.createdAt.gte &&
            // `watchlistItemId: { not: null }` — only additions that happened.
            (where.watchlistItemId?.not === null ? r.acted : true),
        ).length,
      ),
    },
  };
  return { svc: new DiscoveryBudgetService(prisma as any), prisma };
}

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe('a fresh template', () => {
  it('has its whole allowance', async () => {
    const { svc } = harness([]);
    const s = await svc.state('dt1', LIMITS, NOW);
    expect(s).toMatchObject({
      usedToday: 0,
      usedThisWeek: 0,
      remainingToday: 10,
      remainingThisWeek: 30,
      exhausted: false,
    });
    expect(s.reason).toBeUndefined();
  });
});

describe('the daily limit', () => {
  it('counts additions inside the last 24 hours', async () => {
    const { svc } = harness([hoursAgo(1), hoursAgo(5), hoursAgo(23)].map((at) => ({ at })));
    const s = await svc.state('dt1', LIMITS, NOW);
    expect(s.usedToday).toBe(3);
    expect(s.remainingToday).toBe(7);
  });

  it('exhausts at the limit and names which one bit', async () => {
    const { svc } = harness(Array.from({ length: 10 }, (_, i) => ({ at: hoursAgo(i + 1) })));
    const s = await svc.state('dt1', LIMITS, NOW);
    expect(s.exhausted).toBe(true);
    expect(s.reason).toMatch(/10 of 10 in the last 24 hours/);
  });

  it('is not exhausted one short of the limit', async () => {
    const { svc } = harness(Array.from({ length: 9 }, (_, i) => ({ at: hoursAgo(i + 1) })));
    expect((await svc.state('dt1', LIMITS, NOW)).exhausted).toBe(false);
  });

  /*
   * The reason for a rolling window. A calendar boundary lets twenty additions
   * land in two minutes across midnight, which is exactly the burst the limit
   * exists to prevent.
   */
  it('does not reset at midnight — additions 23 hours old still count', async () => {
    const { svc } = harness(Array.from({ length: 10 }, () => ({ at: hoursAgo(23) })));
    expect((await svc.state('dt1', LIMITS, NOW)).exhausted).toBe(true);
  });

  it('lets an addition age out of the daily window', async () => {
    const { svc } = harness(Array.from({ length: 10 }, () => ({ at: hoursAgo(25) })));
    const s = await svc.state('dt1', LIMITS, NOW);
    expect(s.usedToday).toBe(0);
    expect(s.usedThisWeek).toBe(10);
    expect(s.exhausted).toBe(false);
  });
});

describe('the weekly limit', () => {
  it('bites even when the day is clear', async () => {
    const { svc } = harness(Array.from({ length: 30 }, (_, i) => ({ at: daysAgo(2 + (i % 4)) })));
    const s = await svc.state('dt1', LIMITS, NOW);
    expect(s.usedToday).toBe(0);
    expect(s.usedThisWeek).toBe(30);
    expect(s.exhausted).toBe(true);
    expect(s.reason).toMatch(/30 of 30 in the last 7 days/);
  });

  it('lets additions age out of the weekly window', async () => {
    const { svc } = harness(Array.from({ length: 30 }, () => ({ at: daysAgo(8) })));
    expect((await svc.state('dt1', LIMITS, NOW)).exhausted).toBe(false);
  });

  it('reports the daily reason first when both are exhausted', async () => {
    const { svc } = harness(Array.from({ length: 30 }, () => ({ at: hoursAgo(2) })));
    expect((await svc.state('dt1', LIMITS, NOW)).reason).toMatch(/24 hours/);
  });
});

describe('what counts as an addition', () => {
  /*
   * A decision of auto_monitor whose rule generation then failed produced no
   * monitoring. Spending budget on it would let a run of failures silently
   * exhaust the allowance and hold back the titles that could have succeeded.
   */
  it('ignores decisions that never became monitoring', async () => {
    const { svc } = harness([
      ...Array.from({ length: 9 }, () => ({ at: hoursAgo(1), acted: false })),
      { at: hoursAgo(1), acted: true },
    ]);
    const s = await svc.state('dt1', LIMITS, NOW);
    expect(s.usedToday).toBe(1);
    expect(s.exhausted).toBe(false);
  });

  it('asks the database only for additions that happened', async () => {
    const { svc, prisma } = harness([]);
    await svc.state('dt1', LIMITS, NOW);
    expect(prisma.discoveryEvaluation.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          decision: 'auto_monitor',
          watchlistItemId: { not: null },
        }),
      }),
    );
  });

  it('counts each template separately', async () => {
    const { svc } = harness([
      ...Array.from({ length: 10 }, () => ({ at: hoursAgo(1), templateId: 'other' })),
      { at: hoursAgo(1), templateId: 'dt1' },
    ]);
    expect((await svc.state('dt1', LIMITS, NOW)).usedToday).toBe(1);
  });
});

describe('a limit of zero', () => {
  /*
   * The literal reading, and the safe one: somebody who typed 0 expecting "no
   * cap" gets a template that adds nothing and notices immediately, where the
   * opposite mistake adds everything and is noticed afterwards.
   */
  it('means no automatic additions at all', async () => {
    const { svc } = harness([]);
    const s = await svc.state('dt1', { autoAddLimitPerDay: 0, autoAddLimitPerWeek: 0 }, NOW);
    expect(s.exhausted).toBe(true);
    expect(s.remainingToday).toBe(0);
  });
});

describe('what the caller does with it', () => {
  /*
   * The evaluator takes `autoAddBudgetExhausted` and turns it into
   * `needs_review` — held, never dropped. This asserts the two halves speak the
   * same language.
   */
  it('produces the flag the policy evaluator consumes', async () => {
    const { svc } = harness(Array.from({ length: 10 }, () => ({ at: hoursAgo(1) })));
    const s = await svc.state('dt1', LIMITS, NOW);

    const { evaluateDiscovery } = await import('./discovery-policy');
    const verdict = evaluateDiscovery(
      {
        mediaType: 'tv',
        title: 'Over Budget',
        genres: ['Sci-Fi'],
        identityStatus: 'resolved',
        confidence: 1,
        releaseDates: [{ releaseType: 'series_premiere', date: '2026-09-20', region: 'US' }],
      },
      {
        mediaType: 'any',
        upcomingWindowDays: 90,
        regions: [],
        languages: [],
        networks: [],
        streamingServices: [],
        studios: [],
        releaseTypes: [],
        autoMonitorCategories: ['Sci-Fi'],
        notifyOnlyCategories: [],
        ignoreCategories: [],
        blockedFromAutoCategories: [],
        categoryMatchMode: 'ANY',
        minimumConfidence: 0.8,
      },
      { now: NOW, autoAddBudgetExhausted: s.exhausted },
    );

    expect(verdict.decision).toBe('needs_review');
    expect(verdict.reason).toMatch(/Automatic-add threshold reached/);
  });
});
