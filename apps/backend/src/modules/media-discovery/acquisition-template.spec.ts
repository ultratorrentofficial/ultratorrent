import { BadRequestException } from '@nestjs/common';
import { AcquisitionTemplateService, type AcquisitionTemplateInput } from './acquisition-template.service';

function harness(existing?: any) {
  const state = { row: existing ?? null as any };
  const prisma: any = {
    acquisitionRuleTemplate: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => state.row),
      create: jest.fn(async ({ data }: any) => ({
        id: 'a1',
        version: 1,
        ...data,
        candidates: (data.candidates?.create ?? []).map((c: any, i: number) => ({ id: `c${i}`, ...c })),
      })),
      update: jest.fn(async ({ data }: any) => ({
        id: 'a1',
        ...state.row,
        ...data,
        version: data.version?.increment ? (state.row?.version ?? 1) + 1 : (state.row?.version ?? 1),
        candidates: (data.candidates?.create ?? state.row?.candidates ?? []).map((c: any, i: number) => ({ id: `c${i}`, ...c })),
      })),
      delete: jest.fn(async () => ({})),
    },
    acquisitionRuleTemplateCandidate: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    $transaction: jest.fn(async (fn: any): Promise<any> => fn(prisma)),
  };
  const audit = { record: jest.fn(async () => undefined) };
  return { svc: new AcquisitionTemplateService(prisma as any, audit as any), prisma, audit, state };
}

const LADDER: AcquisitionTemplateInput = {
  name: 'TV Premium 4K',
  mediaType: 'tv',
  candidates: [
    { name: '2160p WEB-DL HEVC DV', priorityOrder: 0, qualityRules: { resolution: '2160p', source: 'WEB-DL', codec: 'x265' }, requiredTerms: ['DV'] },
    { name: '2160p WEB-DL HEVC', priorityOrder: 1, qualityRules: { resolution: '2160p', source: 'WEB-DL', codec: 'x265' } },
    { name: '1080p WEB-DL HEVC', priorityOrder: 2, qualityRules: { resolution: '1080p', source: 'WEB-DL', codec: 'x265' } },
    { name: '1080p WEB-DL x264', priorityOrder: 3, qualityRules: { resolution: '1080p', source: 'WEB-DL', codec: 'x264' } },
  ],
  excludedTerms: ['CAM', 'TS', 'TC', 'SCR'],
};

describe('creating a template', () => {
  it('stores the ladder in priority order', async () => {
    const { svc } = harness();
    const t = await svc.create(LADDER);
    expect(t.candidates.map((c: any) => c.priorityOrder)).toEqual([0, 1, 2, 3]);
    expect(t.candidates[0].name).toBe('2160p WEB-DL HEVC DV');
  });

  it('renumbers a ladder whose ordering has gaps', async () => {
    const { svc } = harness();
    const t = await svc.create({
      name: 'x',
      candidates: [
        { name: 'third', priorityOrder: 90 },
        { name: 'first', priorityOrder: 5 },
        { name: 'second', priorityOrder: 40 },
      ],
    });
    expect(t.candidates.map((c: any) => c.name)).toEqual(['first', 'second', 'third']);
    expect(t.candidates.map((c: any) => c.priorityOrder)).toEqual([0, 1, 2]);
  });

  it('requires a name on the template and on every candidate', async () => {
    const { svc } = harness();
    await expect(svc.create({ name: ' ' })).rejects.toThrow(BadRequestException);
    await expect(svc.create({ name: 'x', candidates: [{ name: '' }] })).rejects.toThrow(/Candidate 1 needs a name/);
  });
});

describe('validation refuses settings that would do nothing', () => {
  /*
   * The reason this is strict. `match-engine.ts` reads exactly `quality`,
   * `source`, `codec`, `resolution` (plus season/episode/year). Accepting `hdr`
   * would give an operator a preference that looks configured and silently has no
   * effect — the worst kind, because nothing ever reports it.
   */
  it('rejects an hdr quality rule and says how to express it instead', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', candidates: [{ name: 'c', qualityRules: { hdr: 'Dolby Vision' } }] }),
    ).rejects.toThrow(/does not read hdr.*requiredTerms/s);
  });

  it('rejects an audio quality rule the same way', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', candidates: [{ name: 'c', qualityRules: { audio: 'Atmos' } }] }),
    ).rejects.toThrow(/does not read audio/);
  });

  it('accepts HDR and Atmos expressed as required terms', async () => {
    const { svc } = harness();
    const t = await svc.create({
      name: 'x',
      candidates: [{ name: 'c', requiredTerms: ['DV', 'Atmos'], qualityRules: { resolution: '2160p' } }],
    });
    expect(t.candidates[0].requiredTerms).toEqual(['DV', 'Atmos']);
  });

  it('rejects an unknown size rule', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', candidates: [{ name: 'c', sizeRules: { maxGigabytes: 20 } }] }),
    ).rejects.toThrow(/unknown size rule "maxGigabytes"/);
  });

  it('rejects a minimum size above the maximum', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', candidates: [{ name: 'c', sizeRules: { minBytes: 10, maxBytes: 5 } }] }),
    ).rejects.toThrow(/minBytes cannot exceed maxBytes/);
  });

  /*
   * A broken regex fails at match time, deep inside a sweep, where the reason is
   * a log line nobody is reading.
   */
  it('rejects an invalid regular expression at save time', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', candidates: [{ name: 'c', matchType: 'regex', pattern: '([unclosed' }] }),
    ).rejects.toThrow(/not a valid regular expression/);
  });

  it('rejects an unknown match type', async () => {
    const { svc } = harness();
    await expect(
      svc.create({ name: 'x', candidates: [{ name: 'c', matchType: 'vibes' }] }),
    ).rejects.toThrow(/matchType must be one of/);
  });
});

describe('mapping a template onto a rule', () => {
  const template = {
    requiredTerms: ['WEB-DL'],
    excludedTerms: ['CAM', 'TS'],
    candidates: [
      { priorityOrder: 10, name: 'best', description: null, enabled: true, matchType: 'smart_episode_match', pattern: null, requiredTerms: ['DV'], excludedTerms: ['HDTV'], qualityRules: { resolution: '2160p' }, sizeRules: { maxBytes: 30 }, feedScope: {} },
      { priorityOrder: 20, name: 'fallback', description: null, enabled: true, matchType: 'smart_episode_match', pattern: null, requiredTerms: [], excludedTerms: [], qualityRules: { resolution: '1080p' }, sizeRules: {}, feedScope: {} },
    ] as any,
  };

  it('copies the ladder onto the rule, renumbered from zero', () => {
    const { svc } = harness();
    const rows = svc.toRuleCandidates(template, 'rule-1');
    expect(rows.map((r) => r.priorityOrder)).toEqual([0, 1]);
    expect(rows.every((r) => r.rssRuleId === 'rule-1')).toBe(true);
    expect(rows[0].qualityRules).toEqual({ resolution: '2160p' });
  });

  /*
   * Template-wide terms are constraints ("never a CAM"), not a preference of one
   * rung. A rung that dropped them would be a hole in the constraint — the
   * fallback rung would happily accept what the template forbids.
   */
  it('applies the template’s own terms to EVERY rung', () => {
    const { svc } = harness();
    const rows = svc.toRuleCandidates(template, 'rule-1');
    expect(rows[0].requiredTerms).toEqual(['DV', 'WEB-DL']);
    expect(rows[0].excludedTerms).toEqual(['HDTV', 'CAM', 'TS']);
    // The fallback rung, which had none of its own, still carries them.
    expect(rows[1].requiredTerms).toEqual(['WEB-DL']);
    expect(rows[1].excludedTerms).toEqual(['CAM', 'TS']);
  });

  /**
   * A title is text a metadata provider chose, and the fallback puts it where a
   * pattern is expected. For a `regex` rung it was compiled as one, so
   * `S.W.A.T. Exiles` matched `SXWXAXTX` — and a provider name containing
   * nested quantifiers became an expression run against every polled feed item.
   */
  describe('a title used as a pattern is treated as literal text', () => {
    const withType = (matchType: string) => ({
      ...template,
      candidates: [{ ...template.candidates[0], matchType, pattern: null }] as never,
    });
    const subject = (title: string) => ({ title, mediaType: 'tv' });

    it('escapes a title falling back into a regex rung', () => {
      const { svc } = harness();
      const [row] = svc.toRuleCandidates(withType('regex'), 'r', subject('S.W.A.T. Exiles'));
      expect(new RegExp(row.pattern as string, 'i').test('S.W.A.T. Exiles')).toBe(true);
      expect(new RegExp(row.pattern as string, 'i').test('SXWXAXTX Exiles')).toBe(false);
    });

    it('neutralises a title built to backtrack', () => {
      const { svc } = harness();
      const [row] = svc.toRuleCandidates(withType('regex'), 'r', subject('(a+)+$'));
      const start = Date.now();
      new RegExp(row.pattern as string, 'i').test(`${'a'.repeat(5000)}b`);
      expect(Date.now() - start).toBeLessThan(400);
    });

    /* An explicit pattern is the operator's choice and is passed through. */
    it('leaves an explicitly authored pattern alone', () => {
      const { svc } = harness();
      const rows = svc.toRuleCandidates(
        { ...template, candidates: [{ ...template.candidates[0], matchType: 'regex', pattern: '^Show\\.S\\d{2}' }] as never },
        'r',
        subject('Show'),
      );
      expect(rows[0].pattern).toBe('^Show\\.S\\d{2}');
    });

    /* Wildcard does its own escaping and must keep `*` and `?` meaningful. */
    it('does not escape a title for a wildcard rung', () => {
      const { svc } = harness();
      const [row] = svc.toRuleCandidates(withType('wildcard'), 'r', subject('S.W.A.T. Exiles'));
      expect(row.pattern).toBe('S.W.A.T. Exiles');
    });

    /* The smart types match on tokens, not on a regular expression. */
    it('passes the plain title to a smart rung', () => {
      const { svc } = harness();
      const [row] = svc.toRuleCandidates(withType('smart_episode_match'), 'r', subject('S.W.A.T. Exiles'));
      expect(row.pattern).toBe('S.W.A.T. Exiles');
    });
  });

  it('does not duplicate a term a rung already carried', () => {
    const { svc } = harness();
    const rows = svc.toRuleCandidates(
      { ...template, candidates: [{ ...template.candidates[0], requiredTerms: ['WEB-DL'] }] as any },
      'r',
    );
    expect(rows[0].requiredTerms).toEqual(['WEB-DL']);
  });
});

describe('versioning', () => {
  const stored = {
    id: 'a1',
    name: 'T',
    version: 3,
    requiredTerms: [],
    excludedTerms: [],
    candidates: [{ priorityOrder: 0, name: 'a', description: null, enabled: true, matchType: 'smart_episode_match', pattern: null, requiredTerms: [], excludedTerms: [], qualityRules: {}, sizeRules: {}, feedScope: {} }],
  };

  it('bumps the version when the ladder changes', async () => {
    const { svc } = harness(stored);
    const updated = await svc.update('a1', { candidates: [{ name: 'a' }, { name: 'b' }] });
    expect(updated.version).toBe(4);
  });

  it('does not bump the version for a description-only edit', async () => {
    const { svc } = harness(stored);
    const updated = await svc.update('a1', { description: 'clearer wording' });
    expect(updated.version).toBe(3);
  });

  /*
   * Replaced wholesale rather than diffed: the ladder is ordered, and a partial
   * update of an ordered list is where off-by-one priorities come from. The
   * candidates carry no runtime state worth preserving.
   */
  it('replaces the ladder rather than merging into it', async () => {
    const { svc, prisma } = harness(stored);
    await svc.update('a1', { candidates: [{ name: 'only' }] });
    expect(prisma.acquisitionRuleTemplateCandidate.deleteMany).toHaveBeenCalledWith({
      where: { templateId: 'a1' },
    });
  });

  it('leaves the ladder alone when the caller did not send one', async () => {
    const { svc, prisma } = harness(stored);
    await svc.update('a1', { description: 'x' });
    expect(prisma.acquisitionRuleTemplateCandidate.deleteMany).not.toHaveBeenCalled();
  });
});
