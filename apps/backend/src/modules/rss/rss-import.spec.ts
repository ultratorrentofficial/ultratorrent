import { RssService } from './rss.module';

// Minimal in-memory Prisma stub covering the tables importRules touches.
function makePrisma() {
  const feeds: any[] = [];
  const rules: any[] = [];
  const candidates: any[] = [];
  let n = 0;
  const nid = () => `id${++n}`;
  return {
    _feeds: feeds,
    _rules: rules,
    _candidates: candidates,
    rssFeed: {
      findFirst: async ({ where }: any) => feeds.find((f) => f.url === where.url) ?? null,
      create: async ({ data }: any) => {
        const f = { id: nid(), ...data };
        feeds.push(f);
        return f;
      },
    },
    rssRule: {
      findFirst: async ({ where, include }: any) => {
        const rule = rules.find((r) => r.feedId === where.feedId && r.name === where.name) ?? null;
        if (rule && include?.matchCandidates) {
          return { ...rule, matchCandidates: candidates.filter((c) => c.rssRuleId === rule.id) };
        }
        return rule;
      },
      create: async ({ data }: any) => {
        const r = { id: nid(), ...data };
        rules.push(r);
        return r;
      },
      update: async ({ where, data }: any) => {
        const r = rules.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      },
    },
    rssRuleMatchCandidate: {
      create: async ({ data }: any) => {
        const c = { id: nid(), ...data };
        candidates.push(c);
        return c;
      },
      deleteMany: async ({ where }: any) => {
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (candidates[i].rssRuleId === where.rssRuleId) candidates.splice(i, 1);
        }
        return { count: 0 };
      },
    },
  };
}

const bundle = (rules: any[]) => ({
  kind: 'ultratorrent.rss-export',
  version: 1,
  exportedAt: 'x',
  rules,
});

const showA = () => ({
  name: 'Show A',
  autoDownload: true,
  isEnabled: true,
  feed: { name: 'F', url: 'http://f/rss', refreshInterval: 900 },
  candidates: [
    { name: 'c1', matchType: 'contains_text', pattern: 'Show A' },
    { name: 'c2', matchType: 'regex', pattern: 'Show.A.*' },
  ],
});

const svcWith = (prisma: any) =>
  new RssService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, ({ emit() {} }) as any);

describe('RssService.importRules — import modes', () => {
  it('creates a new rule + its candidates', async () => {
    const prisma = makePrisma();
    const s = await svcWith(prisma).importRules(bundle([showA()]));
    expect(s.mode).toBe('skip');
    expect(s.rulesCreated).toBe(1);
    expect(s.candidatesCreated).toBe(2);
    expect(prisma._candidates).toHaveLength(2);
  });

  it('skip: leaves an existing same-name rule untouched', async () => {
    const prisma = makePrisma();
    const svc = svcWith(prisma);
    await svc.importRules(bundle([showA()]));
    const s = await svc.importRules(bundle([showA()]), 'skip');
    expect(s.rulesSkipped).toBe(1);
    expect(s.rulesCreated).toBe(0);
    expect(prisma._candidates).toHaveLength(2); // unchanged
  });

  it('overwrite: replaces rule fields AND the whole candidate set', async () => {
    const prisma = makePrisma();
    const svc = svcWith(prisma);
    await svc.importRules(bundle([showA()]));
    const s = await svc.importRules(
      bundle([
        {
          name: 'Show A',
          autoDownload: false,
          isEnabled: true,
          feed: { name: 'F', url: 'http://f/rss' },
          candidates: [{ name: 'only', matchType: 'wildcard', pattern: '*' }],
        },
      ]),
      'overwrite',
    );
    expect(s.rulesOverwritten).toBe(1);
    expect(prisma._candidates).toHaveLength(1); // 2 replaced by 1
    expect(prisma._candidates[0].matchType).toBe('wildcard');
    expect(prisma._rules[0].autoDownload).toBe(false); // fields updated
  });

  it('merge: appends only new candidates, de-dups existing', async () => {
    const prisma = makePrisma();
    const svc = svcWith(prisma);
    await svc.importRules(bundle([showA()])); // c1, c2
    const s = await svc.importRules(
      bundle([
        {
          name: 'Show A',
          feed: { name: 'F', url: 'http://f/rss' },
          candidates: [
            { name: 'c1', matchType: 'contains_text', pattern: 'Show A' }, // duplicate
            { name: 'c3', matchType: 'fuzzy_match', pattern: 'Show A' }, // new
          ],
        },
      ]),
      'merge',
    );
    expect(s.rulesMerged).toBe(1);
    expect(s.candidatesCreated).toBe(1); // only c3
    expect(s.candidatesSkipped).toBe(1); // c1 duplicate
    expect(prisma._candidates).toHaveLength(3); // c1, c2, c3
  });

  it('reuses an existing feed by URL without duplicating or renaming it', async () => {
    const prisma = makePrisma();
    const svc = svcWith(prisma);
    await svc.importRules(bundle([showA()]));
    await svc.importRules(
      bundle([{ name: 'Show B', feed: { name: 'DIFFERENT', url: 'http://f/rss' }, candidates: [] }]),
    );
    expect(prisma._feeds).toHaveLength(1);
    expect(prisma._feeds[0].name).toBe('F'); // original feed name kept
  });

  it('drops candidates with an invalid matchType (counted as skipped)', async () => {
    const prisma = makePrisma();
    const s = await svcWith(prisma).importRules(
      bundle([
        {
          name: 'X',
          feed: { name: 'F', url: 'http://f/rss' },
          candidates: [{ name: 'bad', matchType: 'nope', pattern: 'x' }],
        },
      ]),
    );
    expect(s.candidatesSkipped).toBe(1);
    expect(prisma._candidates).toHaveLength(0);
  });
});

describe('RssService.exportRules — per-feed scoping', () => {
  // Two feeds, one rule each. exportRules(feedId) must return only that feed's
  // rule; exportRules() (no arg) returns both.
  const feedA = { id: 'fa', name: 'Feed A', url: 'http://a/rss', refreshInterval: 900 };
  const feedB = { id: 'fb', name: 'Feed B', url: 'http://b/rss', refreshInterval: 600 };
  const ruleRows = [
    { name: 'Rule A', feedId: 'fa', feed: feedA, matchCandidates: [] },
    { name: 'Rule B', feedId: 'fb', feed: feedB, matchCandidates: [] },
  ];
  const prisma = {
    rssFeed: {
      findUnique: async ({ where }: any) =>
        [feedA, feedB].find((f) => f.id === where.id) ?? null,
    },
    rssRule: {
      findMany: async ({ where }: any) =>
        where?.feedId ? ruleRows.filter((r) => r.feedId === where.feedId) : ruleRows,
    },
  };

  it('exports only the requested feed’s rules', async () => {
    const bundle = await svcWith(prisma).exportRules('fa');
    expect(bundle.rules).toHaveLength(1);
    expect(bundle.rules[0].name).toBe('Rule A');
    expect(bundle.rules[0].feed.url).toBe('http://a/rss');
  });

  it('exports all rules when no feed is given', async () => {
    const bundle = await svcWith(prisma).exportRules();
    expect(bundle.rules).toHaveLength(2);
  });

  it('rejects an unknown feed id', async () => {
    await expect(svcWith(prisma).exportRules('nope')).rejects.toThrow(/not found/i);
  });
});
