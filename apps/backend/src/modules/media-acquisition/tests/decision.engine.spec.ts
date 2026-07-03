import { DecisionProfile, DecisionSignals, decide } from '../decision.engine';

const profile = (over: Partial<DecisionProfile> = {}): DecisionProfile => ({
  minimumScore: 60,
  approvalScore: 80,
  excludedTerms: [],
  requiredTerms: [],
  allowUpgrades: true,
  approvalRequired: false,
  ...over,
});

const signals = (over: Partial<DecisionSignals> = {}): DecisionSignals => ({
  score: { value: 90, warnings: [], rejected: false },
  watchlist: { matched: true },
  library: { needed: true, owned: false },
  duplicate: { level: 'low' },
  storage: { ok: true },
  titleLower: 'the show s01e02 1080p web-dl x265-grp',
  ...over,
});

describe('decide (explainable acquisition)', () => {
  it('downloads a missing, wanted release above thresholds', () => {
    const r = decide(signals(), profile());
    expect(r.decision).toBe('download');
    expect(r.requiresApproval).toBe(false);
    expect(r.trace.some((s) => s.step === 'final_decision' && s.decision === 'download')).toBe(true);
    expect(r.trace.map((s) => s.step)).toEqual(expect.arrayContaining(['release_scoring', 'watchlist_match', 'library_need']));
  });

  it('skips when already owned in equal/better quality', () => {
    const r = decide(signals({ library: { needed: false, owned: true, newIsBetter: false } }), profile());
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/Already owned/);
  });

  it('recommends an upgrade when owned but the new release is better', () => {
    const r = decide(signals({ library: { needed: false, owned: true, newIsBetter: true } }), profile());
    expect(r.decision).toBe('upgrade_existing');
  });

  it('skips on an excluded term regardless of everything else', () => {
    const r = decide(signals({ titleLower: 'the show s01e02 cam' }), profile({ excludedTerms: ['CAM'] }));
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/excluded term/i);
  });

  it('skips below the minimum score', () => {
    const r = decide(signals({ score: { value: 40, warnings: [], rejected: false } }), profile({ minimumScore: 60 }));
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/minimum score/i);
  });

  it('holds for approval when the score is below the approval threshold', () => {
    const r = decide(signals({ score: { value: 70, warnings: [], rejected: false } }), profile({ minimumScore: 60, approvalScore: 80 }));
    expect(r.decision).toBe('hold_for_approval');
    expect(r.requiresApproval).toBe(true);
    expect(r.reason).toMatch(/approval/i);
  });

  it('holds for approval on medium/high duplicate risk', () => {
    const r = decide(signals({ duplicate: { level: 'medium' } }), profile());
    expect(r.decision).toBe('hold_for_approval');
  });

  it('routes ambiguous matches to manual review', () => {
    const r = decide(signals({ library: { needed: true, owned: false, ambiguous: true } }), profile());
    expect(r.decision).toBe('manual_review');
    expect(r.requiresApproval).toBe(true);
  });

  it('skips a release that is neither wanted nor a gap', () => {
    const r = decide(signals({ watchlist: { matched: false }, library: { needed: false, owned: false } }), profile());
    expect(r.decision).toBe('skip');
  });

  it('skips when a required term is missing', () => {
    const r = decide(signals(), profile({ requiredTerms: ['PROPER'] }));
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/required term/i);
  });
});
