import { describe, expect, it } from 'vitest';
import {
  ageClaimedByConditions,
  conditionFieldsUsed,
  factsClaimedByTargets,
  ratioClaimedByConditions,
} from './seed-condition-exclusion';
import type { ConditionGroup } from '@/components/conditions/ConditionBuilder';

/**
 * The seeding panel can say the same thing twice: a ratio TARGET ("seed until
 * 2.0") and a ratio CONDITION ("only torrents already past 2.0"). They read as
 * alternatives and combine as an AND, so a policy holding both fires only when
 * both are true — which is what neither looks like. Whichever side is filled
 * first claims the fact and the other withdraws it, in EITHER order.
 */
const doc = (...fields: string[]): ConditionGroup => ({
  type: 'all',
  children: fields.map((field) => ({ type: 'condition', field, operator: 'gte', value: 1 })),
});
const targets = (over: Partial<Parameters<typeof factsClaimedByTargets>[0]> = {}) =>
  factsClaimedByTargets({ seedMode: 'unlimited', targetRatio: '', ageLimitOn: false, maxAgeDays: '', ...over });

describe('conditions claiming a fact', () => {
  it('withdraws the ratio target once a ratio condition exists', () => {
    expect(ratioClaimedByConditions(doc('seed.ratio'))).toBe(true);
    expect(ratioClaimedByConditions(doc('seed.isPrivate'))).toBe(false);
    expect(ratioClaimedByConditions(null)).toBe(false);
  });

  it('withdraws the age deadline once an age condition exists', () => {
    expect(ageClaimedByConditions(doc('seed.ageDays'))).toBe(true);
    expect(ageClaimedByConditions(doc('seed.ratio'))).toBe(false);
  });

  it('sees a condition nested inside a group', () => {
    const nested: ConditionGroup = {
      type: 'all',
      children: [{ type: 'any', children: [{ type: 'condition', field: 'seed.ratio', operator: 'gte', value: 2 }] }],
    };
    expect(ratioClaimedByConditions(nested)).toBe(true);
    expect([...conditionFieldsUsed(nested)]).toEqual(['seed.ratio']);
  });
});

describe('targets claiming a fact', () => {
  it('claims the ratio only when the mode is ratio AND a value is set', () => {
    expect(targets({ seedMode: 'ratio', targetRatio: '2' }).has('seed.ratio')).toBe(true);
    // An empty box is not a statement about anything — the operator has not
    // chosen yet, so the condition must stay on offer.
    expect(targets({ seedMode: 'ratio', targetRatio: '' }).has('seed.ratio')).toBe(false);
    expect(targets({ seedMode: 'ratio', targetRatio: '0' }).has('seed.ratio')).toBe(false);
    expect(targets({ seedMode: 'unlimited', targetRatio: '2' }).has('seed.ratio')).toBe(false);
  });

  it('claims the age only when the switch is on AND a value is set', () => {
    expect(targets({ ageLimitOn: true, maxAgeDays: '30' }).has('seed.ageDays')).toBe(true);
    expect(targets({ ageLimitOn: false, maxAgeDays: '30' }).has('seed.ageDays')).toBe(false);
    expect(targets({ ageLimitOn: true, maxAgeDays: '' }).has('seed.ageDays')).toBe(false);
  });

  it('claims each fact independently', () => {
    const claimed = targets({ seedMode: 'ratio', targetRatio: '2', ageLimitOn: true, maxAgeDays: '30' });
    expect([...claimed].sort()).toEqual(['seed.ageDays', 'seed.ratio']);
  });
});

describe('the two directions cannot both be open', () => {
  it('never lets one fact be claimable from both sides at once', () => {
    // Whichever side is filled, the other reports the fact as taken.
    const fromTarget = targets({ seedMode: 'ratio', targetRatio: '2' });
    expect(fromTarget.has('seed.ratio')).toBe(true);
    expect(ratioClaimedByConditions(null)).toBe(false);

    const fromCondition = ratioClaimedByConditions(doc('seed.ratio'));
    expect(fromCondition).toBe(true);
    expect(targets().has('seed.ratio')).toBe(false);
  });
});
