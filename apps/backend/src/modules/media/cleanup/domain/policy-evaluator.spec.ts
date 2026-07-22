import { evaluatePolicy, describeConditions, type EvaluationFacts } from './policy-evaluator';
import type { PolicyConditionNode } from './policy-document';

const leaf = (field: string, operator: string, value: unknown, allowInferred?: boolean): PolicyConditionNode =>
  ({ type: 'condition', field, operator, value, ...(allowInferred ? { allowInferred } : {}) });

const facts = (over: Partial<EvaluationFacts> = {}): EvaluationFacts => ({
  metadata: { releaseYear: 1998, mediaKind: 'movie' },
  playback: { completedPlayCount: 0, neverWatched: true, maximumProgressPercent: 0 },
  technical: { techSource: 'probe', resolutionOrdinal: 3, videoBitDepth: 8, width: 1280, height: 720 },
  storage: { fileSizeBytes: 6_442_450_944 },
  safety: { isLocked: false, isProtected: false },
  ...over,
});

describe('leaf evaluation', () => {
  it('matches a satisfied condition', () => {
    const r = evaluatePolicy(leaf('metadata.releaseYear', 'lt', 2001), facts());
    expect(r.outcome).toBe('matched');
    expect(r.matchedConditions).toEqual(['metadata.releaseYear < 2001']);
  });

  it('does not match an unsatisfied condition', () => {
    const r = evaluatePolicy(leaf('metadata.releaseYear', 'gt', 2020), facts());
    expect(r.outcome).toBe('not_matched');
    expect(r.matchedConditions).toEqual([]);
  });

  it('reuses the shared operator semantics (eq is strict)', () => {
    expect(evaluatePolicy(leaf('metadata.releaseYear', 'eq', 1998), facts()).outcome).toBe('matched');
    expect(evaluatePolicy(leaf('metadata.releaseYear', 'eq', '1998'), facts()).outcome).toBe('not_matched');
  });
});

describe('the unmeasured outcome — the safety-critical case', () => {
  // A probe-only condition on unprobed data must NOT evaluate to false. Falling
  // through as "does not qualify" would be merely wrong; falling through as
  // "qualifies" would delete on a guess.
  it('a measured-only condition on filename-derived data is unmeasured', () => {
    const f = facts({ technical: { techSource: 'filename', videoBitDepth: 10 } });
    const r = evaluatePolicy(leaf('technical.videoBitDepth', 'eq', 10), f);
    expect(r.outcome).toBe('unmeasured');
    expect(r.unmeasuredConditions).toContain('technical.videoBitDepth');
  });

  it('the same condition evaluates once the data is probe-measured', () => {
    const f = facts({ technical: { techSource: 'probe', videoBitDepth: 10 } });
    expect(evaluatePolicy(leaf('technical.videoBitDepth', 'eq', 10), f).outcome).toBe('matched');
  });

  it('a policy may explicitly opt into inferred values', () => {
    const f = facts({ technical: { techSource: 'filename', videoBitDepth: 10 } });
    expect(evaluatePolicy(leaf('technical.videoBitDepth', 'eq', 10, true), f).outcome).toBe('matched');
  });

  it('an absent fact is unmeasured, never false', () => {
    const f = facts({ playback: {} });
    const r = evaluatePolicy(leaf('playback.completedPlayCount', 'lt', 100), f);
    expect(r.outcome).toBe('unmeasured');
  });

  it('an unknown condition id is unmeasured, never a silent false', () => {
    const r = evaluatePolicy(leaf('metadata.doesNotExist', 'eq', 1), facts());
    expect(r.outcome).toBe('unmeasured');
  });
});

describe('nested ALL / ANY', () => {
  const allOldUnwatchedLowRes: PolicyConditionNode = {
    type: 'all',
    children: [
      leaf('metadata.releaseYear', 'lt', 2001),
      leaf('playback.completedPlayCount', 'eq', 0),
      leaf('technical.resolutionClass', 'lt', 4), // ordinal 4 = 1080p
    ],
  };

  it('ALL matches when every child matches', () => {
    const r = evaluatePolicy(allOldUnwatchedLowRes, facts());
    expect(r.outcome).toBe('matched');
    expect(r.matchedConditions).toHaveLength(3);
  });

  it('ALL fails on one definite false', () => {
    const f = facts({ metadata: { releaseYear: 2015 } });
    expect(evaluatePolicy(allOldUnwatchedLowRes, f).outcome).toBe('not_matched');
  });

  // A definite false settles an ALL even with an unmeasured sibling — the policy
  // genuinely does not apply, which is a safe and honest answer.
  it('a definite false beats an unmeasured sibling in ALL', () => {
    const f = facts({ metadata: { releaseYear: 2015 }, technical: { techSource: 'filename' } });
    expect(evaluatePolicy(allOldUnwatchedLowRes, f).outcome).toBe('not_matched');
  });

  it('ALL is unmeasured when otherwise-matching but a child is unmeasurable', () => {
    const f = facts({ technical: { techSource: 'filename', resolutionOrdinal: 3 } });
    expect(evaluatePolicy(allOldUnwatchedLowRes, f).outcome).toBe('unmeasured');
  });

  const anyGroup: PolicyConditionNode = {
    type: 'any',
    children: [
      leaf('metadata.releaseYear', 'lt', 1950),
      leaf('playback.completedPlayCount', 'eq', 0),
    ],
  };

  it('ANY matches when one child matches', () => {
    expect(evaluatePolicy(anyGroup, facts()).outcome).toBe('matched');
  });

  it('ANY is unmeasured when nothing matched and something was unmeasurable', () => {
    const f = facts({ metadata: { releaseYear: 2015 }, playback: {} });
    expect(evaluatePolicy(anyGroup, f).outcome).toBe('unmeasured');
  });

  it('ANY is not_matched only when every child definitively failed', () => {
    const f = facts({ metadata: { releaseYear: 2015 }, playback: { completedPlayCount: 5 } });
    expect(evaluatePolicy(anyGroup, f).outcome).toBe('not_matched');
  });

  // The brief's worked example: (old AND unwatched AND low-res) OR (few plays AND 10-bit)
  it('evaluates the brief\'s nested example', () => {
    const tree: PolicyConditionNode = {
      type: 'any',
      children: [
        allOldUnwatchedLowRes,
        { type: 'all', children: [leaf('playback.completedPlayCount', 'lt', 100), leaf('technical.videoBitDepth', 'eq', 10)] },
      ],
    };
    expect(evaluatePolicy(tree, facts()).outcome).toBe('matched');
    const tenBit = facts({
      metadata: { releaseYear: 2020 },
      playback: { completedPlayCount: 5 },
      technical: { techSource: 'probe', videoBitDepth: 10, resolutionOrdinal: 4 },
    });
    expect(evaluatePolicy(tree, tenBit).outcome).toBe('matched');
  });
});

describe('describeConditions', () => {
  it('renders a readable summary with grouping', () => {
    const tree: PolicyConditionNode = {
      type: 'any',
      children: [
        { type: 'all', children: [leaf('metadata.releaseYear', 'lt', 2001), leaf('playback.completedPlayCount', 'eq', 0)] },
        leaf('technical.videoBitDepth', 'eq', 10),
      ],
    };
    expect(describeConditions(tree)).toBe(
      '(metadata.releaseYear < 2001 AND playback.completedPlayCount = 0) OR technical.videoBitDepth = 10',
    );
  });
});
