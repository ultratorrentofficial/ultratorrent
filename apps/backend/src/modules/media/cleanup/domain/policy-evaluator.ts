import { applyOperator, resolvePath } from '../../../workflows/domain/condition-eval';
import { getCondition } from './condition-catalog';
import { isGroup, type PolicyConditionNode } from './policy-document';

/**
 * Policy evaluation over nested ALL/ANY groups.
 *
 * The operators come from the Workflow Builder's constrained evaluator — the same
 * eight the Automation Engine uses — so a cleanup policy branches exactly like a
 * rule does, and there is no second expression language and nothing to eval.
 *
 * The critical departure from ordinary boolean logic is UNMEASURED. A condition
 * that demands probe-measured data and does not get it does not evaluate to false;
 * it makes the whole evaluation UNMEASURED, and the caller excludes the candidate
 * (`excluded_unmeasured`) rather than matching or dismissing it. "We could not
 * measure this" must never be silently read as "this does not qualify" — or, far
 * worse, as "this qualifies".
 */

export type EvaluationOutcome = 'matched' | 'not_matched' | 'unmeasured';

export interface ConditionTrace {
  field: string;
  operator: string;
  value: unknown;
  actual: unknown;
  result: boolean | 'unmeasured';
  /** Rendered for the candidate's reason snapshot, e.g. "releaseYear < 2001". */
  summary: string;
}

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  /** Conditions that contributed to a match — what the UI shows as "why". */
  matchedConditions: string[];
  /** Conditions that could not be evaluated for want of measured data. */
  unmeasuredConditions: string[];
  traces: ConditionTrace[];
}

/** The facts a candidate presents. Shape mirrors `factPath` in the catalogue. */
export interface EvaluationFacts {
  metadata?: Record<string, unknown>;
  playback?: Record<string, unknown>;
  technical?: Record<string, unknown> & { techSource?: string | null };
  storage?: Record<string, unknown>;
  safety?: Record<string, unknown>;
}

function summarize(field: string, operator: string, value: unknown): string {
  const op = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }[operator] ?? operator;
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  return `${field} ${op} ${v}`;
}

/** Was this fact actually measured, or is it a filename guess / absent? */
function isMeasured(facts: EvaluationFacts): boolean {
  return facts.technical?.techSource === 'probe';
}

function evaluateLeaf(
  node: Extract<PolicyConditionNode, { type: 'condition' }>,
  facts: EvaluationFacts,
): ConditionTrace {
  const def = getCondition(node.field);
  const summary = summarize(node.field, node.operator, node.value);

  // An unknown condition id cannot be evaluated. Validation rejects these before
  // publish, so reaching here means the catalogue changed under a published
  // version — fail to `unmeasured`, never to a silent false.
  if (!def) {
    return { field: node.field, operator: node.operator, value: node.value, actual: undefined, result: 'unmeasured', summary };
  }

  const actual = resolvePath(facts, def.factPath);

  // Measured-data discipline: a probe-only condition on unprobed data is unmeasured,
  // unless the policy explicitly opted into inferred values.
  if (def.requiresMeasuredData && !node.allowInferred && !isMeasured(facts)) {
    return { field: node.field, operator: node.operator, value: node.value, actual, result: 'unmeasured', summary };
  }
  // A fact that simply is not there is also not a basis for deletion.
  if (actual === undefined || actual === null) {
    return { field: node.field, operator: node.operator, value: node.value, actual, result: 'unmeasured', summary };
  }

  return {
    field: node.field,
    operator: node.operator,
    value: node.value,
    actual,
    result: applyOperator(node.operator, actual, node.value),
    summary,
  };
}

function walk(node: PolicyConditionNode, facts: EvaluationFacts, acc: ConditionTrace[]): EvaluationOutcome {
  if (!isGroup(node)) {
    const trace = evaluateLeaf(node, facts);
    acc.push(trace);
    if (trace.result === 'unmeasured') return 'unmeasured';
    return trace.result ? 'matched' : 'not_matched';
  }

  const results = node.children.map((c) => walk(c, facts, acc));

  if (node.type === 'all') {
    // A definite false settles an ALL regardless of anything unmeasured beside it:
    // the policy does not apply, which is a safe and honest answer.
    if (results.includes('not_matched')) return 'not_matched';
    if (results.includes('unmeasured')) return 'unmeasured';
    return 'matched';
  }

  // ANY: a definite true settles it. Otherwise an unmeasured branch means we cannot
  // claim the group is false — the candidate is excluded rather than dismissed.
  if (results.includes('matched')) return 'matched';
  if (results.includes('unmeasured')) return 'unmeasured';
  return 'not_matched';
}

export function evaluatePolicy(conditions: PolicyConditionNode, facts: EvaluationFacts): EvaluationResult {
  const traces: ConditionTrace[] = [];
  const outcome = walk(conditions, facts, traces);
  return {
    outcome,
    matchedConditions: traces.filter((t) => t.result === true).map((t) => t.summary),
    unmeasuredConditions: traces.filter((t) => t.result === 'unmeasured').map((t) => t.field),
    traces,
  };
}

/** A readable one-line rendering of a condition tree, for the UI and audit. */
export function describeConditions(node: PolicyConditionNode): string {
  if (!isGroup(node)) return summarize(node.field, node.operator, node.value);
  const joiner = node.type === 'all' ? ' AND ' : ' OR ';
  const parts = node.children.map((c) => (isGroup(c) ? `(${describeConditions(c)})` : describeConditions(c)));
  return parts.join(joiner);
}
