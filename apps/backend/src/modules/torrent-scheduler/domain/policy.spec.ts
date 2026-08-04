import {
  resolveEffectivePolicy,
  evaluateSeedTarget,
  type TorrentSchedulingPolicy,
  type SeedingPolicy,
} from './policy';

/**
 * Policy resolution and seed-target evaluation.
 *
 * Two contracts are load-bearing here and both are easy to get wrong:
 *
 *  - `undefined` inherits, `null` means explicitly unlimited and STOPS
 *    inheritance. Without the distinction, a library cannot lift a global cap.
 *  - An unknown fact is not zero. A provider that cannot report seed time makes
 *    a time-based target UNKNOWABLE, and the scheduler must decline to act
 *    rather than seed forever or stop early.
 */
const p = (over: Partial<TorrentSchedulingPolicy>): TorrentSchedulingPolicy => ({
  id: over.id ?? 'x', name: 'n', enabled: true,
  scope: { type: 'global', id: null }, ...over,
});

const CTX = {
  torrentHash: 'AABB', engineId: 'e1',
  libraryId: 'lib1', categoryId: 'cat1', rssRuleId: 'rule1',
};

describe('resolveEffectivePolicy', () => {
  it('falls back to the global policy', () => {
    const r = resolveEffectivePolicy([p({ id: 'g', maxConcurrentDownloads: 5 })], CTX);
    expect(r.maxConcurrentDownloads).toBe(5);
    expect(r.sources.maxConcurrentDownloads).toBe('g');
  });

  it('prefers the more specific scope, field by field', () => {
    // The engine policy sets only seeds; downloads must still come from global.
    const r = resolveEffectivePolicy([
      p({ id: 'g', maxConcurrentDownloads: 5, maxConcurrentSeeds: 10 }),
      p({ id: 'e', scope: { type: 'engine', id: 'e1' }, maxConcurrentSeeds: 3 }),
    ], CTX);
    expect(r.maxConcurrentDownloads).toBe(5);
    expect(r.maxConcurrentSeeds).toBe(3);
    expect(r.sources.maxConcurrentSeeds).toBe('e');
  });

  it('applies the documented precedence order', () => {
    const all = [
      p({ id: 'g', maxConcurrentDownloads: 1 }),
      p({ id: 'e', scope: { type: 'engine', id: 'e1' }, maxConcurrentDownloads: 2 }),
      p({ id: 'lib', scope: { type: 'library', id: 'lib1' }, maxConcurrentDownloads: 3 }),
      p({ id: 'cat', scope: { type: 'category', id: 'cat1' }, maxConcurrentDownloads: 4 }),
      p({ id: 'rule', scope: { type: 'rss_rule', id: 'rule1' }, maxConcurrentDownloads: 5 }),
      p({ id: 'tor', scope: { type: 'torrent', id: 'aabb' }, maxConcurrentDownloads: 6 }),
    ];
    expect(resolveEffectivePolicy(all, CTX).maxConcurrentDownloads).toBe(6);
    // Remove the torrent scope and the next one down wins, and so on.
    expect(resolveEffectivePolicy(all.slice(0, 5), CTX).maxConcurrentDownloads).toBe(5);
    expect(resolveEffectivePolicy(all.slice(0, 4), CTX).maxConcurrentDownloads).toBe(4);
    expect(resolveEffectivePolicy(all.slice(0, 3), CTX).maxConcurrentDownloads).toBe(3);
    expect(resolveEffectivePolicy(all.slice(0, 2), CTX).maxConcurrentDownloads).toBe(2);
  });

  it('lets null mean unlimited and stop inheritance', () => {
    // The whole reason null is distinct from undefined: lifting a parent cap.
    const r = resolveEffectivePolicy([
      p({ id: 'g', maxConcurrentSeeds: 5 }),
      p({ id: 'lib', scope: { type: 'library', id: 'lib1' }, maxConcurrentSeeds: null }),
    ], CTX);
    expect(r.maxConcurrentSeeds).toBeNull();
    expect(r.sources.maxConcurrentSeeds).toBe('lib');
  });

  it('ignores a disabled policy entirely', () => {
    const r = resolveEffectivePolicy([
      p({ id: 'g', maxConcurrentDownloads: 5 }),
      p({ id: 'off', scope: { type: 'torrent', id: 'aabb' }, enabled: false, maxConcurrentDownloads: 99 }),
    ], CTX);
    expect(r.maxConcurrentDownloads).toBe(5);
  });

  it('matches a torrent scope case-insensitively', () => {
    const r = resolveEffectivePolicy(
      [p({ id: 't', scope: { type: 'torrent', id: 'AaBb' }, maxTotalActive: 7 })], CTX,
    );
    expect(r.maxTotalActive).toBe(7);
  });

  it('does not apply a scope the torrent does not belong to', () => {
    const r = resolveEffectivePolicy([
      p({ id: 'other', scope: { type: 'library', id: 'SOMEONE-ELSE' }, maxConcurrentDownloads: 99 }),
    ], CTX);
    expect(r.maxConcurrentDownloads).toBeNull();
  });

  it('is deterministic for two policies at the same scope', () => {
    const a = p({ id: 'first', scope: { type: 'engine', id: 'e1' }, maxTotalActive: 1 });
    const b = p({ id: 'second', scope: { type: 'engine', id: 'e1' }, maxTotalActive: 2 });
    expect(resolveEffectivePolicy([a, b], CTX).maxTotalActive).toBe(1);
    expect(resolveEffectivePolicy([b, a], CTX).maxTotalActive).toBe(2);
  });
});

describe('evaluateSeedTarget', () => {
  const seed = (o: Partial<SeedingPolicy>): SeedingPolicy => ({
    mode: 'ratio', afterTarget: 'pause', ...o,
  });

  it('meets a ratio target', () => {
    expect(evaluateSeedTarget(seed({ mode: 'ratio', targetRatio: 2 }), { ratio: 2.1 })).toBe('met');
    expect(evaluateSeedTarget(seed({ mode: 'ratio', targetRatio: 2 }), { ratio: 1.9 })).toBe('not_met');
  });

  it('meets a time target', () => {
    const pol = seed({ mode: 'time', targetSeedMinutes: 60 });
    expect(evaluateSeedTarget(pol, { seedMinutes: 61 })).toBe('met');
    expect(evaluateSeedTarget(pol, { seedMinutes: 59 })).toBe('not_met');
  });

  it('reports unknown when the fact is missing, never zero', () => {
    // Nothing in this repository tracks seed duration today. Treating the
    // absence as 0 would seed forever; treating it as met would stop early.
    expect(evaluateSeedTarget(seed({ mode: 'time', targetSeedMinutes: 60 }), {})).toBe('unknown');
    expect(evaluateSeedTarget(seed({ mode: 'ratio', targetRatio: 2 }), {})).toBe('unknown');
  });

  it('ratio_or_time succeeds on either arm', () => {
    const pol = seed({ mode: 'ratio_or_time', targetRatio: 2, targetSeedMinutes: 60 });
    expect(evaluateSeedTarget(pol, { ratio: 2.5, seedMinutes: 1 })).toBe('met');
    expect(evaluateSeedTarget(pol, { ratio: 0.1, seedMinutes: 90 })).toBe('met');
    expect(evaluateSeedTarget(pol, { ratio: 0.1, seedMinutes: 1 })).toBe('not_met');
  });

  it('ratio_or_time is unknown when the unmet arm is unknowable', () => {
    // Ratio is short and seed time cannot be read — the OR may already be
    // satisfied by the arm we cannot see, so stopping would be a guess.
    const pol = seed({ mode: 'ratio_or_time', targetRatio: 2, targetSeedMinutes: 60 });
    expect(evaluateSeedTarget(pol, { ratio: 0.1 })).toBe('unknown');
  });

  it('ratio_and_time requires both', () => {
    const pol = seed({ mode: 'ratio_and_time', targetRatio: 2, targetSeedMinutes: 60 });
    expect(evaluateSeedTarget(pol, { ratio: 2.5, seedMinutes: 90 })).toBe('met');
    expect(evaluateSeedTarget(pol, { ratio: 2.5, seedMinutes: 10 })).toBe('not_met');
    // One arm definitively short settles it without needing the other.
    expect(evaluateSeedTarget(pol, { ratio: 0.1 })).toBe('not_met');
  });

  it('honours minimum obligations before any target', () => {
    const pol = seed({ mode: 'ratio', targetRatio: 1, minimumSeedMinutes: 120 });
    // Ratio target met, but the tracker obligation is not.
    expect(evaluateSeedTarget(pol, { ratio: 5, seedMinutes: 10 })).toBe('not_met');
    expect(evaluateSeedTarget(pol, { ratio: 5, seedMinutes: 130 })).toBe('met');
    // Obligation unmeasurable → unknown, not "satisfied".
    expect(evaluateSeedTarget(pol, { ratio: 5 })).toBe('unknown');
  });

  it('never auto-completes manual or unlimited', () => {
    expect(evaluateSeedTarget(seed({ mode: 'manual' }), { ratio: 99, seedMinutes: 99999 })).toBe('not_met');
    expect(evaluateSeedTarget(seed({ mode: 'unlimited' }), { ratio: 99 })).toBe('not_met');
  });
});
