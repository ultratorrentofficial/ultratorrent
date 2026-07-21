import { applyOperator, evaluateCondition, resolvePath } from './condition-eval';

describe('condition-eval (mirrors automation operator semantics)', () => {
  it('eq/neq are strict', () => {
    expect(applyOperator('eq', 2, 2)).toBe(true);
    expect(applyOperator('eq', 2, '2')).toBe(false);
    expect(applyOperator('neq', 2, '2')).toBe(true);
  });

  it('numeric comparators coerce with Number()', () => {
    expect(applyOperator('gt', '3', 2)).toBe(true);
    expect(applyOperator('gte', 2, '2')).toBe(true);
    expect(applyOperator('lt', 1, 2)).toBe(true);
    expect(applyOperator('lte', '2', 2)).toBe(true);
  });

  it('contains uses String.includes; matches is case-insensitive regex', () => {
    expect(applyOperator('contains', 'hello world', 'wor')).toBe(true);
    expect(applyOperator('matches', 'The.MKV', 'mkv')).toBe(true);
    expect(applyOperator('matches', 'x', '(')).toBe(false); // invalid regex → false, never throws
  });

  it('unknown operator is false', () => {
    expect(applyOperator('between', 1, 2)).toBe(false);
  });

  it('resolvePath walks dot paths and returns undefined for gaps', () => {
    expect(resolvePath({ a: { b: 5 } }, 'a.b')).toBe(5);
    expect(resolvePath({ a: {} }, 'a.b.c')).toBeUndefined();
    expect(evaluateCondition({ field: 'a.b', op: 'gte', value: 3 }, { a: { b: 5 } })).toBe(true);
  });
});
