import type { ConditionGroup, ConditionNode } from '@/components/conditions/ConditionBuilder';

/**
 * One fact, one place — and whichever side is filled first claims it.
 *
 * The seeding panel can express the same fact twice: a ratio TARGET ("seed
 * until 2.0") and a ratio CONDITION ("only torrents already past 2.0"). They
 * read as alternatives but combine as an AND, so a policy carrying both fires
 * only when both hold — which is what neither of them looks like. The server
 * refuses the pairing; these keep an operator from ever composing it, in either
 * order, by withdrawing the option from whichever side is still free.
 *
 * Pure and separate from the form so the rule can be tested without rendering
 * it, and so both directions are described in one place rather than as two
 * conditionals that could drift apart.
 */

/** Condition ids paired with the target fields that state the same fact. */
export const EXCLUSIVE_SEED_FACTS: Record<string, 'ratio' | 'age'> = {
  'seed.ratio': 'ratio',
  'seed.ageDays': 'age',
};

/** Every condition id used anywhere in the document, including nested groups. */
export function conditionFieldsUsed(node: ConditionGroup | null | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (n: ConditionNode | null | undefined): void => {
    if (!n) return;
    if (n.type === 'condition') { out.add(n.field); return; }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

export interface SeedTargetState {
  seedMode: string;
  targetRatio: string;
  ageLimitOn: boolean;
  maxAgeDays: string;
}

/**
 * Condition ids the target fields have already claimed.
 *
 * A field only claims its fact once it holds a usable value: an empty ratio box
 * or an age switch left off is not a statement about anything, and hiding the
 * condition for it would take away a choice the operator has not made.
 */
export function factsClaimedByTargets(s: SeedTargetState): Set<string> {
  const claimed = new Set<string>();
  if (s.seedMode === 'ratio' && Number(s.targetRatio) > 0) claimed.add('seed.ratio');
  if (s.ageLimitOn && Number(s.maxAgeDays) > 0) claimed.add('seed.ageDays');
  return claimed;
}

/** Is the ratio target unavailable because a condition already states it? */
export function ratioClaimedByConditions(node: ConditionGroup | null | undefined): boolean {
  return conditionFieldsUsed(node).has('seed.ratio');
}

/** Is the age deadline unavailable because a condition already states it? */
export function ageClaimedByConditions(node: ConditionGroup | null | undefined): boolean {
  return conditionFieldsUsed(node).has('seed.ageDays');
}
