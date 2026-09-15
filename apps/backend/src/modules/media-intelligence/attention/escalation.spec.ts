import { evaluateDispositionRetention, evidenceFingerprint, isActiveAttention } from './escalation';

/**
 * The escalation and active-queue rules, tested as pure functions.
 *
 * Two failure modes are being guarded against, and they pull in opposite
 * directions. Silencing a finding that later became critical is dangerous.
 * Resurrecting a dismissed finding because a sweep touched a timestamp is
 * merely irritating — but it teaches operators to ignore the queue, which
 * ends up equally dangerous. Almost every case below pins one or the other.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z');

const input = (over: {
  prevSeverity?: string;
  currSeverity?: string;
  prevEvidence?: Record<string, unknown>;
  currEvidence?: Record<string, unknown>;
  resolvedAt?: Date | null;
  disposition?: 'unreviewed' | 'acknowledged' | 'snoozed' | 'dismissed';
} = {}) => ({
  previous: {
    severity: over.prevSeverity ?? 'warning',
    evidence: over.prevEvidence ?? { missing: 1 },
    resolvedAt: over.resolvedAt ?? null,
  },
  current: {
    severity: over.currSeverity ?? 'warning',
    evidence: over.currEvidence ?? { missing: 1 },
  },
  disposition: over.disposition ?? ('dismissed' as const),
});

describe('evaluateDispositionRetention', () => {
  it('keeps a disposition when nothing changed', () => {
    expect(evaluateDispositionRetention(input()).result).toBe('keep_disposition');
  });

  it('ignores a pure re-observation', () => {
    // The sweep runs every six hours and touches everything. If a refreshed
    // timestamp cleared dispositions, nothing could ever stay dismissed.
    const r = evaluateDispositionRetention(
      input({
        prevEvidence: { missing: 3, observedAt: '2026-09-01T00:00:00Z' },
        currEvidence: { missing: 3, observedAt: '2026-09-15T00:00:00Z' },
      }),
    );
    expect(r.result).toBe('keep_disposition');
  });

  it('clears the disposition when severity increases', () => {
    const r = evaluateDispositionRetention(input({ prevSeverity: 'warning', currSeverity: 'critical' }));
    expect(r).toEqual({ result: 'reset_to_unreviewed', reason: 'severity_increased' });
  });

  it('keeps the disposition when severity DECREASES', () => {
    // They already decided about a worse version of this.
    const r = evaluateDispositionRetention(input({ prevSeverity: 'critical', currSeverity: 'warning' }));
    expect(r.result).toBe('keep_disposition');
  });

  it('clears the disposition when the affected count grows materially', () => {
    const r = evaluateDispositionRetention(
      input({ prevEvidence: { missing: 1 }, currEvidence: { missing: 12 } }),
    );
    expect(r).toEqual({ result: 'reset_to_unreviewed', reason: 'affected_count_increased' });
  });

  it('keeps the disposition for a small increase', () => {
    // One more missing episode of an airing series is the same problem.
    const r = evaluateDispositionRetention(
      input({ prevEvidence: { missing: 1 }, currEvidence: { missing: 2 } }),
    );
    expect(r.result).toBe('keep_disposition');
  });

  it('keeps the disposition when the count goes down', () => {
    const r = evaluateDispositionRetention(
      input({ prevEvidence: { missing: 12 }, currEvidence: { missing: 3 } }),
    );
    expect(r.result).toBe('keep_disposition');
  });

  it('clears the disposition when a resolved finding reopens', () => {
    // A recurrence is a new occurrence, whatever was decided about the old one.
    const r = evaluateDispositionRetention(input({ resolvedAt: new Date('2026-08-01') }));
    expect(r).toEqual({ result: 'reset_to_unreviewed', reason: 'reopened_after_resolution' });
  });

  it('clears the disposition when evidence changes in a way it has no rule for', () => {
    const r = evaluateDispositionRetention(
      input({
        prevEvidence: { requiredResolution: '1080p' },
        currEvidence: { requiredResolution: '2160p' },
      }),
    );
    expect(r).toEqual({ result: 'reset_to_unreviewed', reason: 'evidence_changed' });
  });

  it('never "resets" something nobody had dispositioned', () => {
    const r = evaluateDispositionRetention(
      input({ disposition: 'unreviewed', currSeverity: 'critical' }),
    );
    expect(r.result).toBe('keep_disposition');
  });

  it('does not treat a changed measuredFileCount as escalation', () => {
    // Probing more files moves a denominator; the problem did not worsen.
    // If this cleared dispositions, every pass of the probe backfill would
    // re-nag the operator about findings they already decided on.
    const r = evaluateDispositionRetention(
      input({
        prevEvidence: { missing: 3, measuredFileCount: 10 },
        currEvidence: { missing: 3, measuredFileCount: 52 },
      }),
    );
    expect(r.result).toBe('keep_disposition');
  });

  it('keeps the disposition when the count improves and other context shifts', () => {
    const r = evaluateDispositionRetention(
      input({
        prevEvidence: { missing: 12, measuredFileCount: 40 },
        currEvidence: { missing: 3, measuredFileCount: 52 },
      }),
    );
    expect(r.result).toBe('keep_disposition');
  });
});

describe('evidenceFingerprint', () => {
  it('is independent of property order', () => {
    expect(evidenceFingerprint({ a: 1, b: 2 })).toBe(evidenceFingerprint({ b: 2, a: 1 }));
  });

  it('ignores volatile timestamps', () => {
    expect(evidenceFingerprint({ missing: 3, observedAt: 'x' })).toBe(
      evidenceFingerprint({ missing: 3, observedAt: 'y' }),
    );
  });

  it('distinguishes a real change', () => {
    expect(evidenceFingerprint({ missing: 3 })).not.toBe(evidenceFingerprint({ missing: 4 }));
  });

  it('survives an empty object', () => {
    expect(evidenceFingerprint({})).toBe('');
  });
});

describe('isActiveAttention — one definition shared by list and counters', () => {
  const f = (over: Partial<{ resolvedAt: Date | null; disposition: string; snoozedUntil: Date | null }> = {}) => ({
    resolvedAt: over.resolvedAt ?? null,
    disposition: over.disposition ?? 'unreviewed',
    snoozedUntil: over.snoozedUntil ?? null,
  });

  it('includes an open, unreviewed finding', () => {
    expect(isActiveAttention(f(), NOW)).toBe(true);
  });

  it('includes an acknowledged finding — seeing is not deciding', () => {
    expect(isActiveAttention(f({ disposition: 'acknowledged' }), NOW)).toBe(true);
  });

  it('excludes a resolved finding', () => {
    expect(isActiveAttention(f({ resolvedAt: new Date('2026-09-01') }), NOW)).toBe(false);
  });

  it('excludes a dismissed finding that is still technically true', () => {
    expect(isActiveAttention(f({ disposition: 'dismissed' }), NOW)).toBe(false);
  });

  it('excludes a finding whose snooze has not expired', () => {
    const until = new Date(NOW.getTime() + 86_400_000);
    expect(isActiveAttention(f({ disposition: 'snoozed', snoozedUntil: until }), NOW)).toBe(false);
  });

  it('includes a finding whose snooze HAS expired, with no job to flip it', () => {
    const until = new Date(NOW.getTime() - 1000);
    expect(isActiveAttention(f({ disposition: 'snoozed', snoozedUntil: until }), NOW)).toBe(true);
  });

  it('excludes a snooze with no expiry rather than guessing', () => {
    expect(isActiveAttention(f({ disposition: 'snoozed', snoozedUntil: null }), NOW)).toBe(false);
  });

  it('keeps a dismissed finding out even after a long time', () => {
    const later = new Date('2027-01-01T00:00:00.000Z');
    expect(isActiveAttention(f({ disposition: 'dismissed' }), later)).toBe(false);
  });
});
