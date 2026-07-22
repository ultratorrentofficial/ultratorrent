import { CLEANUP_POLICY_TEMPLATES, getTemplate } from './policy-templates';
import { validatePolicyDocument } from './policy-validator';
import { evaluatePolicy, describeConditions, type EvaluationFacts } from './policy-evaluator';

describe('shipped templates', () => {
  // A template that would be refused at publish is a trap: the operator finds out
  // only after building on it.
  it.each(CLEANUP_POLICY_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s is a valid, publishable policy',
    (_key, t) => {
      const r = validatePolicyDocument(t.document);
      expect(r.errors).toEqual([]);
      expect(r.valid).toBe(true);
    },
  );

  it('has unique keys', () => {
    const keys = CLEANUP_POLICY_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Nothing shipped may delete unattended. Every template is report-only or
  // approval-required; none is auto_trash/auto_quarantine.
  it('ships nothing that deletes without a human', () => {
    for (const t of CLEANUP_POLICY_TEMPLATES) {
      expect(['report_only', 'approval_required']).toContain(t.document.action.mode);
    }
  });

  it('never ships permanent deletion as a destination', () => {
    for (const t of CLEANUP_POLICY_TEMPLATES) {
      expect(['trash', 'quarantine']).toContain(t.document.action.destination);
    }
  });

  it('every template keeps the mandatory exclusions and a grace period', () => {
    for (const t of CLEANUP_POLICY_TEMPLATES) {
      const ex = t.document.exclusions;
      expect(ex.protected).toBe(true);
      expect(ex.locked).toBe(true);
      expect(ex.activePlayback).toBe(true);
      expect(ex.addedWithinDays ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('the 10-bit template is report-only on purpose', () => {
  // 10-bit is usually the BETTER encode. A template that trashed it by default
  // would be actively harmful.
  it('does not act on its findings', () => {
    const t = getTemplate('low_use_10bit_media')!;
    expect(t.document.action.mode).toBe('report_only');
  });

  it('the destructive variant requires a verified replacement instead', () => {
    const t = getTemplate('superseded_8bit_h264_with_replacement')!;
    expect(t.document.replacement?.required).toBe(true);
    expect(t.document.replacement?.minResolutionClass).toBe('1080p');
    expect(t.document.action.mode).toBe('approval_required');
  });
});

describe('templates actually evaluate', () => {
  const oldUnwatched720p: EvaluationFacts = {
    metadata: { releaseYear: 1998 },
    playback: { completedPlayCount: 0 },
    technical: { techSource: 'probe', resolutionOrdinal: 3 }, // 720p
  };

  it('the old-unwatched-low-res template matches a 1998 unwatched 720p file', () => {
    const t = getTemplate('old_unwatched_low_resolution_movies')!;
    expect(evaluatePolicy(t.document.conditions, oldUnwatched720p).outcome).toBe('matched');
  });

  // The scope encode that must NOT be treated as sub-1080p.
  it('does not match a 1920x800 scope encode (ordinal 4 = 1080p)', () => {
    const t = getTemplate('old_unwatched_low_resolution_movies')!;
    const scope1080: EvaluationFacts = {
      ...oldUnwatched720p,
      technical: { techSource: 'probe', resolutionOrdinal: 4 },
    };
    expect(evaluatePolicy(t.document.conditions, scope1080).outcome).toBe('not_matched');
  });

  it('is unmeasured — not matched — when the file was never probed', () => {
    const t = getTemplate('old_unwatched_low_resolution_movies')!;
    const unprobed: EvaluationFacts = {
      ...oldUnwatched720p,
      technical: { techSource: 'filename', resolutionOrdinal: 3 },
    };
    expect(evaluatePolicy(t.document.conditions, unprobed).outcome).toBe('unmeasured');
  });

  it('renders a readable summary', () => {
    const t = getTemplate('old_unwatched_low_resolution_movies')!;
    expect(describeConditions(t.document.conditions)).toBe(
      'metadata.releaseYear < 2001 AND playback.completedPlayCount = 0 AND technical.resolutionClass < 1080p',
    );
  });
});
