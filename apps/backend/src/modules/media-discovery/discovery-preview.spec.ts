import { DiscoveryPreviewService, type PreviewableTemplate } from './discovery-preview.service';

const NOW = new Date('2026-09-06T00:00:00Z');
const soon = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

const row = (id: string, over: Partial<any> = {}) => ({
  id,
  mediaType: 'tv',
  title: `Title ${id}`,
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
  releaseDates: [{ releaseType: 'series_premiere', date: soon(10), region: 'US' }],
  ...over,
});

const TEMPLATE: PreviewableTemplate = {
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
};

/**
 * A Prisma stub whose every WRITE throws.
 *
 * This is the test that matters. Preview must not create a watchlist entry, a
 * rule, a directory, an evaluation row or a counter — and the way to prove that
 * is to make any write fail loudly rather than to inspect what was called.
 */
function readOnlyPrisma(rows: any[]) {
  const explode = (what: string) => () => {
    throw new Error(`preview must not write: ${what}`);
  };
  const writes = {
    create: explode('create'),
    createMany: explode('createMany'),
    update: explode('update'),
    updateMany: explode('updateMany'),
    upsert: explode('upsert'),
    delete: explode('delete'),
    deleteMany: explode('deleteMany'),
  };
  return {
    discoveredMedia: { findMany: jest.fn(async ({ take }: any) => rows.slice(0, take)), ...writes },
    discoveryEvaluation: { ...writes },
    mediaAcquisitionWatchlistItem: { ...writes },
    rssRule: { ...writes },
    discoveryProviderState: { ...writes },
    discoveryTemplate: { ...writes },
    $transaction: () => {
      throw new Error('preview must not write: $transaction');
    },
  } as any;
}

describe('preview writes nothing', () => {
  it('completes against a Prisma stub where every write throws', async () => {
    const svc = new DiscoveryPreviewService(readOnlyPrisma([row('a'), row('b')]));
    await expect(svc.preview(TEMPLATE, NOW)).resolves.toBeDefined();
  });

  it('reads only discovered media', async () => {
    const prisma = readOnlyPrisma([row('a')]);
    const svc = new DiscoveryPreviewService(prisma);
    await svc.preview(TEMPLATE, NOW);
    expect(prisma.discoveredMedia.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('the counts', () => {
  it('classifies the catalogue the way the evaluator does', async () => {
    const svc = new DiscoveryPreviewService(
      readOnlyPrisma([
        row('auto', { genres: ['Sci-Fi'] }),
        row('notify', { genres: ['Drama'] }),
        row('ignore', { genres: ['Reality'] }),
        row('review', { genres: ['Sci-Fi'], identityStatus: 'ambiguous', confidence: 0.2 }),
        row('na', { mediaType: 'movie', releaseDates: [] }),
      ]),
    );
    const r = await svc.preview({ ...TEMPLATE, mediaType: 'tv' }, NOW);

    expect(r.counts).toEqual({
      auto_monitor: 1,
      notify: 1,
      ignore: 1,
      needs_review: 1,
      not_applicable: 1,
    });
    expect(r.examined).toBe(5);
  });

  /*
   * A preview built from a second copy of the rules would drift from the real
   * evaluator, and the drift would be invisible exactly where confidence matters.
   */
  it('uses the same evaluator, so a policy change moves the preview with it', async () => {
    const rows = [row('x', { genres: ['Documentary'] })];
    const svc = new DiscoveryPreviewService(readOnlyPrisma(rows));

    const before = await svc.preview(TEMPLATE, NOW);
    expect(before.counts.ignore).toBe(1);

    const after = await svc.preview(
      { ...TEMPLATE, autoMonitorCategories: ['Documentary'] },
      NOW,
    );
    expect(after.counts.auto_monitor).toBe(1);
  });

  it('previews an UNSAVED template, so the adjust loop needs no writes', async () => {
    const svc = new DiscoveryPreviewService(readOnlyPrisma([row('a', { genres: ['Western'] })]));
    const r = await svc.preview({ ...TEMPLATE, autoMonitorCategories: ['Western'] }, NOW);
    expect(r.counts.auto_monitor).toBe(1);
  });
});

describe('samples', () => {
  /*
   * A catalogue that is 90% ignored would otherwise fill the whole sample with
   * ignores and show none of the handful that would be monitored — which are the
   * ones an operator opened the preview to see.
   */
  it('caps samples per decision, not overall', async () => {
    const rows = [
      ...Array.from({ length: 200 }, (_, i) => row(`ig${i}`, { genres: ['Reality'] })),
      row('auto1', { genres: ['Sci-Fi'] }),
      row('auto2', { genres: ['Sci-Fi'] }),
    ];
    const svc = new DiscoveryPreviewService(readOnlyPrisma(rows));
    const r = await svc.preview(TEMPLATE, NOW);

    expect(r.counts.ignore).toBe(200);
    expect(r.samples.filter((s) => s.decision === 'auto_monitor')).toHaveLength(2);
    expect(r.samples.filter((s) => s.decision === 'ignore').length).toBeLessThanOrEqual(25);
  });

  it('carries the reason, so a preview explains itself', async () => {
    const svc = new DiscoveryPreviewService(readOnlyPrisma([row('a', { genres: ['Reality'] })]));
    const [sample] = (await svc.preview(TEMPLATE, NOW)).samples;
    expect(sample.reason).toMatch(/Reality/);
  });

  it('does not sample titles the template has no opinion about', async () => {
    const svc = new DiscoveryPreviewService(readOnlyPrisma([row('na', { mediaType: 'movie' })]));
    const r = await svc.preview({ ...TEMPLATE, mediaType: 'tv' }, NOW);
    expect(r.counts.not_applicable).toBe(1);
    expect(r.samples).toEqual([]);
  });
});

describe('limits are projected, not applied', () => {
  /*
   * A preview answers "what does this template select". Folding the budget in
   * would make every title past the tenth read as needs_review and hide the shape
   * of the policy being tuned.
   */
  it('reports every qualifying title as auto_monitor, whatever the cap', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`a${i}`, { genres: ['Sci-Fi'] }));
    const svc = new DiscoveryPreviewService(readOnlyPrisma(rows));
    const r = await svc.preview(TEMPLATE, NOW);

    expect(r.counts.auto_monitor).toBe(40);
    expect(r.counts.needs_review).toBe(0);
  });

  it('says separately how many would fall past the weekly allowance', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`a${i}`, { genres: ['Sci-Fi'] }));
    const svc = new DiscoveryPreviewService(readOnlyPrisma(rows));
    const r = await svc.preview(TEMPLATE, NOW);

    expect(r.limits).toEqual({
      perDay: 10,
      perWeek: 30,
      autoMonitorCandidates: 40,
      beyondWeeklyAllowance: 10,
    });
  });

  it('reports zero beyond the allowance when the cap is generous', async () => {
    const svc = new DiscoveryPreviewService(readOnlyPrisma([row('a')]));
    const r = await svc.preview(TEMPLATE, NOW);
    expect(r.limits.beyondWeeklyAllowance).toBe(0);
  });
});

describe('bounds', () => {
  it('is not truncated for an ordinary catalogue', async () => {
    const svc = new DiscoveryPreviewService(readOnlyPrisma([row('a'), row('b')]));
    expect((await svc.preview(TEMPLATE, NOW)).truncated).toBe(false);
  });

  /*
   * A silent cap reads as "this is the whole picture". Saying so is the
   * difference between a sample and a wrong census.
   */
  it('says so when the catalogue is larger than one preview may read', async () => {
    const rows = Array.from({ length: 5_001 }, (_, i) => row(`r${i}`));
    const svc = new DiscoveryPreviewService(readOnlyPrisma(rows));
    const r = await svc.preview(TEMPLATE, NOW);

    expect(r.truncated).toBe(true);
    expect(r.examined).toBe(5_000);
  });
});
