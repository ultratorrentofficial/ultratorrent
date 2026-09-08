import { DiscoveryTemplateService, POLICY_KEYS, type DiscoveryTemplateInput } from './discovery-template.service';

/**
 * Every field that decides an outcome must survive a save.
 *
 * `columns()` — which builds the Prisma write — and `POLICY_KEYS` — which
 * decides whether an edit reopens the catalogue — are two halves of one fact
 * kept in two hand-maintained lists. They drifted: `autoMonitorEnabled`,
 * `requireUpcoming`, `gracePeriodDays`, `pastReleaseBehavior` and
 * `returningSeriesBehavior` were in the second and missing from the first.
 *
 * The failure mode is the reason this file exists. A missing key does not throw
 * and does not warn. `policyChanged` still SEES the edit, so the request
 * succeeds, `policyVersion` is bumped and every decision the template had made
 * is deleted — while the value the operator actually changed is dropped. On the
 * live install, unchecking "monitor matching titles automatically" reported
 * success, wiped the catalogue's decisions, and left the column `true`.
 */

/** A value of the right shape for each policy column, distinct from its default. */
const SAMPLE: Record<string, unknown> = {
  mediaType: 'tv',
  providers: ['tmdb'],
  upcomingWindowDays: 45,
  regions: ['US'],
  languages: ['en'],
  minimumPopularity: 12,
  minimumRating: 7,
  minimumVoteCount: 100,
  networks: ['Apple TV+'],
  streamingServices: ['Netflix'],
  studios: ['A24'],
  seriesTypes: ['scripted'],
  releaseTypes: ['series_premiere'],
  autoMonitorCategories: ['Sci-Fi'],
  notifyOnlyCategories: ['Drama'],
  ignoreCategories: ['Talk'],
  blockedFromAutoCategories: ['Documentary'],
  categoryMatchMode: 'ALL',
  minimumConfidence: 0.5,
  acquisitionTemplateId: 'a1',
  rssFeedId: 'f1',
  storageProfileId: 'p1',
  pathTemplate: '{tvshow} ({year})',
  createIntakeDirectory: true,
  autoAddLimitPerDay: 3,
  autoAddLimitPerWeek: 9,
  // The five that were dropped. Each is the NON-default, which is the only value
  // that can prove it was written rather than merely left alone.
  autoMonitorEnabled: false,
  requireUpcoming: false,
  gracePeriodDays: 3,
  pastReleaseBehavior: 'ignore',
  returningSeriesBehavior: 'review',
};

function harness(current: any = {}) {
  const prisma = {
    discoveryTemplate: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => ({ id: 't1', name: 'T', enabled: false, ...current })),
      create: jest.fn(async ({ data }: any) => ({ id: 't1', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 't1', name: 'T', ...data })),
      delete: jest.fn(async () => ({})),
    },
    rssFeed: { findUnique: jest.fn(async () => ({ id: 'f1', isEnabled: true, name: 'Feed' })) },
    storageProfile: { findUnique: jest.fn(async () => ({ id: 'p1', isEnabled: true, name: 'Dev' })) },
    acquisitionRuleTemplate: {
      findUnique: jest.fn(async () => ({ id: 'a1', name: 'Ladder', enabled: true, candidates: [{ enabled: true }] })),
    },
    discoveryEvaluation: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  return { svc: new DiscoveryTemplateService(prisma as any, audit as any), prisma };
}

const input = () => ({ name: 'T', ...SAMPLE }) as DiscoveryTemplateInput;

describe('every policy field survives a save', () => {
  it('has a sample value for each policy key, so this file cannot rot', () => {
    for (const key of POLICY_KEYS) expect(SAMPLE).toHaveProperty(key);
  });

  it.each(POLICY_KEYS)('writes %s on update', async (key) => {
    const { svc, prisma } = harness();
    await svc.update('t1', input());
    expect(prisma.discoveryTemplate.update.mock.calls[0][0].data).toHaveProperty(key, SAMPLE[key]);
  });

  it.each(POLICY_KEYS)('writes %s on create', async (key) => {
    const { svc, prisma } = harness();
    await svc.create(input());
    expect(prisma.discoveryTemplate.create.mock.calls[0][0].data).toHaveProperty(key, SAMPLE[key]);
  });

  /*
   * The specific report: two boxes unchecked, the save succeeding, the columns
   * unchanged. `false` is the value a copy-by-truthiness would also drop, so it
   * is asserted on its own rather than only inside the sweep above.
   */
  it('turns automatic monitoring off when the box is unchecked', async () => {
    const { svc, prisma } = harness({ autoMonitorEnabled: true, requireUpcoming: true });
    await svc.update('t1', { name: 'T', autoMonitorEnabled: false, requireUpcoming: false });
    expect(prisma.discoveryTemplate.update.mock.calls[0][0].data).toMatchObject({
      autoMonitorEnabled: false,
      requireUpcoming: false,
    });
  });

  /* A field the caller did not send is left alone, not overwritten with a default. */
  it('does not write a field the request omitted', async () => {
    const { svc, prisma } = harness({ requireUpcoming: false });
    await svc.update('t1', { name: 'T', autoMonitorEnabled: false });
    expect(prisma.discoveryTemplate.update.mock.calls[0][0].data).not.toHaveProperty('requireUpcoming');
  });
});
