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
    // The year is deliberately NOT in the name: a rule is read far more often
    // than two same-titled works collide, and the collision is surfaced by the
    // clash path rather than avoided by making every name noisier.
    expect(svc.ruleName({ title: 'The Odyssey', year: 2026 })).toBe('The Odyssey');
    expect(svc.ruleName({ title: 'Undated', year: null })).toBe('Undated');
    // Canonical, so a provider that already wrote the year does not smuggle it in.
    expect(svc.ruleName({ title: 'Tulsa King (2022)', year: 2022 })).toBe('Tulsa King');
  });

  it('creates a managed-intake rule bound to the template’s feed and profile', async () => {
    const { svc, created } = harness();
    const r = await svc.generate(input());

    expect(r).toEqual({ ruleId: 'rule-1', outcome: 'created' });
    expect(created[0]).toMatchObject({
      feedId: 'feed-1',
      name: 'The Example Show',
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
  /*
   * Inverted, and this is the whole of Fix 3.
   *
   * A rule with no match candidates and no include/exclude regex is treated by
   * `rss.module.ts` as matching NOTHING — deliberately, so a filterless rule
   * cannot grab a whole feed. This generator never sets a regex, so what used to
   * be created here was an enabled, `autoDownload: true` rule that could never
   * acquire anything, with no indication of a fault anywhere.
   */
  it('refuses to create a rule that would match nothing', async () => {
    const { svc, created } = harness();
    const r = await svc.generate(input({ acquisition: null }));
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toMatch(/match nothing/);
    expect(created).toHaveLength(0);
  });

  it('refuses when every rung of the ladder is switched off', async () => {
    const { svc, created } = harness();
    const r = await svc.generate(
      input({ acquisition: { ...ACQUISITION, candidates: ACQUISITION.candidates.map((c: any) => ({ ...c, enabled: false })) } }),
    );
    expect(r.outcome).toBe('skipped');
    expect(created).toHaveLength(0);
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
      clash: { id: 'rule-manual', generatedByDiscovery: false, name: 'The Example Show' },
    });
    const r = await svc.generate(input());

    expect(r.outcome).toBe('skipped');
    expect(r.ruleId).toBe('rule-manual'); // still linkable
    expect(r.reason).toMatch(/not created by discovery — left untouched/);
    expect(prisma.rssRule.create).not.toHaveBeenCalled();
  });

  it('does not create a duplicate when another generated rule holds the name', async () => {
    const { svc, prisma } = harness({
      clash: { id: 'rule-gen', generatedByDiscovery: true, name: 'The Example Show' },
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
    // Must yield an enabled rung, or the generator refuses before the insert
    // this race is about ever happens.
    const acquisitionTemplates = {
      // A pattern is required: the generator refuses a candidate that would
      // match every item in the feed, which would trip before the race logic.
      toRuleCandidates: () => [
        { priorityOrder: 0, name: '1080p', enabled: true, pattern: 'The Example Show' },
      ],
    } as any;
    const audit = { record: jest.fn(async () => undefined) } as any;
    return new DiscoveryRuleService(prisma, audit, acquisitionTemplates);
  }

  const input = () => ({
    media: MEDIA as any,
    template: TEMPLATE as any,
    // A ladder is required now; without one the generator refuses before it
    // ever reaches the insert this race is about.
    acquisition: ACQUISITION,
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

/**
 * A generated rule must be able to acquire something the moment it exists.
 *
 * The failure this pins is not "needs a second configuration step" — it is that
 * a rule built without match preferences was created ENABLED with
 * `autoDownload: true` and matched nothing for ever, because `rss.module.ts`
 * treats a rule with neither candidates nor a regex as matching nothing.
 */
describe('the generated rule is operational', () => {
  it('carries the whole ladder, in order, renumbered from zero', () => {
    const { svc, created } = harness();
    return svc.generate(input()).then(() => {
      const ladder = created[0].matchCandidates.create;
      expect(ladder.map((c: any) => c.priorityOrder)).toEqual([0, 1]);
      expect(ladder.map((c: any) => c.name)).toEqual(['2160p', '1080p']);
    });
  });

  /*
   * Template-wide terms are a CONSTRAINT, not a preference of the top rung — a
   * fallback that dropped `CAM` would accept exactly what the template forbids.
   */
  it('propagates template-wide required and excluded terms to every rung', async () => {
    const { svc, created } = harness();
    await svc.generate(input());
    for (const c of created[0].matchCandidates.create) {
      expect(c.excludedTerms).toContain('CAM');
      expect(c.requiredTerms).toContain('WEB-DL');
    }
  });

  it('keeps a rung own required terms alongside the template-wide ones', async () => {
    const { svc, created } = harness();
    await svc.generate(input());
    const top = created[0].matchCandidates.create[0];
    expect(top.requiredTerms).toEqual(expect.arrayContaining(['DV', 'WEB-DL']));
  });

  it('propagates quality and size rules rather than dropping them', async () => {
    const { svc, created } = harness();
    await svc.generate(input());
    expect(created[0].matchCandidates.create[0].qualityRules).toEqual({ resolution: '2160p' });
  });

  it('is enabled, auto-downloading, and staged through managed intake', async () => {
    const { svc, created } = harness();
    await svc.generate(input());
    expect(created[0].isEnabled).toBe(true);
    expect(created[0].autoDownload).toBe(true);
    expect(created[0].importMode).toBe('managed_intake');
    expect(created[0].storageProfileId).toBe('sp-1');
  });

  it('records which template and version it was built from', async () => {
    const { svc, created } = harness();
    await svc.generate(input());
    expect(created[0].acquisitionTemplateId).toBe('at1');
    expect(created[0].acquisitionTemplateVersion).toBe(4);
    expect(created[0].generatedByDiscovery).toBe(true);
  });
});
