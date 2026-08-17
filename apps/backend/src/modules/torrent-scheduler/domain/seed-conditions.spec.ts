import {
  evaluateSeedConditions,
  seedConditionById,
  SEED_CONDITIONS,
  type SeedConditionNode,
} from './seed-conditions';

/**
 * The seeding rules could say WHEN to act but never WHICH torrents to act on —
 * that was scope alone, so "stop big public-tracker films at ratio 1 but keep
 * small private TV to 5" could not be written at all.
 *
 * The discipline these pin down is that **unknown is not false**. A gap in what
 * the engine reported must block the action, not quietly satisfy it: acting on
 * a torrent the rule was never shown to cover is how a seed gets killed by a
 * policy that did not mean it.
 */
const leaf = (field: string, operator: string, value: unknown): SeedConditionNode =>
  ({ type: 'condition', field, operator, value });

describe('evaluateSeedConditions', () => {
  it('matches everything when no document is set', () => {
    // The behaviour before conditions existed; adding the feature must not
    // change what an existing policy does.
    expect(evaluateSeedConditions(null, {})).toBe('met');
    expect(evaluateSeedConditions(undefined, { ratio: 1 })).toBe('met');
    expect(evaluateSeedConditions({ type: 'all', children: [] }, {})).toBe('met');
  });

  it('compares numbers with the ordering operators', () => {
    expect(evaluateSeedConditions(leaf('seed.ratio', 'gte', 2), { ratio: 2 })).toBe('met');
    expect(evaluateSeedConditions(leaf('seed.ratio', 'gte', 2), { ratio: 1.9 })).toBe('not_met');
    expect(evaluateSeedConditions(leaf('seed.ageDays', 'gt', 30), { ageDays: 31 })).toBe('met');
    expect(evaluateSeedConditions(leaf('seed.sizeBytes', 'lt', 1_000), { sizeBytes: 999 })).toBe('met');
  });

  it('answers unknown for a fact the engine did not report', () => {
    // NOT not_met: we were never shown whether this torrent matches.
    expect(evaluateSeedConditions(leaf('seed.ratio', 'gte', 2), {})).toBe('unknown');
    expect(evaluateSeedConditions(leaf('seed.seedMinutes', 'gt', 60), {})).toBe('unknown');
  });

  it('treats a false child as decisive but an unknown one as undecided in ALL', () => {
    const doc = (children: SeedConditionNode[]): SeedConditionNode => ({ type: 'all', children });

    // One false settles it, even alongside an unmeasured sibling.
    expect(evaluateSeedConditions(
      doc([leaf('seed.ratio', 'gte', 2), leaf('seed.sizeBytes', 'gt', 10)]),
      { ratio: 1 },
    )).toBe('not_met');

    // Nothing false, something unmeasured → undecided, so the action is blocked.
    expect(evaluateSeedConditions(
      doc([leaf('seed.ratio', 'gte', 2), leaf('seed.sizeBytes', 'gt', 10)]),
      { ratio: 3 },
    )).toBe('unknown');

    expect(evaluateSeedConditions(
      doc([leaf('seed.ratio', 'gte', 2), leaf('seed.sizeBytes', 'gt', 10)]),
      { ratio: 3, sizeBytes: 20 },
    )).toBe('met');
  });

  it('mirrors that logic in ANY', () => {
    const doc = (children: SeedConditionNode[]): SeedConditionNode => ({ type: 'any', children });

    // One true settles it regardless of an unmeasured sibling.
    expect(evaluateSeedConditions(
      doc([leaf('seed.ratio', 'gte', 2), leaf('seed.sizeBytes', 'gt', 10)]),
      { ratio: 3 },
    )).toBe('met');

    // Nothing true, something unmeasured → undecided.
    expect(evaluateSeedConditions(
      doc([leaf('seed.ratio', 'gte', 2), leaf('seed.sizeBytes', 'gt', 10)]),
      { ratio: 1 },
    )).toBe('unknown');

    expect(evaluateSeedConditions(
      doc([leaf('seed.ratio', 'gte', 2), leaf('seed.sizeBytes', 'gt', 10)]),
      { ratio: 1, sizeBytes: 5 },
    )).toBe('not_met');
  });

  it('handles text and boolean facts', () => {
    expect(evaluateSeedConditions(leaf('seed.tracker', 'contains', 'YTS'), { tracker: 'tracker.yts.mx' })).toBe('met');
    expect(evaluateSeedConditions(leaf('seed.name', 'matches', '^S\\.W\\.A\\.T'), { name: 'S.W.A.T 2017 S08E20' })).toBe('met');
    expect(evaluateSeedConditions(leaf('seed.isPrivate', 'eq', true), { isPrivate: false })).toBe('not_met');
    expect(evaluateSeedConditions(leaf('seed.importCompleted', 'eq', true), { importCompleted: true })).toBe('met');
  });

  it('refuses an invalid regex rather than matching everything', () => {
    expect(evaluateSeedConditions(leaf('seed.name', 'matches', '('), { name: 'anything' })).toBe('unknown');
  });

  it('refuses a field it does not know', () => {
    // A policy naming a field that no longer exists must not start matching all.
    expect(evaluateSeedConditions(leaf('seed.removedField', 'eq', 1), { ratio: 5 })).toBe('unknown');
  });

  it('nests groups', () => {
    const doc: SeedConditionNode = {
      type: 'all',
      children: [
        leaf('seed.importCompleted', 'eq', true),
        { type: 'any', children: [leaf('seed.ratio', 'gte', 5), leaf('seed.ageDays', 'gte', 30)] },
      ],
    };
    expect(evaluateSeedConditions(doc, { importCompleted: true, ratio: 1, ageDays: 45 })).toBe('met');
    expect(evaluateSeedConditions(doc, { importCompleted: true, ratio: 1, ageDays: 2 })).toBe('not_met');
    expect(evaluateSeedConditions(doc, { importCompleted: false, ratio: 9, ageDays: 99 })).toBe('not_met');
  });
});

describe('the catalog', () => {
  it('has unique ids and a fact for every entry', () => {
    const ids = SEED_CONDITIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of SEED_CONDITIONS) {
      expect(c.operators.length).toBeGreaterThan(0);
      expect(seedConditionById(c.id)).toBe(c);
    }
  });

  it('offers a library picker rather than a UUID box', () => {
    // A mistyped id produces a policy that saves, validates and matches
    // nothing — silently, because "no such library" and "nothing matched" are
    // the same empty result.
    expect(seedConditionById('seed.libraryId')?.valueSource).toBe('library');
  });
});



import { evaluateSeedTarget } from './policy';

/**
 * The condition list IS the stop target.
 *
 * The fixed fields could only ever say one thing — a ratio, or a time, or a
 * deadline — so "stop at ratio 2 OR after 30 days, but never before the import
 * finished" was not expressible. A list says it directly, and `evaluateSeedTarget`
 * reads it in place of the fields when a policy has one.
 */
describe('a seeding policy whose target is a condition list', () => {
  const stopWhen = (node: unknown) =>
    ({ mode: 'ratio' as const, afterTarget: 'stop' as const, stopWhen: node as never });
  const cond = (field: string, operator: string, value: unknown) =>
    ({ type: 'condition' as const, field, operator, value });

  it('stops once any listed condition is met', () => {
    const policy = stopWhen({ type: 'any', children: [
      cond('seed.ratio', 'gte', 2),
      cond('seed.ageDays', 'gte', 30),
    ] });

    expect(evaluateSeedTarget(policy, { ratio: 2.1, ageDays: 3 })).toBe('met');
    expect(evaluateSeedTarget(policy, { ratio: 0.4, ageDays: 31 })).toBe('met');
    expect(evaluateSeedTarget(policy, { ratio: 0.4, ageDays: 3 })).toBe('not_met');
  });

  it('requires every condition when the list is ALL', () => {
    const policy = stopWhen({ type: 'all', children: [
      cond('seed.ratio', 'gte', 1),
      cond('seed.importCompleted', 'eq', true),
    ] });

    expect(evaluateSeedTarget(policy, { ratio: 2, importCompleted: true })).toBe('met');
    expect(evaluateSeedTarget(policy, { ratio: 2, importCompleted: false })).toBe('not_met');
  });

  it('does not stop on a fact the engine never reported', () => {
    // The discipline that keeps a policy from ending a seed it cannot judge.
    const policy = stopWhen({ type: 'all', children: [cond('seed.ratio', 'gte', 2)] });
    expect(evaluateSeedTarget(policy, {})).toBe('unknown');
  });

  it('ignores the legacy fields entirely once a list is present', () => {
    // Otherwise the same fact could be stated twice and silently ANDed — which
    // is exactly the shape this design replaced.
    const policy = {
      mode: 'ratio' as const, afterTarget: 'stop' as const,
      targetRatio: 99, minimumRatio: 50,
      stopWhen: { type: 'any' as const, children: [cond('seed.ratio', 'gte', 2)] } as never,
    };
    expect(evaluateSeedTarget(policy, { ratio: 2.5 })).toBe('met');
  });

  it('falls back to the fixed fields when no list is set', () => {
    // Every policy written before this keeps behaving exactly as it did.
    const legacy = { mode: 'ratio' as const, afterTarget: 'stop' as const, targetRatio: 5 };
    expect(evaluateSeedTarget(legacy, { ratio: 5 })).toBe('met');
    expect(evaluateSeedTarget(legacy, { ratio: 4.9 })).toBe('not_met');
  });
});
