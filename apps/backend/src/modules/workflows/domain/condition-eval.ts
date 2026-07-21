/**
 * The constrained condition evaluator — **mirrors the Automation Engine's operator
 * semantics exactly** (`applyOperator` in automation.module.ts): eq/neq are strict, the
 * numeric comparators coerce with Number(), contains is String.includes, matches is a
 * case-insensitive RegExp. NO eval / Function / arbitrary code (non-negotiable): a fixed
 * operator set over a resolved field path against a literal value. Used by the simulator
 * and (later) the durable executor so both branch identically to the rules engine.
 */

export type ConditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'matches';

export const CONDITION_OPERATORS: ConditionOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches'];

export interface WorkflowCondition {
  field: string; // dot path into the context, e.g. "torrent.ratio"
  op: ConditionOperator | string;
  value: unknown;
}

export function applyOperator(op: string, actual: unknown, value: unknown): boolean {
  switch (op) {
    case 'eq': return actual === value;
    case 'neq': return actual !== value;
    case 'gt': return Number(actual) > Number(value);
    case 'gte': return Number(actual) >= Number(value);
    case 'lt': return Number(actual) < Number(value);
    case 'lte': return Number(actual) <= Number(value);
    case 'contains': return String(actual).includes(String(value));
    case 'matches':
      try { return new RegExp(String(value), 'i').test(String(actual)); } catch { return false; }
    default: return false;
  }
}

/** Resolve a dot path (`a.b.c`) against a context object; undefined for a missing path. */
export function resolvePath(context: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = context;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function evaluateCondition(cond: WorkflowCondition, context: unknown): boolean {
  return applyOperator(cond.op, resolvePath(context, cond.field), cond.value);
}
