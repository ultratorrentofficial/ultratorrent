import { RssService } from './rss.module';

/**
 * Export scoping.
 *
 * A whole-install bundle carries every rule with its match candidates, and one
 * exported from a populated install exceeded the receiving server's request body
 * limit — the import failed with "Internal server error" and no clue why.
 * Narrowing at the source is the reliable fix; raising the ceiling only moves it.
 */
function build(rules: Array<Record<string, unknown>>) {
  const queries: any[] = [];
  const prisma = {
    rssRule: {
      findMany: jest.fn(async (a: any) => {
        queries.push(a.where);
        const w = a.where;
        return rules.filter((r: any) => {
          if (w?.id?.in && !w.id.in.includes(r.id)) return false;
          if (w?.feedId && r.feedId !== w.feedId) return false;
          return true;
        }).map((r: any) => ({ ...r, feed: { url: 'u', name: 'f' }, matchCandidates: [] }));
      }),
    },
    rssFeed: { findUnique: jest.fn(async () => ({ id: 'f1', url: 'u', name: 'f' })) },
  };
  const svc = new RssService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    { get: async () => null, defaultProfile: async () => null } as never,
  );
  return { svc, queries };
}

const RULES = [
  { id: 'r1', name: 'Silo', feedId: 'f1' },
  { id: 'r2', name: 'House of the Dragon', feedId: 'f1' },
  { id: 'r3', name: 'YTS', feedId: 'f2' },
];

describe('RssService.exportRules — scoping', () => {
  it('exports everything when unscoped', async () => {
    const { svc } = build(RULES);
    const out = await svc.exportRules();
    expect(out.rules).toHaveLength(3);
  });

  it('exports only the selected rules', async () => {
    const { svc } = build(RULES);
    const out = await svc.exportRules({ ruleIds: ['r1', 'r3'] });
    expect(out.rules.map((r: any) => r.name).sort()).toEqual(['Silo', 'YTS']);
  });

  it('exports only one feed', async () => {
    const { svc } = build(RULES);
    const out = await svc.exportRules({ feedId: 'f1' });
    expect(out.rules).toHaveLength(2);
  });

  it('intersects the two rather than widening', async () => {
    // "These rules, and only if they belong to that feed" — a selection must not
    // pull in a rule from another feed just because its id was listed.
    const { svc } = build(RULES);
    const out = await svc.exportRules({ feedId: 'f1', ruleIds: ['r1', 'r3'] });
    expect(out.rules.map((r: any) => r.name)).toEqual(['Silo']);
  });

  it('treats an empty selection as unscoped, not as "nothing"', async () => {
    // An empty array is the absence of a filter; returning zero rules would make
    // an export silently produce an empty bundle.
    const { svc } = build(RULES);
    const out = await svc.exportRules({ ruleIds: [] });
    expect(out.rules).toHaveLength(3);
  });
});
