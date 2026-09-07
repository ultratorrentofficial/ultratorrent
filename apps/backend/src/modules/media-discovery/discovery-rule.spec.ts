import { DiscoveryRuleService, type RuleGenerationInput } from './discovery-rule.service';
import { AcquisitionTemplateService } from './acquisition-template.service';

const MEDIA = {
  id: 'dm1',
  title: 'The Example Show',
  year: 2026,
  mediaType: 'tv',
  externalIds: { imdb: 'tt1', tmdb: '2' },
};

const TEMPLATE = { id: 'dt1', rssFeedId: 'feed-1', storageProfileId: 'sp-1' };

const ACQUISITION: any = {
  id: 'at1',
  version: 4,
  requiredTerms: ['WEB-DL'],
  excludedTerms: ['CAM'],
  candidates: [
    { priorityOrder: 0, name: '2160p', description: null, enabled: true, matchType: 'smart_episode_match', pattern: null, requiredTerms: ['DV'], excludedTerms: [], qualityRules: { resolution: '2160p' }, sizeRules: {}, feedScope: {} },
    { priorityOrder: 1, name: '1080p', description: null, enabled: true, matchType: 'smart_episode_match', pattern: null, requiredTerms: [], excludedTerms: [], qualityRules: { resolution: '1080p' }, sizeRules: {}, feedScope: {} },
  ],
};

function harness(opts: { mine?: any; clash?: any } = {}) {
  const created: any[] = [];
  const prisma: any = {
    rssRule: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.discoveredMediaId) return opts.mine ?? null;
        if (where.name) return opts.clash ?? null;
        return null;
      }),
      /*
       * The clash check is now a canonical identity comparison over a narrowed
       * candidate set, not an exact name equality — that is the whole fix, since
       * "Tulsa King" never equalled "Tulsa King (2022)".
       */
      findMany: jest.fn(async ({ where }: any) => {
        if (!opts.clash) return [];
        const needle = String(where?.name?.contains ?? '').toLowerCase();
        return needle && String(opts.clash.name).toLowerCase().includes(needle) ? [opts.clash] : [];
      }),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        return { id: 'rule-1' };
      }),
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const acq = new AcquisitionTemplateService(prisma, audit as any);
  return { svc: new DiscoveryRuleService(prisma, audit as any, acq), prisma, audit, created };
}

const input = (over: Partial<RuleGenerationInput> = {}): RuleGenerationInput => ({
  media: MEDIA,
  template: TEMPLATE,
  acquisition: ACQUISITION,
  ...over,
});

describe('generating a rule', () => {
  it('names it with the year, so two works sharing a title stay distinguishable', () => {
    const { svc } = harness();
    expect(svc.ruleName({ title: 'The Odyssey', year: 2026 })).toBe('The Odyssey (2026)');
    expect(svc.ruleName({ title: 'Undated', year: null })).toBe('Undated');
  });

  it('creates a managed-intake rule bound to the template’s feed and profile', async () => {
    const { svc, created } = harness();
    const r = await svc.generate(input());

    expect(r).toEqual({ ruleId: 'rule-1', outcome: 'created' });
    expect(created[0]).toMatchObject({
      feedId: 'feed-1',
      name: 'The Example Show (2026)',
      importMode: 'managed_intake',
      storageProfileId: 'sp-1',
      generatedByDiscovery: true,
      discoveryTemplateId: 'dt1',
      acquisitionTemplateId: 'at1',
      acquisitionTemplateVersion: 4,
      discoveredMediaId: 'dm1',
    });
  });

  it('copies the acquisition ladder onto the rule', async () => {
    const { svc, created } = harness();
    await svc.generate(input());
    const rungs = created[0].matchCandidates.create;
    expect(rungs.map((c: any) => c.priorityOrder)).toEqual([0, 1]);
    // Template-wide terms reach every rung.
    expect(rungs[0].requiredTerms).toEqual(['DV', 'WEB-DL']);
    expect(rungs[1].excludedTerms).toEqual(['CAM']);
    // The FK is supplied by the nested create, not by the mapper.
    expect(rungs[0]).not.toHaveProperty('rssRuleId');
  });

  /*
   * `resolveCandidates()` already falls back to the auto-download profiles and
   * then the global defaults, so a rule with no ladder still has preferences.
   */
  it('creates a rule with no candidates when the template has no acquisition template', async () => {
    const { svc, created } = harness();
    const r = await svc.generate(input({ acquisition: null }));
    expect(r.outcome).toBe('created');
    expect(created[0].matchCandidates).toBeUndefined();
    expect(created[0].acquisitionTemplateId).toBeNull();
  });

  it('records the generation in the audit log', async () => {
    const { svc, audit } = harness();
    await svc.generate(input(), 'user-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'media_discovery.rule.generated',
        metadata: expect.objectContaining({ discoveredMediaId: 'dm1', candidates: 2 }),
      }),
    );
  });
});

describe('refusing to generate', () => {
  /*
   * `RssRule.feedId` is required, which is why a discovery template names a feed
   * and cannot be ENABLED without one. This is the belt to that braces.
   */
  it('skips when the discovery template has no feed', async () => {
    const { svc, prisma } = harness();
    const r = await svc.generate(input({ template: { ...TEMPLATE, rssFeedId: null } }));
    expect(r).toMatchObject({ ruleId: null, outcome: 'skipped' });
    expect(r.reason).toMatch(/no RSS feed/i);
    expect(prisma.rssRule.create).not.toHaveBeenCalled();
  });

  it('reuses the rule it already generated for this title', async () => {
    const { svc, prisma } = harness({ mine: { id: 'rule-existing' } });
    const r = await svc.generate(input());
    expect(r).toEqual({ ruleId: 'rule-existing', outcome: 'reused' });
    expect(prisma.rssRule.create).not.toHaveBeenCalled();
  });

  /*
   * Adopting a hand-made rule would replace an operator's preferences with a
   * template's and leave no trace it happened. The watchlist entry still links to
   * it — that is the useful half — and the discovery is reported so somebody can
   * look.
   */
  it('never takes over a rule a person made, and says so', async () => {
    const { svc, prisma } = harness({
      clash: { id: 'rule-manual', generatedByDiscovery: false, name: 'The Example Show (2026)' },
    });
    const r = await svc.generate(input());

    expect(r.outcome).toBe('skipped');
    expect(r.ruleId).toBe('rule-manual'); // still linkable
    expect(r.reason).toMatch(/not created by discovery — left untouched/);
    expect(prisma.rssRule.create).not.toHaveBeenCalled();
  });

  it('does not create a duplicate when another generated rule holds the name', async () => {
    const { svc, prisma } = harness({
      clash: { id: 'rule-gen', generatedByDiscovery: true, name: 'The Example Show (2026)' },
    });
    const r = await svc.generate(input());
    expect(r.outcome).toBe('skipped');
    expect(prisma.rssRule.create).not.toHaveBeenCalled();
  });
});

describe('protecting an operator’s edits', () => {
  /*
   * The `userModifiedAt` filter is the whole point. Past that line the operator's
   * edit is the more specific intent, and reverting it on the next sync would be
   * silent and correct-looking.
   */
  it('offers only untouched generated rules for re-application', async () => {
    const { svc, prisma } = harness();
    await svc.reappliable('at1');
    expect(prisma.rssRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { generatedByDiscovery: true, acquisitionTemplateId: 'at1', userModifiedAt: null },
      }),
    );
  });

  it('can list the ones a person has taken over, so they are reported not hidden', async () => {
    const { svc, prisma } = harness();
    await svc.userOwned('at1');
    expect(prisma.rssRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { generatedByDiscovery: true, acquisitionTemplateId: 'at1', userModifiedAt: { not: null } },
      }),
    );
  });
});

/**
 * Concurrency.
 *
 * The resolver is a check-then-insert, and two passes can both pass the check —
 * TMDB and TVmaze reaching the same show in one run, or a manual evaluate
 * overlapping the hourly tick. A partial unique index makes the database the
 * guarantee; this is what the loser of that race does with the rejection.
 */
describe('two passes racing for the same title', () => {
  function racingHarness(winnerId: string | null) {
    const prisma: any = {
      rssRule: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.discoveredMediaId && winnerId ? { id: winnerId } : null,
        ),
        findMany: jest.fn(async () => []),
        create: jest.fn(async () => {
          const e: any = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }),
      },
    };
    const acquisitionTemplates = { toRuleCandidates: () => [] } as any;
    const audit = { record: jest.fn(async () => undefined) } as any;
    return new DiscoveryRuleService(prisma, audit, acquisitionTemplates);
  }

  const input = () => ({
    media: MEDIA as any,
    template: TEMPLATE as any,
    acquisition: null,
  });

  it('resolves to the rule the winner created rather than failing', async () => {
    // `findFirst` answers null on the pre-check and the winner's id after the
    // insert lost — which is exactly the sequence a real race produces.
    const svc = racingHarness('rule-winner');
    let call = 0;
    (svc as any).prisma.rssRule.findFirst = jest.fn(async () => (call++ === 0 ? null : { id: 'rule-winner' }));
    const r = await svc.generate(input() as any);
    expect(r.outcome).toBe('reused');
    expect(r.ruleId).toBe('rule-winner');
  });

  /*
   * A P2002 with nothing to resolve to is a different fault — a constraint we do
   * not understand — and swallowing it would hide it.
   */
  it('rethrows when the constraint fired but no winner can be found', async () => {
    const svc = racingHarness(null);
    await expect(svc.generate(input() as any)).rejects.toThrow(/Unique constraint/);
  });
});
